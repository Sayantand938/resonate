#!/usr/bin/env node
// scripts/abc2midi.mjs — ABC file → MIDI file, via abcjs.
// Called internally by the `midi` stage. Not a public CLI.

import fs from 'node:fs';
import path from 'node:path';
import {
    injectTitleAndComposer,
    injectPrograms,
} from '../src/song/midi-meta.mjs';
import { remapChannels } from '../src/song/midi-remap.mjs';

if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

const abcjs = (await import('abcjs')).default;

function parseArgs(argv) {
    const out = {
        positional: [],
        program: null,
        programs: null,
        tempo: null,
        title: null,
        composer: null,
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

const { positional, program, programs, tempo, title, composer } =
    parseArgs(process.argv.slice(2));
const [inPath, outPath] = positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/abc2midi.mjs <in.abc> <out.mid> [--program N | --programs c0,c1,c2] [--tempo BPM] [--title TEXT] [--composer TEXT]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`ABC file not found: ${inPath}`);
    process.exit(1);
}

if (typeof abcjs.synth?.getMidiFile !== 'function') {
    console.error('abcjs.synth.getMidiFile is not available.');
    process.exit(1);
}

let source = fs.readFileSync(inPath, 'utf8');

if (tempo != null) {
    if (/^Q:/m.test(source)) {
        source = source.replace(/^Q:.*$/m, `Q:1/4=${tempo}`);
    } else {
        source = source.replace(/^(X:[^\n]*\n)/m, `$1Q:1/4=${tempo}\n`);
    }
}

const midiOptions = {};
if (Number.isInteger(program)) midiOptions.program = program;

const htmlArray = abcjs.synth.getMidiFile(source, midiOptions);
if (!Array.isArray(htmlArray) || htmlArray.length === 0) {
    console.error('abcjs did not return any MIDI.');
    process.exit(1);
}

let midiBuffer = extractMidiFromHtml(htmlArray[0]);

// 1. Metadata (title + composer) into track 0
midiBuffer = injectTitleAndComposer(midiBuffer, { title, composer });

// 2. Remap channels: each non-conductor track gets its own dedicated channel.
//    Track 1 → ch 0, track 2 → ch 1, track 3 → ch 2, ...
//    This is required because abcjs reuses channel 0 across multiple tracks.
midiBuffer = remapChannels(midiBuffer, { 1: 0, 2: 1, 3: 2, 4: 3 });

// 3. Per-channel program changes
if (programs) {
    const map = {};
    if (programs.includes(':')) {
        for (const pair of programs.split(',')) {
            const [ch, prog] = pair.split(':').map((s) => Number(s.trim()));
            if (Number.isInteger(ch) && Number.isInteger(prog)) {
                map[ch] = prog;
            }
        }
    } else {
        programs.split(',').forEach((p, i) => {
            const prog = Number(p.trim());
            if (Number.isInteger(prog)) map[i] = prog;
        });
    }
    midiBuffer = injectPrograms(midiBuffer, map);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, midiBuffer);
console.error(`Wrote ${outPath} (${midiBuffer.length} bytes)`);

// ---------------------------------------------------------------------

function extractMidiFromHtml(html) {
    const m = html.match(/href\s*=\s*"data:audio\/midi,([^"]*)"/i);
    if (!m) throw new Error('Could not find MIDI data URL in abcjs output.');
    return percentDecodeToBuffer(m[1]);
}

function percentDecodeToBuffer(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '%' && i + 2 < str.length + 1) {
            const hex = str.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
                continue;
            }
        }
        bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(bytes);
}