#!/usr/bin/env node
// scripts/midi2wav-vst.mjs — MIDI file → WAV via one or more VST3 instruments.
//
// Thin CLI wrapper: argument parsing and file reporting only. The render
// lives in src/audio/vst3.mjs (which drives render_vst_multi.py) and is a
// pure renderer, so this wrapper applies the loudness target itself.
//
// Usage:
//   node scripts/midi2wav-vst.mjs <in.mid> <out.wav>
//     --routes '<json>'      OR   --routes-file <path.json>
//     [--sr 44100] [--clip-protect]
//     [--lufs -14] [--true-peak -1] [--no-normalize]

import fs from 'node:fs';
import { renderMidiToWavVst } from '../src/audio/vst3.mjs';
import {
    DEFAULT_TARGET_LUFS,
    DEFAULT_TRUE_PEAK_DB,
    applyLoudnessTarget,
} from '../src/audio/loudness.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node scripts/midi2wav-vst.mjs <in.mid> <out.wav> '
    + '[--routes \'<json>\' | --routes-file <path>] [--sr 44100] [--clip-protect] '
    + '[--lufs -14] [--true-peak -1] [--no-normalize]';

const args = parseArgs(process.argv.slice(2), {
    '--routes': { key: 'routes', kind: 'string' },
    '--routes-file': { key: 'routesFile', kind: 'string' },
    '--sr': { key: 'sr', kind: 'number' },
    '--clip-protect': { key: 'clipProtect', kind: 'flag' },
    '--lufs': { key: 'lufs', kind: 'number' },
    '--true-peak': { key: 'truePeak', kind: 'number' },
    '--no-normalize': { key: 'noNormalize', kind: 'flag' },
});

const { inPath, outPath } = requireInOut(args.positional, USAGE);

let routesJson;
if (args.routesFile) {
    if (!fs.existsSync(args.routesFile)) {
        die(`Routes file not found: ${args.routesFile}`);
    }
    routesJson = fs.readFileSync(args.routesFile, 'utf8');
} else if (args.routes) {
    routesJson = args.routes;
} else {
    die('Missing --routes or --routes-file.', USAGE);
}

let routes;
try {
    routes = JSON.parse(routesJson);
} catch (err) {
    die(`Invalid routes JSON: ${err.message}`);
}

const onStep = (msg) => console.error(msg);
const loudness = {
    enabled: !(args.noNormalize ?? false),
    targetLufs: args.lufs ?? DEFAULT_TARGET_LUFS,
    truePeakDb: args.truePeak ?? DEFAULT_TRUE_PEAK_DB,
};

try {
    await renderMidiToWavVst({
        midiPath: inPath,
        wavPath: outPath,
        routes,
        sampleRate: args.sr ?? 44100,
        normalize: args.clipProtect ?? false,
    });
    await applyLoudnessTarget(outPath, loudness, { onStep });
} catch (err) {
    die(err.message);
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
