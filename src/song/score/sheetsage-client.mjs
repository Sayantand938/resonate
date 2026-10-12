// src/song/score/sheetsage-client.mjs
// Transcribe an existing recording to an ABC score via SheetSage2.
//
// Uses node:http / node:https directly instead of global fetch to bypass
// Node's hardcoded 300-second (5 min) undici UND_ERR_HEADERS_TIMEOUT ceiling.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
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

function debug(msg) {
    console.error(`\x1b[36m[sheetsage-debug]\x1b[0m ${msg}`);
}

/**
 * Standard HTTP/HTTPS request helper without Node fetch's 5-minute header timeout.
 */
function httpRequest(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 1800000 } = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(urlStr);
        const transport = url.protocol === 'https:' ? https : http;

        const req = transport.request(url, {
            method,
            headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const resBody = Buffer.concat(chunks).toString('utf8');
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    text: async () => resBody,
                    json: async () => JSON.parse(resBody),
                });
            });
            res.on('error', reject);
        });

        let timer = null;
        if (timeoutMs > 0) {
            timer = setTimeout(() => {
                const err = new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
                err.name = 'TimeoutError';
                req.destroy(err);
            }, timeoutMs);
        }

        req.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });

        req.on('close', () => {
            if (timer) clearTimeout(timer);
        });

        if (body) {
            req.write(body);
        }
        req.end();
    });
}

/** Decode the ABC artifact out of a SheetSage2 response. */
function extractAbc(response) {
    const artifacts = Array.isArray(response?.artifacts) ? response.artifacts : [];

    for (const artifact of artifacts) {
        if (!artifact || typeof artifact !== 'object') continue;
        const meta = artifact.meta ?? {};
        const tag = String(meta.format ?? meta.extension ?? artifact.id ?? '');
        if (!/abc|score/i.test(tag)) continue;
        if (typeof artifact.payload === 'string') {
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
    constructor(config) {
        this.config = config.transcribe ?? {};
    }

    get _taskUrl() {
        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
        return base + (this.config.endpoint ?? '/v1/tasks/run');
    }

    get _uploadUrl() {
        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081').replace(/\/+$/, '');
        return `${base}/v1/ui/upload`;
    }

    async transcribe(audioPath) {
        if (!fs.existsSync(audioPath)) {
            throw new SheetSageClientError(`Audio not found: ${audioPath}`);
        }

        const timeoutMs = Number(this.config.timeoutSeconds ?? 1800) * 1000;
        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        debug(`Starting transcription for: ${audioPath}`);

        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-transcribe-'));
        const cleanWav = path.join(tmpDir, 'source.wav');
        try {
            debug(`Normalizing audio to clean PCM WAV at ${cleanWav}...`);
            await toCleanWav(audioPath, cleanWav, {
                sampleRate: this.config.sampleRate ?? undefined,
                silent: true,
            });
            debug(`PCM WAV created (${fs.statSync(cleanWav).size} bytes).`);

            debug(`Uploading WAV to server via ${this._uploadUrl}...`);
            const remotePath = await this._upload(cleanWav, timeoutMs);
            debug(`Upload succeeded! Server assigned remote path: "${remotePath}"`);

            debug(`Triggering transcription task via ${this._taskUrl} (timeout: ${Math.round(timeoutMs / 1000)}s)...`);
            const response = await this._run(remotePath, timeoutMs);
            debug(`Task completed successfully!`);

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

    async _upload(wavPath, timeoutMs) {
        const bytes = fs.readFileSync(wavPath);
        let res;
        try {
            res = await httpRequest(this._uploadUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'audio/wav',
                    'Content-Length': bytes.length,
                    'X-AudioCPP-Filename': path.basename(wavPath),
                },
                body: bytes,
                timeoutMs,
            });
        } catch (err) {
            throw this._networkError(err, 'upload the audio');
        }

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            debug(`Upload failed with HTTP ${res.status}: ${body}`);
            throw new SheetSageClientError(
                `Upload failed (HTTP ${res.status}): ${body.slice(0, 300)}`
            );
        }

        const json = await res.json().catch(() => null);
        if (!json?.path) {
            debug(`Upload response JSON missing .path: ${JSON.stringify(json)}`);
            throw new SheetSageClientError('Upload did not return a server-side path.');
        }
        return json.path;
    }

    async _run(remotePath, timeoutMs) {
        const payload = {
            model: this.config.model ?? 'sheetsage2',
            request: { audio: remotePath, options: {} },
        };

        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        debug(`Sending payload: ${JSON.stringify(payload)}`);

        let res;
        try {
            res = await httpRequest(this._taskUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                },
                body,
                timeoutMs,
            });
        } catch (err) {
            throw this._networkError(err, 'transcribe');
        }

        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* handled below */ }

        if (!res.ok) {
            const message = json?.error?.message ?? text.slice(0, 300);
            debug(`Server error response (HTTP ${res.status}): ${message}`);
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
            debug(`Server returned non-JSON payload: ${text.slice(0, 300)}`);
            throw new SheetSageClientError(
                `SheetSage2 returned non-JSON: ${text.slice(0, 300)}`
            );
        }
        return json;
    }

    _networkError(err, verb) {
        if (err.name === 'TimeoutError' || err.name === 'AbortError') {
            return new SheetSageClientError(
                `Timed out after ${this.config.timeoutSeconds}s trying to ${verb}.`
            );
        }

        const base = String(this.config.baseUrl ?? 'http://127.0.0.1:8081');
        const code = err.code ?? '';
        const msg = err.message ?? '';
        const detail = [code, msg].filter(Boolean).join(': ');

        debug(`Network failure during '${verb}': ${detail}`);

        let extraHelp = '';
        if (code === 'ECONNRESET') {
            extraHelp = '\n→ Connection closed by server. If audiocpp_server.exe crashed, check the server console window.';
        } else if (code === 'ECONNREFUSED') {
            extraHelp = `\n→ Nothing is listening on ${base}. Confirm audiocpp_server.exe is running on port 8081.`;
        }

        return new SheetSageClientError(
            `Could not reach the SheetSage2 server at ${base} to ${verb}. `
            + `Is it running? (${detail})${extraHelp}`
        );
    }
}