// src/audio/fluidsynth.mjs
// MIDI file → WAV via FluidSynth, with silence trimming.
//
// Pipeline: fluidsynth → ffmpeg silenceremove
//
// This is a pure renderer: it does not set the output loudness. Level is
// decided by src/audio/loudness.mjs, applied by the caller (the backend
// registry for pipeline runs, the CLI wrapper for manual runs).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

/** Where `resonate install-soundfont` puts the SoundFont. */
export function defaultSoundfontPath() {
    const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
    return path.join(home, 'soundfonts', 'GeneralUser-GS.sf2');
}

async function run(cmd, cmdArgs, label, silent) {
    try {
        await execa(cmd, cmdArgs, {
            stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'],
        });
    } catch (err) {
        const code = err.exitCode ?? '?';
        throw new Error(`${label} failed (exit ${code}): ${err.shortMessage || err.message}`);
    }
}

/**
 * @param {Object} opts
 * @param {string} opts.midiPath
 * @param {string} opts.wavPath
 * @param {string} [opts.soundfont]   defaults to defaultSoundfontPath()
 * @param {number} [opts.gain=1.0]
 * @param {number} [opts.sampleRate=44100]
 * @param {boolean} [opts.keep=false] keep the intermediate WAVs
 * @param {boolean} [opts.silent=false] swallow the tool output
 * @param {(msg:string)=>void} [opts.onStep]
 * @returns {Promise<{wavPath:string, soundfont:string, tempDir:string, keptTemp:boolean}>}
 */
export async function renderMidiToWav({
    midiPath,
    wavPath,
    soundfont,
    gain = 1.0,
    sampleRate = 44100,
    keep = false,
    silent = false,
    onStep,
}) {
    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI not found: ${midiPath}`);
    }

    const sf = soundfont || defaultSoundfontPath();
    if (!fs.existsSync(sf)) {
        throw new Error(
            `SoundFont not found: ${sf}\n` +
            `Run \`resonate install-soundfont\` or pass --sf <path>.`
        );
    }

    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-'));
    fs.mkdirSync(path.dirname(wavPath), { recursive: true });

    const step = (n, total, msg) => onStep?.(`[${n}/${total}] ${msg}`);

    try {
        const rawWav = path.join(TMP, 'raw.wav');

        // 1. MIDI -> WAV (FluidSynth)
        step(1, 2, `Rendering MIDI -> WAV via FluidSynth (gain=${gain})`);
        await run(
            'fluidsynth',
            ['-g', String(gain), '-F', rawWav, sf, midiPath],
            'fluidsynth',
            silent
        );

        // 2. Silence-trim
        step(2, 2, 'Trimming silence');
        await run(
            'ffmpeg',
            [
                '-y', '-hide_banner', '-loglevel', 'error',
                '-i', rawWav,
                '-ac', '2',
                '-af',
                'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:stop_periods=-1:stop_silence=0.05:stop_threshold=-50dB',
                '-ar', String(sampleRate),
                '-c:a', 'pcm_s16le',
                wavPath,
            ],
            'ffmpeg silenceremove',
            silent
        );
    } finally {
        if (!keep) fs.rmSync(TMP, { recursive: true, force: true });
    }

    return { wavPath, soundfont: sf, tempDir: TMP, keptTemp: keep };
}
