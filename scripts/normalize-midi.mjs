#!/usr/bin/env node
// scripts/normalize-midi.mjs — rewrite MIDI note-on velocities into a target
// range.
//
// Thin CLI wrapper: argument parsing and I/O only. The transform lives in
// src/midi/normalize.mjs.
//
// Usage:
//   node scripts/normalize-midi.mjs <in.mid> <out.mid> [targetMin=96] [targetMax=112]

import fs from 'node:fs';
import path from 'node:path';
import { normalizeMidiBuffer, formatNormalizeStats } from '../src/midi/normalize.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node scripts/normalize-midi.mjs <in.mid> <out.mid> [min] [max]';

const args = parseArgs(process.argv.slice(2));

const { inPath, outPath } = requireInOut(args.positional, USAGE);
const [minArg = '96', maxArg = '112'] = args.positional.slice(2);

const targetMin = Number(minArg);
const targetMax = Number(maxArg);

let result;
try {
    result = normalizeMidiBuffer(fs.readFileSync(inPath), { targetMin, targetMax });
} catch (err) {
    die(err.message);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result.buffer);
console.error(formatNormalizeStats(result.stats));
