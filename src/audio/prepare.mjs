// src/audio/prepare.mjs
// Turn an arbitrary audio file into a clean PCM WAV.
//
// Two reasons this is not optional before handing audio to SheetSage2:
//
//   1. Source may be compressed (mp3, m4a, ...) and the model wants PCM.
//   2. Downloaded WAVs frequently carry placeholder RIFF/data sizes of
//      0xFFFFFFFF meaning "unknown, streamed". ffmpeg and ffprobe read such
//      files happily by running to EOF, but stricter readers try to read
//      4 GB and fail. Re-encoding rewrites correct sizes.
//
// ffmpeg is already a hard dependency of the render stages.

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/**
 * @param {string} inputPath  any audio ffmpeg can decode
 * @param {string} outputPath where to write the PCM WAV
 * @param {Object} [opts]
 * @param {number} [opts.sampleRate] resample; omit to keep the source rate
 * @param {number} [opts.channels=2]
 * @param {boolean} [opts.silent=false]
 * @returns {Promise<{outputPath:string, bytes:number}>}
 */
export async function toCleanWav(inputPath, outputPath, {
    sampleRate,
    channels = 2,
    silent = false,
} = {}) {
    if (!fs.existsSync(inputPath)) {
        throw new Error(`Audio not found: ${inputPath}`);
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', inputPath,
        '-vn',
        '-ac', String(channels),
    ];
    if (sampleRate) args.push('-ar', String(sampleRate));
    args.push('-c:a', 'pcm_s16le', outputPath);

    try {
        await execa('ffmpeg', args, {
            stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'],
        });
    } catch (err) {
        const detail = (err.stderr || err.stdout || '').trim();
        throw new Error(
            `ffmpeg could not convert ${path.basename(inputPath)}`
            + (detail ? `\n${detail.split('\n').slice(-6).join('\n')}` : '')
        );
    }

    if (!fs.existsSync(outputPath)) {
        throw new Error(`ffmpeg did not produce ${outputPath}`);
    }
    return { outputPath, bytes: fs.statSync(outputPath).size };
}
