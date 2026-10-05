#!/usr/bin/env node
// scripts/inspect-humanization.mjs — report per-note timing and velocity
// statistics for a MIDI file.
//
// Usage: node scripts/inspect-humanization.mjs <file.mid>

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: node scripts/inspect-humanization.mjs <file.mid>');
    process.exit(1);
}

const buf = fs.readFileSync(path);
if (buf.toString('ascii', 0, 4) !== 'MThd') {
    console.error('Not a MIDI file.');
    process.exit(1);
}

const headerLen = buf.readUInt32BE(4);
const division = buf.readUInt16BE(12);

let pos = 8 + headerLen;
const perChannel = new Map();

while (pos + 8 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = buf.readUInt32BE(pos + 4);
    const end = pos + 8 + len;
    let p = pos + 8;
    let absTick = 0;
    let runningStatus = null;

    while (p < end) {
        let delta = 0, b;
        do { b = buf[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        absTick += delta;

        let status = buf[p];
        if (status < 0x80) status = runningStatus;
        else { p++; if (status < 0xF0) runningStatus = status; }

        if (status === 0xFF) { const metaLen = buf[p + 1]; p += 2 + metaLen; continue; }
        if (status === 0xF0 || status === 0xF7) { const sysexLen = buf[p + 1]; p += 2 + sysexLen; continue; }

        const type = status & 0xF0;
        const ch = status & 0x0F;

        if (type === 0x90) {
            const note = buf[p];
            const vel = buf[p + 1];
            if (vel > 0) {
                if (!perChannel.has(ch)) perChannel.set(ch, { ticks: [], vels: [] });
                const c = perChannel.get(ch);
                c.ticks.push(absTick);
                c.vels.push(vel);
            }
            p += 2;
        } else if (type === 0x80) {
            p += 2;
        } else if (type === 0xC0 || type === 0xD0) {
            p += 1;
        } else if (type === 0xB0 || type === 0xE0 || type === 0xA0) {
            p += 2;
        } else break;
    }
    pos = end;
}

function stats(arr) {
    if (arr.length === 0) return { min: 0, max: 0, mean: 0, stdev: 0 };
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return { min, max, mean, stdev: Math.sqrt(variance) };
}

console.log(`File: ${path}`);
console.log(`Division: ${division} ticks/quarter\n`);

for (const [ch, c] of [...perChannel.entries()].sort((a, b) => a[0] - b[0])) {
    const t = stats(c.ticks);
    const v = stats(c.vels);
    const gridAligned = c.ticks.filter((x) => x % 120 === 0).length;

    console.log(`Channel ${ch}: ${c.ticks.length} note-ons`);
    console.log(`  tick  min=${t.min} max=${t.max} mean=${t.mean.toFixed(1)} stdev=${t.stdev.toFixed(2)}`);
    console.log(`  vel   min=${v.min} max=${v.max} mean=${v.mean.toFixed(1)} stdev=${v.stdev.toFixed(2)}`);
    console.log(`  on-grid (multiple of 120): ${gridAligned} / ${c.ticks.length}`);
    console.log('');
}