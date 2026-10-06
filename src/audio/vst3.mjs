// src/audio/vst3.mjs
// MIDI file → WAV through one or more VST3 instruments.
//
// Thin wrapper around render_vst_multi.py (Python + Pedalboard). Each MIDI
// channel is routed to a VST3 per the routing spec; channels not listed are
// dropped from the render.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { applyLoudnessTarget } from './loudness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RENDER_SCRIPT = path.join(HERE, 'render_vst_multi.py');

/**
 * @param {Object} opts
 * @param {string} opts.midiPath
 * @param {string} opts.wavPath
 * @param {Array<{channels:number[], vst3:string, gain?:number}>} opts.routes
 * @param {number} [opts.sampleRate=44100]
 * @param {boolean} [opts.normalize=false] clip-protect the plugin mix
 * @param {boolean} [opts.silent=false] swallow the Python output
 * @param {Object} [opts.loudness] {enabled, targetLufs, truePeakDb}
 * @returns {Promise<{wavPath:string, normalized:boolean}>}
 */
export async function renderMidiToWavVst({
    midiPath,
    wavPath,
    routes,
    sampleRate = 44100,
    normalize = false,
    silent = false,
    loudness = {},
}) {
    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI not found: ${midiPath}`);
    }
    if (!Array.isArray(routes) || routes.length === 0) {
        throw new Error('Routes must be a non-empty array.');
    }
    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (!Array.isArray(r.channels) || !r.vst3) {
            throw new Error(`Route ${i} must have "channels" (array) and "vst3" (string).`);
        }
        if (!fs.existsSync(r.vst3)) {
            throw new Error(`Route ${i} VST3 not found: ${r.vst3}`);
        }
    }
    if (!fs.existsSync(RENDER_SCRIPT)) {
        throw new Error(`VST render script missing: ${RENDER_SCRIPT}`);
    }

    const pyArgs = [
        RENDER_SCRIPT,
        midiPath,
        wavPath,
        '--routes', JSON.stringify(routes),
        '--sr', String(sampleRate),
    ];
    if (normalize) pyArgs.push('--normalize');

    try {
        await execa('python', pyArgs, { stdio: silent ? 'ignore' : 'inherit' });
    } catch (err) {
        throw new Error(`render_vst_multi.py failed (exit ${err.exitCode ?? '?'})`);
    }

    if (!fs.existsSync(wavPath)) {
        throw new Error(`render_vst_multi.py did not produce ${wavPath}`);
    }

    const normalized = await applyLoudnessTarget(wavPath, loudness, { silent });
    return { wavPath, normalized };
}
