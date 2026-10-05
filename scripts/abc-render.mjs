#!/usr/bin/env node
// scripts/abc-render.mjs — ABC file → MIDI file, via abcjs (in-process).
//
// Usage:
//   node scripts/abc-render.mjs <in.abc> <out.mid>
//     [--programs c0:p0,c1:p1]     (per-channel program assignment)
//     [--tempo BPM] [--title TEXT] [--composer TEXT]
//     [--program N]

import fs from 'node:fs';
import path from 'node:path';
import { renderWithAbcjs } from './abcjs-engine.mjs';

function parseArgs(argv) {
    const out = {
        positional: [],
        programs: null,
        tempo: null,
        title: null,
        composer: null,
        program: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--program') out.program = Number(argv[++i]);
        else if (a === '--programs') out.programs = argv[++i];
        else if (a === '--tempo') out.tempo = Number(argv[++i]);
        else if (a === '--title') out.title = argv[++i];
        else if (a === '--composer') out.composer = argv[++i];
        else out.positional.push(a);
    }
    return out;
}

function parseProgramsByChannel(str) {
    const map = {};
    if (!str) return map;
    if (str.includes(':')) {
        for (const pair of str.split(',')) {
            const [ch, prog] = pair.split(':').map((s) => Number(s.trim()));
            if (Number.isInteger(ch) && Number.isInteger(prog)) map[ch] = prog;
        }
    } else {
        str.split(',').forEach((p, i) => {
            const prog = Number(p.trim());
            if (Number.isInteger(prog)) map[i] = prog;
        });
    }
    return map;
}

const opts = parseArgs(process.argv.slice(2));
const [inPath, outPath] = opts.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/abc-render.mjs <in.abc> <out.mid> [--programs c0:p0,c1:p1] [--tempo BPM] [--title TEXT] [--composer TEXT] [--program N]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`ABC file not found: ${inPath}`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const programsByChannel = parseProgramsByChannel(opts.programs);

try {
    await renderWithAbcjs({
        abcPath: inPath,
        outMidiPath: outPath,
        programsByChannel,
        title: opts.title,
        composer: opts.composer,
        tempo: opts.tempo,
        program: opts.program,
    });
} catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);