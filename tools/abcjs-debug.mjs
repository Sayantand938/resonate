#!/usr/bin/env node
// tools/abcjs-debug.mjs — render an ABC file to MIDI with abcjs, with
// full debug output at every step.
//
// Usage:
//   node tools/abcjs-debug.mjs <in.abc> <out.mid>
//
// Does NOT touch the pipeline. Standalone. Prints verbose diagnostics:
//   - source file info (bytes, lines, first 40 lines dumped)
//   - ABC summary parsed from the source (X, T, M, L, Q, K, V lines)
//   - abcjs render call
//   - raw HTML output from getMidiFile
//   - decoded MIDI buffer size + first 32 bytes hex
//   - MIDI header summary (format, tracks, division)
//   - per-track event counts
//   - writes the MIDI to out.mid

import fs from 'node:fs';
import path from 'node:path';

if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
    console.error('Usage: node tools/abcjs-debug.mjs <in.abc> <out.mid>');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`ABC not found: ${inPath}`);
    process.exit(1);
}

// ---------------------------------------------------------------------
// Step 1: read the source
// ---------------------------------------------------------------------

const source = fs.readFileSync(inPath, 'utf8');
console.log('=== SOURCE ===');
console.log(`  path:       ${inPath}`);
console.log(`  bytes:      ${Buffer.byteLength(source, 'utf8')}`);
console.log(`  lines:      ${source.split(/\r?\n/).length}`);
console.log('');

// ---------------------------------------------------------------------
// Step 2: parse header fields and voice declarations
// ---------------------------------------------------------------------

const lines = source.split(/\r?\n/);
console.log('=== ABC HEADER FIELDS ===');
for (const line of lines) {
    const m = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (!m) continue;
    const field = m[1];
    if ('XTM LQKV'.replace(' ', '').includes(field)) {
        console.log(`  ${field}: ${m[2]}`);
    }
}
console.log('');

console.log('=== VOICE DECLARATIONS (in order) ===');
const voices = [];
for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^V:\s*([^\s]+)(.*)$/);
    if (!m) continue;
    const name = m[1];
    const attrs = m[2].trim();
    if (!voices.some((v) => v.name === name)) {
        voices.push({ name, attrs, firstLine: i + 1 });
    }
}
for (const v of voices) {
    console.log(`  line ${String(v.firstLine).padStart(4)}: V: ${v.name}   ${v.attrs}`);
}
console.log(`  → total distinct voices: ${voices.length}`);
console.log('');

// ---------------------------------------------------------------------
// Step 3: dump the first 40 lines for reference
// ---------------------------------------------------------------------

console.log('=== SOURCE (first 40 lines) ===');
lines.slice(0, 40).forEach((l, i) => {
    console.log(`  ${String(i + 1).padStart(3)} | ${l}`);
});
console.log('');

// ---------------------------------------------------------------------
// Step 4: render with abcjs
// ---------------------------------------------------------------------

console.log('=== RENDERING WITH abcjs ===');
const abcjs = (await import('abcjs')).default;
if (typeof abcjs.synth?.getMidiFile !== 'function') {
    console.error('abcjs.synth.getMidiFile is not available.');
    process.exit(1);
}

let htmlArray;
try {
    htmlArray = abcjs.synth.getMidiFile(source, {});
} catch (err) {
    console.error(`abcjs threw: ${err.message}`);
    process.exit(1);
}

console.log(`  getMidiFile returned: ${Array.isArray(htmlArray) ? htmlArray.length : 'not-an-array'} item(s)`);
if (!Array.isArray(htmlArray) || htmlArray.length === 0) {
    console.error('abcjs returned no MIDI.');
    process.exit(1);
}

// ---------------------------------------------------------------------
// Step 5: extract MIDI from the data URL
// ---------------------------------------------------------------------

const html = htmlArray[0];
console.log('');
console.log('=== RAW abcjs OUTPUT (first 300 chars) ===');
console.log(html.slice(0, 300));
console.log('');

const m = html.match(/href\s*=\s*"data:audio\/midi,([^"]*)"/i);
if (!m) {
    console.error('Could not find data:audio/midi URL in abcjs output.');
    process.exit(1);
}

