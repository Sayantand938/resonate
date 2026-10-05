#!/usr/bin/env node
// scripts/abc2midi.mjs — ABC file → MIDI file, via abcjs.
// Called internally by the `midi` stage. Not a public CLI.

import fs from 'node:fs';
import path from 'node:path';
import { injectTitleAndComposer } from '../src/song/midi-meta.mjs';

if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

const abcjs = (await import('abcjs')).default;

function parseArgs(argv) {
    const out = {
        positional: [],
        program: null,
        tempo: null,
        title: null,
        composer: null,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--program') out.program = Number(argv[++i]);
        else if (a === '--tempo') out.tempo = Number(argv[++i]);
        else if (a === '--title') out.title = argv[++i];
        else if (a === '--composer') out.composer = argv[++i];
        else out.positional.push(a);
    }
    return out;
}

const { positional, program, tempo, title, composer } = parseArgs(process.argv.slice(2));
const [inPath, outPath] = positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/abc2midi.mjs <in.abc> <out.mid> [--program N] [--tempo BPM] [--title TEXT] [--composer TEXT]');
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
midiBuffer = injectTitleAndComposer(midiBuffer, { title, composer });

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