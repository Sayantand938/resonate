#!/usr/bin/env node
// scripts/midi2wav-vst.mjs — MIDI file → WAV via a VST3 instrument.
//
// Thin wrapper around scripts/render_vst.py (Python + Pedalboard).
// The Python side does the actual VST3 hosting; this script just shells
// out to it so the pipeline stays a single command from the CLI.
//
// Usage:
//   node scripts/midi2wav-vst.mjs <in.mid> <out.wav> --vst <path.vst3> [--gain 1.0] [--sr 44100]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function parseArgs(argv) {
    const out = {
        positional: [],
        vst: null,
        gain: 1.0,
        sr: 44100,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--vst') out.vst = argv[++i];
        else if (a === '--gain') out.gain = Number(argv[++i]);
        else if (a === '--sr') out.sr = Number(argv[++i]);
        else out.positional.push(a);
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const [inPath, outPath] = args.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/midi2wav-vst.mjs <in.mid> <out.wav> --vst <path.vst3> [--gain 1.0] [--sr 44100]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`MIDI not found: ${inPath}`);
    process.exit(1);
}
if (!args.vst || !fs.existsSync(args.vst)) {
    console.error(`VST3 not found: ${args.vst}`);
    process.exit(1);
}

const py = path.join(root, 'scripts', 'render_vst.py');

const pyArgs = [
    py,
    inPath,
    outPath,
    '--vst', args.vst,
    '--sr', String(args.sr),
];

try {
    await execa('python', pyArgs, { stdio: 'inherit' });
} catch (err) {
    console.error(`render_vst.py failed (exit ${err.exitCode ?? '?'})`);
    process.exit(1);
}

if (!fs.existsSync(outPath)) {
    console.error(`render_vst.py did not produce ${outPath}`);
    process.exit(1);
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);