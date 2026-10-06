#!/usr/bin/env node
// scripts/abc-render.mjs — ABC file → MIDI file, via abcjs.
//
// Thin CLI wrapper: argument parsing and file reporting only. The actual
// rendering lives in src/abc/engine.mjs.
//
// Usage:
//   node scripts/abc-render.mjs <in.abc> <out.mid>
//     [--programs c0:p0,c1:p1]     (per-channel program assignment)
//     [--tempo BPM] [--title TEXT] [--composer TEXT]
//     [--program N]

import fs from 'node:fs';
import { renderWithAbcjs, parseProgramsSpec } from '../src/abc/engine.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node scripts/abc-render.mjs <in.abc> <out.mid> '
    + '[--programs c0:p0,c1:p1] [--tempo BPM] [--title TEXT] '
    + '[--composer TEXT] [--program N]';

const opts = parseArgs(process.argv.slice(2), {
    '--program': { key: 'program', kind: 'number' },
    '--programs': { key: 'programs', kind: 'string' },
    '--tempo': { key: 'tempo', kind: 'number' },
    '--title': { key: 'title', kind: 'string' },
    '--composer': { key: 'composer', kind: 'string' },
});

const { inPath, outPath } = requireInOut(opts.positional, USAGE);

try {
    await renderWithAbcjs({
        abcPath: inPath,
        outMidiPath: outPath,
        programsByChannel: parseProgramsSpec(opts.programs),
        title: opts.title,
        composer: opts.composer,
        tempo: opts.tempo,
        program: opts.program,
    });
} catch (err) {
    die(err.message);
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);
