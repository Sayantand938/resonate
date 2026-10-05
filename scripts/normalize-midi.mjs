#!/usr/bin/env node
// scripts/normalize-midi.mjs — rewrite MIDI note-on velocities into a target range.
// Usage: node scripts/normalize-midi.mjs <in.mid> <out.mid> [targetMin=96] [targetMax=112]

import fs from 'node:fs';

const [, , inPath, outPath, minArg = '96', maxArg = '112'] = process.argv;
if (!inPath || !outPath) {
    console.error('Usage: node scripts/normalize-midi.mjs <in.mid> <out.mid> [min] [max]');
    process.exit(1);
}

const targetMin = Number(minArg);
const targetMax = Number(maxArg);
const buf = Buffer.from(fs.readFileSync(inPath));

const vels = [];
for (let i = 0; i < buf.length - 2; i++) {
    const status = buf[i];
    if ((status & 0xF0) === 0x90) {
        const vel = buf[i + 2];
        if (vel > 0 && vel < 128) { vels.push(vel); i += 2; }
    }
}

if (vels.length === 0) {
    console.error('No note-on events found in', inPath);
    process.exit(1);
}

const srcMin = Math.min(...vels);
const srcMax = Math.max(...vels);
const srcRange = srcMax - srcMin || 1;
const dstRange = targetMax - targetMin;

let rewritten = 0;
for (let i = 0; i < buf.length - 2; i++) {
    const status = buf[i];
    if ((status & 0xF0) === 0x90) {
        const vel = buf[i + 2];
        if (vel > 0 && vel < 128) {
            const scaled = Math.round(targetMin + ((vel - srcMin) / srcRange) * dstRange);
            buf[i + 2] = Math.max(1, Math.min(127, scaled));
            rewritten++;
            i += 2;
        }
    }
}

fs.writeFileSync(outPath, buf);
console.error(
    `normalize-midi: ${rewritten} notes, ` +
    `src ${srcMin}..${srcMax} (mean ${Math.round(vels.reduce((a, b) => a + b, 0) / vels.length)}) ` +
    `-> ${targetMin}..${targetMax}`
);