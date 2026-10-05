import fs from 'node:fs';
import path from 'node:path';

export class Yue2ClientError extends Error { }

export class Yue2Client {
    constructor(config) {
        this.config = config;    // config.score
    }

    /**
     * Call YuE2 and return both the ABC text and metadata about the call.
     *
     * @param {Object} opts
     * @param {string} opts.style
     * @param {string} opts.lyrics
     * @param {number} [opts.seed]
     * @returns {Promise<{ abc: string, meta: object }>}
     */
    async generateAbc({ style, lyrics, seed }) {
        const resolvedSeed = seed ?? this.config.seed;
        const payload = this._buildPayload({ style, lyrics, seed: resolvedSeed });

        const startedAt = new Date().toISOString();
        const t0 = Date.now();

        const json = await this._post(payload);

        const elapsedMs = Date.now() - t0;
        const finishedAt = new Date().toISOString();

        const abc = this._extractAbc(json);

        const meta = {
            provider: 'yue2',
            endpoint: this.config.baseUrl.replace(/\/+$/, '') + this.config.endpoint,
            model: this.config.model,
            requested_at: startedAt,
            finished_at: finishedAt,
            elapsed_ms: elapsedMs,
            request: payload,
            seed: resolvedSeed,
            // A minimal snapshot of what came back, useful for debugging
            // without storing the entire response (which may be large).
            response_summary: {
                top_level_keys: Object.keys(json ?? {}),
                has_artifacts: Array.isArray(json?.artifacts),
                abc_length: abc.length,
                abc_lines: abc.split(/\r?\n/).length,
            },
            // The exact CLI command to reproduce this composition. Note the
            // seed is captured even when seed_mode was "random".
            recreate_hint:
                `Set score.seed_mode: fixed and score.seed: ${resolvedSeed} ` +
                `in config.yaml, then run: resonate score <song-folder> --force`,
        };

        return { abc, meta };
    }

    // ------------------------------------------------------------------

    _buildPayload({ style, lyrics, seed }) {
        const sc = this.config;
        return {
            model: sc.model,
            request: {
                options: {
                    style,
                    cot: sc.cot,
                    stop_after: sc.stopAfter,
                },
                lyrics,
                seed: seed ?? sc.seed,
            },
        };
    }

    async _post(payload) {
        const url = this.config.baseUrl.replace(/\/+$/, '') + this.config.endpoint;
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(),
            this.config.timeoutSeconds * 1000
        );

        let resp;
        try {
            resp = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });
        } catch (err) {
            if (err.name === 'AbortError') {
                throw new Yue2ClientError(
                    `YuE2 request timed out after ${this.config.timeoutSeconds}s.`
                );
            }
            throw new Yue2ClientError(
                `Could not reach YuE2 server at ${this.config.baseUrl}. ` +
                `Is audiocpp_server.exe running? (${err.message})`
            );
        } finally {
            clearTimeout(timeout);
        }

        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Yue2ClientError(
                `YuE2 server returned ${resp.status}: ${text.slice(0, 500)}`
            );
        }

        try {
            return await resp.json();
        } catch (err) {
            throw new Yue2ClientError(
                `YuE2 returned non-JSON response: ${err.message}`
            );
        }
    }

    // ------------------------------------------------------------------
    // Response parsing (artifact walker, ported from reason8)

    _extractAbc(response) {
        const abc = this._findAbc(response);
        if (abc == null) {
            const debugPath = path.resolve('yue2_debug_response.json');
            fs.writeFileSync(
                debugPath,
                JSON.stringify(response, null, 2).slice(0, 50_000),
                'utf8'
            );
            throw new Yue2ClientError(
                `Could not find ABC text in YuE2 response. ` +
                `First 50 KB written to ${debugPath}. ` +
                `Top-level keys: ${Object.keys(response ?? {}).join(', ')}`
            );
        }
        return abc;
    }

    _findAbc(obj) {
        if (obj && typeof obj === 'object' && 'artifacts' in obj) {
            for (const a of obj.artifacts ?? []) {
                const abc = this._abcFromArtifact(a);
                if (abc) return abc;
            }
        }
        return this._walk(obj);
    }

    _abcFromArtifact(a) {
        if (!a || typeof a !== 'object') return null;
        const meta = a.meta ?? {};
        const fmt = String(meta.format ?? meta.extension ?? '').toLowerCase();
        const payload = a.payload;

        if (typeof payload === 'string') {
            if (this._looksLikeAbc(payload)) return payload;
            if (fmt === 'abc' || fmt === '') {
                const decoded = this._tryBase64(payload);
                if (decoded && this._looksLikeAbc(decoded)) return decoded;
            }
        }
        for (const key of ['path', 'output_path', 'abc_path', 'file']) {
            const v = a[key];
            if (typeof v === 'string') {
                const p = path.resolve(v);
                if (p.endsWith('.abc') && fs.existsSync(p)) {
                    return fs.readFileSync(p, 'utf8');
                }
            }
        }
        return null;
    }

    _walk(obj) {
        if (obj && typeof obj === 'object') {
            for (const v of Object.values(obj)) {
                const hit = this._walk(v);
                if (hit) return hit;
            }
            return null;
        }
        if (Array.isArray(obj)) {
            for (const v of obj) {
                const hit = this._walk(v);
                if (hit) return hit;
            }
            return null;
        }
        if (typeof obj === 'string') {
            if (this._looksLikeAbc(obj)) return obj;
            const d = this._tryBase64(obj);
            if (d && this._looksLikeAbc(d)) return d;
        }
        return null;
    }

    _tryBase64(s) {
        if (typeof s !== 'string' || s.length < 8) return null;
        let t = s.replace(/\s+/g, '');
        if (t.length % 4 !== 0) t += '='.repeat(4 - (t.length % 4));
        try {
            return Buffer.from(t, 'base64').toString('utf8');
        } catch {
            return null;
        }
    }

    _looksLikeAbc(text) {
        for (const line of String(text).split(/\r?\n/)) {
            const t = line.trim();
            if (!t) continue;
            return t.startsWith('X:');
        }
        return false;
    }
}