#!/usr/bin/env node
// scripts/normalize-midi.mjs — rewrite MIDI note-on velocities into a target range.
// Usage: node scripts/normalize-midi.mjs <in.mid> <out.mid> [targetMin=96] [targetMax=112]
//
// Walks the MIDI structure properly (delta-times, meta, sysex, channel events)
// so we only rewrite bytes that are actually note-on velocity fields. The old
// byte-scanning version could corrupt meta payloads or sysex data that happened
// to contain a 0x9n byte.

import fs from 'node:fs';

const [, , inPath, outPath, minArg = '96', maxArg = '112'] = process.argv;
if (!inPath || !outPath) {
    console.error('Usage: node scripts/normalize-midi.mjs <in.mid> <out.mid> [min] [max]');
    process.exit(1);
}

const targetMin = Number(minArg);
const targetMax = Number(maxArg);
if (!Number.isFinite(targetMin) || !Number.isFinite(targetMax) || targetMin > targetMax) {
    console.error(`Invalid range: ${minArg}..${maxArg}`);
    process.exit(1);
}

const buf = Buffer.from(fs.readFileSync(inPath));

if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') {
    console.error('Not a MIDI file (missing MThd header).');
    process.exit(1);
}

const headerLen = buf.readUInt32BE(4);
let pos = 8 + headerLen;

// Locate every MTrk chunk, and within each, find the byte offsets of
// note-on velocity fields so we can do a two-pass min/max-then-rewrite.
const tracks = [];
while (pos + 8 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = buf.readUInt32BE(pos + 4);
    tracks.push({ dataStart: pos + 8, dataEnd: pos + 8 + len });
    pos = pos + 8 + len;
}

if (tracks.length === 0) {
    console.error('No MTrk chunks found.');
    process.exit(1);
}

// Pass 1 — collect offsets of note-on velocity bytes.
const velOffsets = [];
for (const t of tracks) {
    let p = t.dataStart;
    while (p < t.dataEnd) {
        // variable-length delta
        let b;
        do { b = buf[p++]; } while (b & 0x80);

        const status = buf[p];
        if (status === 0xFF) {
            const len = buf[p + 2];
            p += 3 + len;
            continue;
        }
        if (status === 0xF0 || status === 0xF7) {
            const len = buf[p + 1];
            p += 2 + len;
            continue;
        }
        const type = status & 0xF0;
        if (type === 0x90) {
            const vel = buf[p + 2];
            if (vel > 0) velOffsets.push(p + 2);
            p += 3;
        } else if (type === 0x80 || type === 0xA0 || type === 0xB0 || type === 0xE0) {
            p += 3;
        } else if (type === 0xC0 || type === 0xD0) {
            p += 2;
        } else {
            // Unknown status byte — bail to avoid corrupting the file.
            break;
        }
    }
}

if (velOffsets.length === 0) {
    console.error('No note-on events found in', inPath);
    process.exit(1);
}

// Pass 2 — compute range and rewrite in place.
let srcMin = 128, srcMax = 0, sum = 0;
for (const o of velOffsets) {
    const v = buf[o];
    if (v < srcMin) srcMin = v;
    if (v > srcMax) srcMax = v;
    sum += v;
}
const srcRange = srcMax - srcMin || 1;
const dstRange = targetMax - targetMin;

for (const o of velOffsets) {
    const v = buf[o];
    const scaled = Math.round(targetMin + ((v - srcMin) / srcRange) * dstRange);
    buf[o] = Math.max(1, Math.min(127, scaled));
}

fs.writeFileSync(outPath, buf);
console.error(
    `normalize-midi: ${velOffsets.length} notes, ` +
    `src ${srcMin}..${srcMax} (mean ${Math.round(sum / velOffsets.length)}) ` +
    `-> ${targetMin}..${targetMax}`
);