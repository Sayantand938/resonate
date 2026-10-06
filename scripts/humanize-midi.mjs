#!/usr/bin/env node
// scripts/humanize-midi.mjs — add subtle timing, velocity, and chord-roll
// humanization to a MIDI file.
//
// Thin CLI wrapper: argument parsing and I/O only. The transform lives in
// src/midi/humanize.mjs.
//
// Usage:
//   node scripts/humanize-midi.mjs <in.mid> <out.mid>
//     [--timing-ms 15] [--velocity 8] [--roll-ms 12]
//     [--roll-order up|down] [--min-vel 40] [--max-vel 115] [--seed 0]

import fs from 'node:fs';
import path from 'node:path';
import { humanizeMidiBuffer, formatHumanizeStats } from '../src/midi/humanize.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node scripts/humanize-midi.mjs <in.mid> <out.mid> '
    + '[--timing-ms N] [--velocity N] [--roll-ms N] [--roll-order up|down] '
    + '[--min-vel N] [--max-vel N] [--seed N]';

const args = parseArgs(process.argv.slice(2), {
    '--timing-ms': { key: 'timingMs', kind: 'number' },
    '--velocity': { key: 'velocity', kind: 'number' },
    '--roll-ms': { key: 'rollMs', kind: 'number' },
    '--roll-order': { key: 'rollOrder', kind: 'string' },
    '--min-vel': { key: 'minVel', kind: 'number' },
    '--max-vel': { key: 'maxVel', kind: 'number' },
    '--seed': { key: 'seed', kind: 'number' },
});

const { inPath, outPath } = requireInOut(args.positional, USAGE);

if (!fs.existsSync(inPath)) die(`MIDI not found: ${inPath}`);

let result;
try {
    result = humanizeMidiBuffer(fs.readFileSync(inPath), {
        timingMs: args.timingMs ?? 15,
        velocity: args.velocity ?? 8,
        rollMs: args.rollMs ?? 12,
        rollOrder: args.rollOrder ?? 'up',
        minVel: args.minVel ?? 40,
        maxVel: args.maxVel ?? 115,
        seed: args.seed ?? 0,
    });
} catch (err) {
    die(err.message);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result.buffer);
console.error(formatHumanizeStats(result.stats));
