#!/usr/bin/env node
// scripts/midi2wav.mjs — MIDI file → final WAV.
// FluidSynth → ffmpeg silence-trim → loudness normalization.
//
// Thin CLI wrapper: argument parsing and progress reporting only. The render
// lives in src/audio/fluidsynth.mjs and is a pure renderer, so this wrapper
// applies the loudness target itself.
//
// Usage:
//   node scripts/midi2wav.mjs <in.mid> <out.wav>
//     [--sf <path>] [--gain 1.0] [--sr 44100] [--keep]
//     [--lufs -14] [--true-peak -1] [--no-normalize]

import { renderMidiToWav } from '../src/audio/fluidsynth.mjs';
import {
    DEFAULT_TARGET_LUFS,
    DEFAULT_TRUE_PEAK_DB,
    applyLoudnessTarget,
} from '../src/audio/loudness.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node scripts/midi2wav.mjs <in.mid> <out.wav> '
    + '[--sf <path>] [--gain 1.0] [--sr 44100] [--keep] '
    + '[--lufs -14] [--true-peak -1] [--no-normalize]';

const args = parseArgs(process.argv.slice(2), {
    '--sf': { key: 'sf', kind: 'string' },
    '--gain': { key: 'gain', kind: 'number' },
    '--sr': { key: 'sr', kind: 'number' },
    '--keep': { key: 'keep', kind: 'flag' },
    '--lufs': { key: 'lufs', kind: 'number' },
    '--true-peak': { key: 'truePeak', kind: 'number' },
    '--no-normalize': { key: 'noNormalize', kind: 'flag' },
});

const { inPath, outPath } = requireInOut(args.positional, USAGE);

const onStep = (msg) => console.error(msg);
const loudness = {
    enabled: !(args.noNormalize ?? false),
    targetLufs: args.lufs ?? DEFAULT_TARGET_LUFS,
    truePeakDb: args.truePeak ?? DEFAULT_TRUE_PEAK_DB,
};

let result;
try {
    result = await renderMidiToWav({
        midiPath: inPath,
        wavPath: outPath,
        soundfont: args.sf ?? undefined,
        gain: args.gain ?? 1.0,
        sampleRate: args.sr ?? 44100,
        keep: args.keep ?? false,
        onStep,
    });
    await applyLoudnessTarget(result.wavPath, loudness, { onStep });
} catch (err) {
    die(err.message);
}

console.error('');
console.error(`Wrote ${result.wavPath}`);
if (result.keptTemp) console.error(`Temp files kept in ${result.tempDir}`);
