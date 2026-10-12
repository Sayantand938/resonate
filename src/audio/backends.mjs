// src/audio/backends.mjs
// Render backend registry.
//
// `render.backend` in config.yaml selects one of these. Each entry is a pure
// renderer: it turns a MIDI file into a WAV and nothing else.
//
// Loudness normalization is deliberately NOT a backend responsibility — it is
// applied by renderWithBackend() after the backend returns. That is what stops
// a new backend from silently skipping it.

import fs from 'node:fs';
import path from 'node:path';
import { renderMidiToWavVst } from './vst3.mjs';
import { applyLoudnessTarget } from './loudness.mjs';

const BACKENDS = {
    /**
     * One or more VST3 instruments, routed per MIDI channel. Needs absolute
     * plugin paths, which is why this is machine-specific config.
     *
     * Routes come from one of two places:
     *   - the `routes` argument (built by the caller, e.g. from voice names)
     *   - config.render.vst3Routing (the static table for older setups)
     */
    vst3: {
        validate(config, routes) {
            const effective = routes ?? config.render.vst3Routing ?? [];
            if (effective.length === 0) {
                throw new Error(
                    'No VST3 routes: neither a routes argument nor '
                    + 'render.vst3_routing is set.'
                );
            }
            for (const r of effective) {
                if (!fs.existsSync(r.vst3)) {
                    throw new Error(`VST3 not found: ${r.vst3}`);
                }
            }
        },

        async render({ midiPath, wavPath, config, silent, routes }) {
            const effectiveRoutes = routes ?? (config.render.vst3Routing ?? []).map((r) => ({
                channels: r.channels,
                vst3: r.vst3,
                gain: r.gain ?? 1.0,
            }));

            return renderMidiToWavVst({
                midiPath,
                wavPath,
                routes: effectiveRoutes,
                sampleRate: config.render.sampleRate,
                normalize: true,
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
 * Render one MIDI file to a WAV through the configured backend, then
 * normalize the result to the configured streaming loudness target.
 *
 * @param {Object} opts
 * @param {string} opts.backend          key into the registry
 * @param {string} opts.midiPath
 * @param {string} opts.wavPath
 * @param {Object} opts.config           full config (uses config.render)
 * @param {Array} [opts.routes]          VST3 routes to use instead of config
 * @param {boolean} [opts.keep=false]
 * @param {boolean} [opts.silent=false]
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{wavPath:string, normalized:boolean}>}
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
    const entry = BACKENDS[backend];
    if (!entry) {
        throw new Error(
            `Unknown render backend "${backend}". ` +
            `Known backends: ${listBackends().join(', ')}.`
        );
    }

    entry.validate?.(config, routes);

    const result = await entry.render({
        midiPath, wavPath, config, routes, keep, silent, onStep,
    });

    if (!fs.existsSync(wavPath)) {
        throw new Error(
            `The "${backend}" backend did not produce ${path.basename(wavPath)}`
        );
    }

    const normalized = await applyLoudnessTarget(
        wavPath,
        config.render.loudness ?? {},
        { silent, onStep }
    );

    return { ...result, wavPath, normalized };
}