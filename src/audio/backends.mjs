// src/audio/backends.mjs
// Render backend registry + per-voice dispatch.
//
// `render.backend` in config.yaml names the default engine. Individual
// routes carry an explicit `engine` field (set by buildVoiceRoutes), so a
// song can mix engines per voice.
//
// Two execution paths, chosen by how many engines a song's routes span:
//
//   1. Single engine — all routes go through that engine in one call.
//      This is the common case, and it is bit-identical to the
//      pre-multi-engine version of this file.
//
//   2. Multiple engines — each route is rendered on its own to a temp WAV,
//      then every temp WAV is mixed with its own gain. Per-voice rendering
//      is what preserves each voice's gain exactly; grouping by engine
//      would collapse the gains inside a group.
//
// Loudness normalization is deliberately NOT a backend responsibility — it
// is applied after the render, whichever engines ran.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { renderMidiToWavVst } from './vst3.mjs';
import { renderMidiToWavSfizz } from './sfizz.mjs';
import { mixWavs } from './mix.mjs';
import { applyLoudnessTarget } from './loudness.mjs';

const BACKENDS = {
    vst3: {
        validate(routes) {
            for (const r of routes) {
                if (!r.vst3) {
                    throw new Error('A vst3 route is missing its "vst3" path.');
                }
                if (!fs.existsSync(r.vst3)) {
                    throw new Error(`VST3 not found: ${r.vst3}`);
                }
            }
        },

        async render({ midiPath, wavPath, config, silent, routes }) {
            return renderMidiToWavVst({
                midiPath,
                wavPath,
                routes: routes.map((r) => ({
                    channels: r.channels,
                    vst3: r.vst3,
                    gain: r.gain ?? 1.0,
                })),
                sampleRate: config.render.sampleRate,
                normalize: true,
                silent,
            });
        },
    },

    sfizz: {
        validate(routes) {
            for (const r of routes) {
                if (!r.sfz) {
                    throw new Error('An sfizz route is missing its "sfz" path.');
                }
                if (!fs.existsSync(r.sfz)) {
                    throw new Error(`SFZ not found: ${r.sfz}`);
                }
            }
        },

        async render({ midiPath, wavPath, config, silent, routes }) {
            return renderMidiToWavSfizz({
                midiPath,
                wavPath,
                routes: routes.map((r) => ({
                    channels: r.channels,
                    sfz: r.sfz,
                    // Gain is applied by the caller when routes span engines
                    // (via mixWavs), and by the renderer when they don't.
                    // Passing it through is safe: renderMidiToWavSfizz is a
                    // no-op for gain when there is a single route.
                    gain: r.gain ?? 1.0,
                })),
                sampleRate: config.render.sampleRate,
                sfizzBin: config.render.sfizzBin ?? 'sfizz_render',
                silent,
            });
        },
    },
};

/** Names of every registered backend, for error messages. */
export function listBackends() {
    return Object.keys(BACKENDS);
}

/**
 * Render one MIDI file through whichever engines its routes call for, then
 * normalize the result to the configured streaming loudness target.
 *
 * @param {Object} opts
 * @param {string} opts.backend          default engine for routes without one
 * @param {string} opts.midiPath
 * @param {string} opts.wavPath
 * @param {Object} opts.config
 * @param {Array} [opts.routes]
 * @param {boolean} [opts.keep=false]
 * @param {boolean} [opts.silent=false]
 * @param {(msg:string)=>void} [opts.onStep]
 */
export async function renderWithBackend({
    backend,
    midiPath,
    wavPath,
    config,
    routes,
    keep = false,
    silent = false,
    onStep,
}) {
    const defaultEngine = BACKENDS[backend] ? backend : 'vst3';
    if (!BACKENDS[backend]) {
        throw new Error(
            `Unknown render backend "${backend}". `
            + `Known backends: ${listBackends().join(', ')}.`
        );
    }

    let effectiveRoutes = routes;
    if (!effectiveRoutes) {
        effectiveRoutes = (config.render.vst3Routing ?? []).map((r) => ({
            engine: 'vst3',
            channels: r.channels,
            vst3: r.vst3,
            gain: r.gain ?? 1.0,
        }));
    }

    if (!effectiveRoutes || effectiveRoutes.length === 0) {
        throw new Error(
            'No render routes: neither a routes argument nor '
            + 'render.vst3_routing is set.'
        );
    }

    // Resolve each route's engine and validate up front.
    const resolved = effectiveRoutes.map((r) => {
        const engine = r.engine ?? defaultEngine;
        if (!BACKENDS[engine]) {
            throw new Error(
                `Route names unknown engine "${engine}". `
                + `Known backends: ${listBackends().join(', ')}.`
            );
        }
        return { ...r, engine };
    });

    for (const engine of new Set(resolved.map((r) => r.engine))) {
        const group = resolved.filter((r) => r.engine === engine);
        BACKENDS[engine].validate(group);
    }

    const engines = [...new Set(resolved.map((r) => r.engine))];

    // ---- fast path: one engine, one render, no temp files ----
    if (engines.length === 1) {
        const engine = engines[0];
        const result = await BACKENDS[engine].render({
            midiPath,
            wavPath,
            config,
            silent,
            routes: resolved,
        });

        if (!fs.existsSync(wavPath)) {
            throw new Error(
                `The "${engine}" backend did not produce ${path.basename(wavPath)}`
            );
        }

        const normalized = await applyLoudnessTarget(
            wavPath,
            config.render.loudness ?? {},
            { silent, onStep }
        );

        return { ...result, wavPath, normalized, engines };
    }

    // ---- multi-engine: one render per voice, then mix ----
    onStep?.(
        `Rendering ${resolved.length} voices across `
        + `${engines.length} engines: ${engines.join(' + ')}`
    );

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-mix-'));
    const parts = [];
    try {
        for (let i = 0; i < resolved.length; i++) {
            const route = resolved[i];
            const partWav = path.join(tmpDir, `voice-${i}-${route.engine}.wav`);

            // Render at unity; the route's real gain is applied by mixWavs.
            await BACKENDS[route.engine].render({
                midiPath,
                wavPath: partWav,
                config,
                silent,
                routes: [{ ...route, gain: 1.0 }],
            });

            if (!fs.existsSync(partWav)) {
                throw new Error(
                    `The "${route.engine}" backend did not produce its part.`
                );
            }

            parts.push({ wavPath: partWav, gain: route.gain ?? 1.0 });
        }

        await mixWavs(parts, wavPath, {
            sampleRate: config.render.sampleRate,
            silent,
        });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(wavPath)) {
        throw new Error('Multi-engine mix did not produce the output WAV.');
    }

    const normalized = await applyLoudnessTarget(
        wavPath,
        config.render.loudness ?? {},
        { silent, onStep }
    );

    return { wavPath, normalized, engines };
}