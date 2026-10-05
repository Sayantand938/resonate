#!/usr/bin/env node
// scripts/midi2wav-vst.mjs — MIDI file → WAV via one or more VST3 instruments.
//
// Thin wrapper around scripts/render_vst_multi.py (Python + Pedalboard).
// Each MIDI channel is routed to a VST3 per the routing spec.
//
// Usage:
//   node scripts/midi2wav-vst.mjs <in.mid> <out.wav>
//     --routes '<json>'      OR   --routes-file <path.json>
//     [--sr 44100] [--normalize]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function parseArgs(argv) {
    const out = {
        positional: [],
        routes: null,
        routesFile: null,
        sr: 44100,
        normalize: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--routes') out.routes = argv[++i];
        else if (a === '--routes-file') out.routesFile = argv[++i];
        else if (a === '--sr') out.sr = Number(argv[++i]);
        else if (a === '--normalize') out.normalize = true;
        else out.positional.push(a);
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const [inPath, outPath] = args.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/midi2wav-vst.mjs <in.mid> <out.wav> [--routes \'<json>\' | --routes-file <path>] [--sr 44100] [--normalize]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`MIDI not found: ${inPath}`);
    process.exit(1);
}

let routesJson;
if (args.routesFile) {
    if (!fs.existsSync(args.routesFile)) {
        console.error(`Routes file not found: ${args.routesFile}`);
        process.exit(1);
    }
    routesJson = fs.readFileSync(args.routesFile, 'utf8');
} else if (args.routes) {
    routesJson = args.routes;
} else {
    console.error('Missing --routes or --routes-file.');
    process.exit(1);
}

let routes;
try {
    routes = JSON.parse(routesJson);
} catch (err) {
    console.error(`Invalid routes JSON: ${err.message}`);
    process.exit(1);
}
if (!Array.isArray(routes) || routes.length === 0) {
    console.error('Routes must be a non-empty array.');
    process.exit(1);
}
for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!Array.isArray(r.channels) || !r.vst3) {
        console.error(`Route ${i} must have "channels" (array) and "vst3" (string).`);
        process.exit(1);
    }
    if (!fs.existsSync(r.vst3)) {
        console.error(`Route ${i} VST3 not found: ${r.vst3}`);
        process.exit(1);
    }
}

const py = path.join(root, 'scripts', 'render_vst_multi.py');

const pyArgs = [
    py,
    inPath,
    outPath,
    '--routes', JSON.stringify(routes),
    '--sr', String(args.sr),
];
if (args.normalize) pyArgs.push('--normalize');

try {
    await execa('python', pyArgs, { stdio: 'inherit' });
} catch (err) {
    console.error(`render_vst_multi.py failed (exit ${err.exitCode ?? '?'})`);
    process.exit(1);
}

if (!fs.existsSync(outPath)) {
    console.error(`render_vst_multi.py did not produce ${outPath}`);
    process.exit(1);
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);