function percentDecodeToBuffer(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '%' && i + 2 <= str.length) {
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

const midiBuffer = percentDecodeToBuffer(m[1]);

console.log('=== DECODED MIDI ===');
console.log(`  size:       ${midiBuffer.length} bytes`);
console.log(`  first 32:   ${midiBuffer.subarray(0, 32).toString('hex').match(/.{2}/g).join(' ')}`);
console.log('');

// ---------------------------------------------------------------------
// Step 6: walk the MIDI and print track summaries
// ---------------------------------------------------------------------

if (midiBuffer.toString('ascii', 0, 4) !== 'MThd') {
    console.error('Decoded data is not a MIDI file (missing MThd).');
    process.exit(1);
}

const headerLen = midiBuffer.readUInt32BE(4);
const format = midiBuffer.readUInt16BE(8);
const nTracks = midiBuffer.readUInt16BE(10);
const division = midiBuffer.readUInt16BE(12);

console.log('=== MIDI HEADER ===');
console.log(`  format:     ${format}`);
console.log(`  tracks:     ${nTracks}`);
console.log(`  division:   ${division}`);
console.log('');

let pos = 8 + headerLen;
let trackNum = 0;
const trackSummaries = [];

while (pos + 8 <= midiBuffer.length) {
    if (midiBuffer.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = midiBuffer.readUInt32BE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;

    let p = dataStart;
    let absTick = 0;
    const stats = {
        noteOns: 0,
        noteOffs: 0,
        programChanges: 0,
        channels: new Set(),
        name: null,
        firstNoteTick: null,
        lastNoteTick: 0,
    };

    while (p < dataEnd) {
        let delta = 0, b;
        do { b = midiBuffer[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        absTick += delta;

        const status = midiBuffer[p];

        if (status === 0xFF) {
            const type = midiBuffer[p + 1];
            const metaLen = midiBuffer[p + 2];
            if (type === 0x03) stats.name = midiBuffer.subarray(p + 3, p + 3 + metaLen).toString('utf8');
            p += 3 + metaLen;
            continue;
        }
        if (status === 0xF0 || status === 0xF7) {
            const sysexLen = midiBuffer[p + 1];
            p += 2 + sysexLen;
            continue;
        }

        const type = status & 0xF0;
        const ch = status & 0x0F;
        stats.channels.add(ch);

        if (type === 0x90) {
            const vel = midiBuffer[p + 2];
            if (vel > 0) {
                stats.noteOns++;
                stats.lastNoteTick = absTick;
                if (stats.firstNoteTick == null) stats.firstNoteTick = absTick;
            }
            p += 3;
        } else if (type === 0x80) {
            stats.noteOffs++;
            p += 3;
        } else if (type === 0xC0) {
            stats.programChanges++;
            p += 2;
        } else if (type === 0xB0 || type === 0xE0 || type === 0xA0) {
            p += 3;
        } else if (type === 0xD0) {
            p += 2;
        } else {
            console.error(`  [warn] unknown status 0x${status.toString(16)} at byte ${p} in track ${trackNum}`);
            break;
        }
    }

    console.log(`=== TRACK ${trackNum} (${len} bytes) ===`);
    console.log(`  name:        ${JSON.stringify(stats.name)}`);
    console.log(`  channels:    ${[...stats.channels].sort((a, b) => a - b).join(', ') || '(none)'}`);
    console.log(`  note-ons:    ${stats.noteOns}`);
    console.log(`  note-offs:   ${stats.noteOffs}`);
    console.log(`  progs:       ${stats.programChanges}`);
    console.log(`  first tick:  ${stats.firstNoteTick ?? '—'}`);
    console.log(`  last tick:   ${stats.lastNoteTick}`);
    console.log('');

    trackSummaries.push({
        track: trackNum,
        name: stats.name,
        channels: [...stats.channels],
        noteOns: stats.noteOns,
        firstNoteTick: stats.firstNoteTick,
        lastNoteTick: stats.lastNoteTick,
    });

    pos = dataEnd;
    trackNum++;
}

// ---------------------------------------------------------------------
// Step 7: write the MIDI
// ---------------------------------------------------------------------

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, midiBuffer);
console.log('=== OUTPUT ===');
console.log(`  wrote ${outPath} (${midiBuffer.length} bytes)`);