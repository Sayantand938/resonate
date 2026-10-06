// src/audio/loudness.mjs
// Final loudness normalization for rendered WAVs.
//
// Streaming services normalize playback, so a quiet master is not "safer" —
// it just plays back quieter than everything around it. Spotify targets
// -14 LUFS integrated and asks for true peak at or below -1 dBTP.
//
// This is the single place in the project that decides output level, so the
// FluidSynth and VST3 backends cannot drift apart.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';

/** Spotify / YouTube integrated loudness target. */
export const DEFAULT_TARGET_LUFS = -14;
/** Spotify maximum true peak, to survive lossy transcoding. */
export const DEFAULT_TRUE_PEAK_DB = -1;

/**
 * Pick an output PCM codec that preserves the source's bit depth, so
 * normalizing never silently degrades a 24-bit or float master to 16-bit.
 *
 * Like measureLoudness, this captures ffprobe's stdout through a temp file
 * rather than a pipe, which the Windows sandbox denies.
 */
async function sourceCodec(wavPath) {
    const stdoutPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-probe-')),
        'stream.json'
    );
    const fd = fs.openSync(stdoutPath, 'w');

    try {
        await execa('ffprobe', [
            '-v', 'error',
            '-select_streams', 'a:0',
            '-show_entries', 'stream=sample_rate,bits_per_raw_sample,sample_fmt',
            '-of', 'json',
            wavPath,
        ], { stdio: ['ignore', fd, 'ignore'], reject: false });
    } finally {
        fs.closeSync(fd);
    }

    const stream = JSON.parse(fs.readFileSync(stdoutPath, 'utf8'))?.streams?.[0] ?? {};
    const fmt = String(stream.sample_fmt ?? '');
    const bits = Number(stream.bits_per_raw_sample ?? 0);

    let codec = 'pcm_s16le';
    if (fmt.startsWith('flt') || fmt.startsWith('dbl')) codec = 'pcm_f32le';
    else if (bits >= 24) codec = 'pcm_s24le';

    return { codec, sampleRate: Number(stream.sample_rate) || 44100 };
}

/**
 * Measure a WAV's integrated loudness and true peak.
 *
 * ffmpeg writes the JSON report to stderr, and under the Windows sandbox a
 * piped stdio would be denied — so the report goes to a temp file and is
 * read back instead.
 *
 * @returns {Promise<{inputLufs:number, inputTruePeak:number, inputLra:number}>}
 */
export async function measureLoudness(wavPath, {
    targetLufs = DEFAULT_TARGET_LUFS,
    truePeakDb = DEFAULT_TRUE_PEAK_DB,
} = {}) {
    const reportPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-loud-')),
        'report.json'
    );
    const fd = fs.openSync(reportPath, 'w');

    try {
        await execa('ffmpeg', [
            '-hide_banner', '-nostats',
            '-i', wavPath,
            '-af', `loudnorm=I=${targetLufs}:TP=${truePeakDb}:print_format=json`,
            '-f', 'null',
            process.platform === 'win32' ? 'NUL' : '/dev/null',
        ], { stdio: ['ignore', 'ignore', fd], reject: false });
    } finally {
        fs.closeSync(fd);
    }

    const stderr = fs.readFileSync(reportPath, 'utf8');
    const match = stderr.match(/\{[\s\S]*\}/);
    if (!match) {
        throw new Error(`Could not parse loudness report for ${wavPath}`);
    }

    const json = JSON.parse(match[0]);
    return {
        inputLufs: Number(json.input_i),
        inputTruePeak: Number(json.input_tp),
        inputLra: Number(json.input_lra),
    };
}

/**
 * Normalize a WAV in place to the target integrated loudness, holding the
 * true peak at or below `truePeakDb`.
 *
 * loudnorm is a dynamic normalizer: when the gain needed to reach the target
 * would push peaks past the ceiling, it applies limiting rather than
 * clipping. That tradeoff is why a very dynamic mix cannot reach -14 LUFS
 * without some gain reduction.
 *
 * @param {string} wavPath
 * @param {Object} [opts]
 * @param {number} [opts.targetLufs]
 * @param {number} [opts.truePeakDb]
 * @param {boolean} [opts.silent]
 * @returns {Promise<{wavPath:string, codec:string}>}
 */
export async function normalizeLoudness(wavPath, {
    targetLufs = DEFAULT_TARGET_LUFS,
    truePeakDb = DEFAULT_TRUE_PEAK_DB,
    silent = false,
} = {}) {
    if (!fs.existsSync(wavPath)) {
        throw new Error(`WAV not found: ${wavPath}`);
    }

    const { codec, sampleRate } = await sourceCodec(wavPath);
    const tmpPath = `${wavPath}.loudnorm.wav`;

    try {
        await execa('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', wavPath,
            '-af', `loudnorm=I=${targetLufs}:TP=${truePeakDb}:LRA=11`,
            '-ar', String(sampleRate),
            '-c:a', codec,
            tmpPath,
        ], { stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        throw new Error(
            `loudness normalization failed: ${err.shortMessage || err.message}`
        );
    }

    fs.rmSync(wavPath, { force: true });
    fs.renameSync(tmpPath, wavPath);
    return { wavPath, codec };
}

/**
 * Tail-step shared by both render backends: normalize to the configured
 * streaming target when enabled.
 *
 * @param {string} wavPath
 * @param {{enabled?:boolean, targetLufs?:number, truePeakDb?:number}} loudness
 * @param {{silent?:boolean, onStep?:(msg:string)=>void}} [opts]
 * @returns {Promise<boolean>} whether normalization ran
 */
export async function applyLoudnessTarget(wavPath, loudness, {
    silent = false,
    onStep,
} = {}) {
    if (!loudness?.enabled) return false;

    onStep?.(
        `Normalizing to ${loudness.targetLufs} LUFS `
        + `(true peak ${loudness.truePeakDb} dB)`
    );

    await normalizeLoudness(wavPath, {
        targetLufs: loudness.targetLufs,
        truePeakDb: loudness.truePeakDb,
        silent,
    });
    return true;
}
