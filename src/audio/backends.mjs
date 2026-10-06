// src/audio/backends.mjs
// Render backend registry.
//
// `render.backend` in config.yaml selects one of these. Each entry is a pure
// renderer: it turns a MIDI file into a WAV and nothing else.
//
// Loudness normalization is deliberately NOT a backend responsibility — it is
// applied by renderWithBackend() after the backend returns. That is what stops
// a new backend from silently skipping it, which is exactly how the VST3 path
// ended up ~11 dB quieter than the FluidSynth path.

import fs from 'node:fs';
import path from 'node:path';
import { renderMidiToWav } from './fluidsynth.mjs';
import { renderMidiToWavVst } from './vst3.mjs';
import { normalizeMidiBuffer } from '../midi/normalize.mjs';
import { applyLoudnessTarget } from './loudness.mjs';

const BACKENDS = {
    /**
     * FluidSynth + a General MIDI SoundFont. The portable default: it needs
     * no machine-specific plugin paths, so a fresh clone can render.
     */
    fluidsynth: {
        async render({ midiPath, wavPath, config, keep, silent, onStep }) {
            // GM rendering is very velocity-sensitive, so squeeze the
            // velocities into a sane band before handing them to FluidSynth.
            const normMidi = path.join(path.dirname(midiPath), '.score.loud.mid');
            const normalized = normalizeMidiBuffer(fs.readFileSync(midiPath));
            fs.writeFileSync(normMidi, normalized.buffer);

            try {
                return await renderMidiToWav({
                    midiPath: normMidi,
                    wavPath,
                    soundfont: config.render.soundfont ?? undefined,
                    gain: config.render.gain ?? undefined,
                    sampleRate: config.render.sampleRate,
                    keep,
                    silent,
                    onStep,
                });
            } finally {
                if (!keep) {
                    try { fs.unlinkSync(normMidi); } catch { /* ignore */ }
                }
            }
        },
    },

    /**
     * One or more VST3 instruments, routed per MIDI channel. Needs absolute
     * plugin paths, which is why this belongs in config.local.yaml.
     */
    vst3: {
        validate(config) {
            const routing = config.render.vst3Routing ?? [];
            if (routing.length === 0) {
                throw new Error('render.vst3_routing is empty in config.yaml');
            }
            for (const r of routing) {
                if (!fs.existsSync(r.vst3)) {
                    throw new Error(`VST3 not found: ${r.vst3}`);
                }
            }
        },

        async render({ midiPath, wavPath, config, silent }) {
            return renderMidiToWavVst({
                midiPath,
                wavPath,
                routes: (config.render.vst3Routing ?? []).map((r) => ({
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

    entry.validate?.(config);

    const result = await entry.render({
        midiPath, wavPath, config, keep, silent, onStep,
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
