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
 * Run an ffmpeg/ffprobe command and capture what it wrote to stderr (or
 * stdout), via a temp file rather than a pipe.
 *
 * The temp file is not a stylistic choice. Under the Windows sandbox, a
 * piped stdio for these binaries is denied; the temp file works
 * everywhere. Callers get the raw text back and parse it themselves.
 *
 * @param {string} cmd          'ffmpeg' or 'ffprobe'
 * @param {string[]} args
 * @param {'stderr'|'stdout'} channel  which stream to capture
 * @param {Object} [opts]
 * @param {boolean} [opts.reject=false] pass through to execa
 * @returns {Promise<{text:string, exitCode:number|undefined}>}
 */
async function captureOutput(cmd, args, channel, { reject = false } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-capture-'));
    const capturePath = path.join(dir, channel === 'stderr' ? 'stderr.txt' : 'stdout.txt');
    const fd = fs.openSync(capturePath, 'w');

    // Map the captured stream to the open fd; the other goes to /dev/null
    // (or NUL). execa accepts 'ignore' for the streams we don't want.
    const stdio = channel === 'stderr'
        ? ['ignore', 'ignore', fd]
        : ['ignore', fd, 'ignore'];

    let exitCode;
    try {
        const result = await execa(cmd, args, { stdio, reject });
        exitCode = result.exitCode;
    } finally {
        fs.closeSync(fd);
    }

    const text = fs.readFileSync(capturePath, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    return { text, exitCode };
}

/**
 * Pick an output PCM codec that preserves the source's bit depth, so
 * normalizing never silently degrades a 24-bit or float master to 16-bit.
 */
async function sourceCodec(wavPath) {
    const { text } = await captureOutput('ffprobe', [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'stream=sample_rate,bits_per_raw_sample,sample_fmt',
        '-of', 'json',
        wavPath,
    ], 'stdout');

    const stream = JSON.parse(text)?.streams?.[0] ?? {};
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
 * @returns {Promise<{inputLufs:number, inputTruePeak:number, inputLra:number}>}
 */
export async function measureLoudness(wavPath, {
    targetLufs = DEFAULT_TARGET_LUFS,
    truePeakDb = DEFAULT_TRUE_PEAK_DB,
} = {}) {
    const { text } = await captureOutput('ffmpeg', [
        '-hide_banner', '-nostats',
        '-i', wavPath,
        '-af', `loudnorm=I=${targetLufs}:TP=${truePeakDb}:print_format=json`,
        '-f', 'null',
        process.platform === 'win32' ? 'NUL' : '/dev/null',
    ], 'stderr');

    const match = text.match(/\{[\s\S]*\}/);
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