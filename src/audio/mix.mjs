// src/audio/mix.mjs
// Mix N WAV files into one, applying a per-input gain, via ffmpeg.

import fs from 'node:fs';
import { execa } from 'execa';

/**
 * @param {Array<{wavPath:string, gain?:number}>} parts
 * @param {string} outPath
 * @param {Object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {boolean} [opts.silent=false]
 */
export async function mixWavs(parts, outPath, {
    sampleRate = 44100,
    silent = false,
} = {}) {
    if (!Array.isArray(parts) || parts.length === 0) {
        throw new Error('mixWavs: parts must be a non-empty array.');
    }
    for (const p of parts) {
        if (!fs.existsSync(p.wavPath)) {
            throw new Error(`mixWavs: input not found: ${p.wavPath}`);
        }
    }

    // Single input: re-encode through ffmpeg so the output format is
    // guaranteed, and apply that input's gain.
    if (parts.length === 1) {
        const gain = Number.isFinite(parts[0].gain) ? parts[0].gain : 1.0;
        await execa('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', parts[0].wavPath,
            '-af', `volume=${gain}`,
            '-ar', String(sampleRate),
            '-c:a', 'pcm_s16le',
            outPath,
        ], { stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
        return { outPath };
    }

    // Multiple inputs: per-input volume, then amix.
    //
    // `normalize=0` matters. ffmpeg's amix defaults to scaling each input
    // by 1/N so the sum cannot clip — but we want the configured gains to
    // mean what they say, and loudness normalization runs after this.
    // Without normalize=0, a two-voice song at gain 1.0 each comes out at
    // half volume.
    const inputs = [];
    const filters = [];
    const labels = [];

    parts.forEach((p, i) => {
        inputs.push('-i', p.wavPath);
        const gain = Number.isFinite(p.gain) ? p.gain : 1.0;
        filters.push(`[${i}:a]volume=${gain}[a${i}]`);
        labels.push(`[a${i}]`);
    });

    const filterGraph = [
        ...filters,
        `${labels.join('')}amix=inputs=${parts.length}:normalize=0:duration=longest[mix]`,
    ].join(';');

    try {
        await execa('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            ...inputs,
            '-filter_complex', filterGraph,
            '-map', '[mix]',
            '-ar', String(sampleRate),
            '-c:a', 'pcm_s16le',
            outPath,
        ], { stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
        throw new Error(
            `mixWavs failed (exit ${err.exitCode ?? '?'}): `
            + (err.stderr || err.message || '').split('\n')[0]
        );
    }

    if (!fs.existsSync(outPath)) {
        throw new Error(`mixWavs did not produce ${outPath}`);
    }
    return { outPath };
}