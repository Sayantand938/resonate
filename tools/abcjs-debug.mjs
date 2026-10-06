#!/usr/bin/env node
// tools/abcjs-debug.mjs — render ABC with abcjs and show every step.
//
// This is the escape hatch for when you suspect our own post-processing
// (title/composer metadata, channel remap, program injection) rather than
// abcjs itself: it renders the ABC and reports what abcjs produced *before*
// any of that, then writes that raw MIDI out.
//
// Usage:
//   node tools/abcjs-debug.mjs <in.abc> <out.mid>

import fs from 'node:fs';
import path from 'node:path';
import { abcjsMidiHtml, midiFromAbcjsHtml } from '../src/abc/engine.mjs';
import {
    parseMidiEvents,
    readHeader,
    metaText,
} from '../src/midi/events.mjs';
import { parseArgs, die, requireInOut } from '../src/cli/args.mjs';

const USAGE = 'node tools/abcjs-debug.mjs <in.abc> <out.mid>';

const args = parseArgs(process.argv.slice(2));
const { inPath, outPath } = requireInOut(args.positional, USAGE);

if (!fs.existsSync(inPath)) die(`ABC file not found: ${inPath}`);

const source = fs.readFileSync(inPath, 'utf8');
const lines = source.split(/\r?\n/);

// ---- source ----------------------------------------------------------

console.log('=== SOURCE ===');
console.log(`  path        ${inPath}`);
console.log(`  bytes       ${Buffer.byteLength(source, 'utf8')}`);
console.log(`  lines       ${lines.length}`);

console.log('\n=== ABC HEADER FIELDS ===');
for (const line of lines) {
    const m = line.match(/^([A-Za-z]):\s*(.*)$/);
    if (!m) continue;
    if ('XTMLQKV'.includes(m[1])) console.log(`  ${m[1]}: ${m[2]}`);
}

console.log('\n=== VOICE DECLARATIONS (order of first appearance) ===');
const voices = [];
lines.forEach((line, i) => {
    const m = line.match(/^V:\s*([^\s]+)(.*)$/);
    if (!m) return;
    if (voices.some((v) => v.name === m[1])) return;
    voices.push({ name: m[1], attrs: m[2].trim(), at: i + 1 });
});
for (const v of voices) {
    console.log(`  line ${String(v.at).padStart(4)}: V: ${v.name}   ${v.attrs}`);
}
console.log(`  -> ${voices.length} distinct voice(s)`);

// ---- abcjs -----------------------------------------------------------

console.log('\n=== abcjs getMidiFile ===');
let htmlArray;
try {
    htmlArray = await abcjsMidiHtml(source, {});
} catch (err) {
    die(`abcjs threw: ${err.message}`);
}
if (!Array.isArray(htmlArray) || htmlArray.length === 0) {
    die('abcjs returned no MIDI.');
}
console.log(`  returned ${htmlArray.length} item(s)`);

console.log('\n=== RAW abcjs OUTPUT (first 300 chars) ===');
console.log(`  ${String(htmlArray[0]).slice(0, 300)}`);

let midiBuffer;
try {
    midiBuffer = midiFromAbcjsHtml(htmlArray[0]);
} catch (err) {
    die(err.message);
}

console.log('\n=== DECODED MIDI ===');
console.log(`  size        ${midiBuffer.length} bytes`);
console.log(`  first 32    ${midiBuffer.subarray(0, 32).toString('hex').match(/.{2}/g).join(' ')}`);

// ---- structure -------------------------------------------------------

let header;
let tracks;
try {
    header = readHeader(midiBuffer);
    ({ tracks } = parseMidiEvents(midiBuffer));
} catch (err) {
    die(`Decoded data is not usable MIDI: ${err.message}`);
}

console.log('\n=== MIDI HEADER ===');
console.log(`  format      ${header.format}`);
console.log(`  tracks      ${tracks.length} (header declares ${header.trackCount})`);
console.log(`  division    ${header.division}`);

tracks.forEach((events, i) => {
    const noteOns = events.filter((e) => e.kind === 'noteOn');
    const progChanges = events.filter(
        (e) => e.kind === 'channelShort' && (e.statusByte & 0xF0) === 0xC0
    );
    const channels = [...new Set(events.filter((e) => e.channel != null).map((e) => e.channel))]
        .sort((x, y) => x - y);
    const name = events.map(metaText).find((t) => t != null) ?? null;

    console.log(`\n=== TRACK ${i} ===`);
    console.log(`  name        ${JSON.stringify(name)}`);
    console.log(`  events      ${events.length}`);
    console.log(`  channels    ${channels.join(', ') || '(none)'}`);
    console.log(`  note-ons    ${noteOns.length}`);
    console.log(`  program ch. ${progChanges.length}`);
});

// ---- write -----------------------------------------------------------

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, midiBuffer);
console.log(`\n=== OUTPUT ===`);
console.log(`  wrote ${outPath} (${midiBuffer.length} bytes)`);
console.log('  note: raw abcjs output — no title, channel remap or program injection.\n');
