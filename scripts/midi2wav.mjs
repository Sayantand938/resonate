#!/usr/bin/env node
// scripts/midi2wav.mjs — MIDI file → final WAV.
// FluidSynth → ffmpeg loudnorm → ffmpeg silence-trim.
// Usage: node scripts/midi2wav.mjs <in.mid> <out.wav> [--sf <path>] [--gain 1.0] [--lufs -14] [--sr 44100] [--keep]

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';

// --- Args --------------------------------------------------------------

function parseArgs(argv) {
    const out = {
        positional: [],
        sf: null,
        gain: 1.0,
        lufs: -14,
        sr: 44100,
        keep: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--sf') out.sf = argv[++i];
        else if (a === '--gain') out.gain = Number(argv[++i]);
        else if (a === '--lufs') out.lufs = Number(argv[++i]);
        else if (a === '--sr') out.sr = Number(argv[++i]);
        else if (a === '--keep') out.keep = true;
        else out.positional.push(a);
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const [inPath, outPath] = args.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/midi2wav.mjs <in.mid> <out.wav> [--sf <path>] [--gain 1.0] [--lufs -14] [--sr 44100] [--keep]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`MIDI not found: ${inPath}`);
    process.exit(1);
}

// --- Default SoundFont -------------------------------------------------

const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
if (!args.sf) {
    args.sf = path.join(home, 'soundfonts', 'GeneralUser-GS.sf2');
}
if (!fs.existsSync(args.sf)) {
    console.error(
        `SoundFont not found: ${args.sf}\n` +
        `Run \`resonate install-soundfont\` or pass --sf <path>.`
    );
    process.exit(1);
}

// --- Helpers -----------------------------------------------------------

function step(n, total, msg) {
    console.error(`[${n}/${total}] ${msg}`);
}

async function run(cmd, cmdArgs, label) {
    try {
        await execa(cmd, cmdArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
    } catch (err) {
        const code = err.exitCode ?? '?';
        throw new Error(`${label} failed (exit ${code}): ${err.shortMessage || err.message}`);
    }
}

// --- Main --------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-'));
fs.mkdirSync(path.dirname(outPath), { recursive: true });

try {
    const rawWav = path.join(TMP, 'raw.wav');
    const normWav = path.join(TMP, 'norm.wav');

    // 1. MIDI -> WAV (FluidSynth)
    step(1, 3, `Rendering MIDI -> WAV via FluidSynth (gain=${args.gain})`);
    await run(
        'fluidsynth',
        ['-g', String(args.gain), '-F', rawWav, args.sf, inPath],
        'fluidsynth'
    );

    // 2. Loudness normalize
    step(2, 3, `Normalizing loudness to ${args.lufs} LUFS @ ${args.sr} Hz`);
    await run(
        'ffmpeg',
        [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', rawWav,
            '-ac', '2',
            '-af', `loudnorm=I=${args.lufs}:TP=-1:LRA=11`,
            '-ar', String(args.sr),
            '-c:a', 'pcm_s16le',
            normWav,
        ],
        'ffmpeg loudnorm'
    );

    // 3. Silence-trim + write
    step(3, 3, 'Trimming silence and writing final WAV');
    await run(
        'ffmpeg',
        [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', normWav,
            '-af',
            'silenceremove=start_periods=1:start_silence=0.05:start_threshold=-50dB:stop_periods=-1:stop_silence=0.05:stop_threshold=-50dB',
            '-ar', String(args.sr),
            '-c:a', 'pcm_s16le',
            outPath,
        ],
        'ffmpeg silenceremove'
    );

    console.error('');
    console.error(`Wrote ${outPath}`);
} finally {
    if (!args.keep) fs.rmSync(TMP, { recursive: true, force: true });
    else console.error(`Temp files kept in ${TMP}`);
}