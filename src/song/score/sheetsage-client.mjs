// src/song/score/sheetsage-client.mjs
// Transcribe an existing recording to an ABC score via SheetSage2.
//
// This is the mirror image of yue2-client.mjs: YuE2 invents a score from
// lyrics, SheetSage2 listens to audio and writes one down. Both produce the
// same artifact — score.abc — so everything downstream is unchanged.
//
// Server notes (learned the hard way):
//   * SheetSage2 must run in a process whose backend is cpu. audio.cpp
//     ignores the per-model "backend" key, so a server with a global vulkan
//     backend dies with "encoder backend buffer allocation failed" on AMD.
//     Hence a separate server on its own port.
//   * The request takes no seed. The server rejects unknown options outright
//     ("unknown SheetSage2 request option: seed"), which is how we found out.
//   * Audio goes in through /v1/ui/upload, which returns a server-side path.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { toCleanWav } from '../../audio/prepare.mjs';

/** Source recordings looked for in a song folder, in priority order. */
export const SOURCE_NAMES = [
    'og_song.wav',
    'og_song.mp3',
    'og_song.m4a',
    'og_song.flac',
    'og_song.ogg',
];

/** Find the source recording for a song, or null. */
export function findSourceAudio(songFolder) {
    for (const name of SOURCE_NAMES) {
        const candidate = path.join(songFolder, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

export class SheetSageClientError extends Error { }

/** Decode the ABC artifact out of a SheetSage2 response. */
function extractAbc(response) {
    const artifacts = Array.isArray(response?.artifacts) ? response.artifacts : [];

    for (const artifact of artifacts) {
        if (!artifact || typeof artifact !== 'object') continue;
        const meta = artifact.meta ?? {};
        const tag = String(meta.format ?? meta.extension ?? artifact.id ?? '');
        if (!/abc|score/i.test(tag)) continue;
        if (typeof artifact.payload === 'string') {
            // The payload is base64.
            return Buffer.from(artifact.payload, 'base64').toString('utf8');
        }
    }

    // Fall back to any artifact whose payload looks like ABC.
    for (const artifact of artifacts) {
        if (typeof artifact?.payload !== 'string') continue;
        const decoded = Buffer.from(artifact.payload, 'base64').toString('utf8');
        const first = decoded.split(/\r?\n/).find((l) => l.trim());
        if (first && first.trim().startsWith('X:')) return decoded;
    }

    throw new SheetSageClientError(
        'SheetSage2 response contained no ABC artifact. '
        + `Top-level keys: ${Object.keys(response ?? {}).join(', ') || '(none)'}`
    );
}

export class SheetSageClient {
    /** @param {Object} config full config (uses config.transcribe) */
    constructor(config) {
        this.config = config.transcribe ?? {};
    }

    /** Absolute task endpoint. */
    get _taskUrl() {
        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
        return base + (this.config.endpoint ?? '/v1/tasks/run');
    }

    get _uploadUrl() {
        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
        return `${base}/v1/ui/upload`;
    }

    /**
     * Transcribe a recording to ABC.
     *
     * @param {string} audioPath  og_song.wav / .mp3 / anything ffmpeg reads
     * @returns {Promise<{abc:string, meta:object}>}
     */
    async transcribe(audioPath) {
        if (!fs.existsSync(audioPath)) {
            throw new SheetSageClientError(`Audio not found: ${audioPath}`);
        }

        const timeoutMs = Number(this.config.timeoutSeconds ?? 1800) * 1000;
        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        // 1. Normalise to a clean PCM WAV (also fixes 0xFFFFFFFF headers).
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-transcribe-'));
        const cleanWav = path.join(tmpDir, 'source.wav');
        try {
            await toCleanWav(audioPath, cleanWav, {
                sampleRate: this.config.sampleRate ?? undefined,
                silent: true,
            });

            // 2. Upload it; the server hands back a path it can read.
            const remotePath = await this._upload(cleanWav, timeoutMs);

            // 3. Run the task.
            const response = await this._run(remotePath, timeoutMs);

            const elapsedMs = Date.now() - t0;
            const abc = extractAbc(response);
            const artifacts = Array.isArray(response.artifacts) ? response.artifacts : [];

            const meta = {
                provider: 'sheetsage2',
                model: this.config.model ?? 'sheetsage2',
                endpoint: this._taskUrl,
                source: path.basename(audioPath),
                requested_at: startedAt,
                finished_at: new Date().toISOString(),
                elapsed_ms: elapsedMs,
                source_bytes: fs.statSync(audioPath).size,
                response_summary: {
                    top_level_keys: Object.keys(response ?? {}),
                    artifacts: artifacts.map((a) => ({
                        id: a?.id ?? null,
                        format: a?.meta?.format ?? a?.meta?.extension ?? null,
                        bytes: typeof a?.payload === 'string' ? a.payload.length : 0,
                    })),
                    abc_length: abc.length,
                    abc_lines: abc.split(/\r?\n/).length,
                },
                recreate_hint:
                    `resonate transcribe ${path.dirname(audioPath)} --force`,
            };

            return { abc, meta };
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    // ------------------------------------------------------------------

    async _upload(wavPath, timeoutMs) {
        const bytes = fs.readFileSync(wavPath);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res;
        try {
            res = await fetch(this._uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'audio/wav',
                    'X-AudioCPP-Filename': path.basename(wavPath),
                },
                body: bytes,
                signal: controller.signal,
            });
        } catch (err) {
            throw this._networkError(err, 'upload the audio');
        } finally {
            clearTimeout(timer);
        }

        if (!res.ok) {
            throw new SheetSageClientError(
                `Upload failed (HTTP ${res.status}): ${(await res.text().catch(() => '')).slice(0, 300)}`
            );
        }

        const json = await res.json().catch(() => null);
        if (!json?.path) {
            throw new SheetSageClientError('Upload did not return a server-side path.');
        }
        return json.path;
    }

    async _run(remotePath, timeoutMs) {
        const payload = {
            model: this.config.model ?? 'sheetsage2',
            // No seed: SheetSage2 rejects options it does not define.
            request: { audio: remotePath, options: {} },
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        let res;
        try {
            res = await fetch(this._taskUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
        } catch (err) {
            throw this._networkError(err, 'transcribe');
        } finally {
            clearTimeout(timer);
        }

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }

        if (!res.ok) {
            const message = json?.error?.message ?? text.slice(0, 300);
            throw new SheetSageClientError(
                `SheetSage2 returned ${res.status}: ${message}`
                + (res.status === 500 && /encoder backend buffer allocation/i.test(message)
                    ? '\nThe server is probably on a non-CPU backend. audio.cpp ignores'
                      + ' the per-model "backend" key, so SheetSage2 needs its own'
                      + ' process with "backend": "cpu" — see server-sheetsage.json.'
                    : '')
            );
        }
        if (!json) {
            throw new SheetSageClientError(
                `SheetSage2 returned non-JSON: ${text.slice(0, 300)}`
            );
        }
        return json;
    }

    _networkError(err, verb) {
        if (err.name === 'AbortError') {
            return new SheetSageClientError(
                `Timed out after ${this.config.timeoutSeconds}s trying to ${verb}.`
            );
        }
        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081');
        return new SheetSageClientError(
            `Could not reach the SheetSage2 server at ${base} to ${verb}. `
            + `Is it running? (${err.message})`
        );
    }
}
