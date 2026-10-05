#!/usr/bin/env node
// scripts/humanize-midi.mjs — rewrite a MIDI file to add subtle timing,
// velocity, and chord-roll humanization.
//
// Usage:
//   node scripts/humanize-midi.mjs <in.mid> <out.mid>
//     [--timing-ms 15] [--velocity 8] [--roll-ms 12]
//     [--roll-order up|down] [--min-vel 40] [--max-vel 115] [--seed 0]

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
    const out = {
        positional: [],
        timingMs: 15,
        velocity: 8,
        rollMs: 12,
        rollOrder: 'up',
        minVel: 40,
        maxVel: 115,
        seed: 0,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--timing-ms') out.timingMs = Number(argv[++i]);
        else if (a === '--velocity') out.velocity = Number(argv[++i]);
        else if (a === '--roll-ms') out.rollMs = Number(argv[++i]);
        else if (a === '--roll-order') out.rollOrder = argv[++i];
        else if (a === '--min-vel') out.minVel = Number(argv[++i]);
        else if (a === '--max-vel') out.maxVel = Number(argv[++i]);
        else if (a === '--seed') out.seed = Number(argv[++i]);
        else out.positional.push(a);
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const [inPath, outPath] = args.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/humanize-midi.mjs <in.mid> <out.mid> [--timing-ms N] [--velocity N] [--roll-ms N] [--roll-order up|down] [--min-vel N] [--max-vel N] [--seed N]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`MIDI not found: ${inPath}`);
    process.exit(1);
}

function makeRng(seed) {
    if (!seed) return Math.random;
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const rng = makeRng(args.seed);

const buf = fs.readFileSync(inPath);
if (buf.length < 14 || buf.toString('ascii', 0, 4) !== 'MThd') {
    console.error('Not a MIDI file.');
    process.exit(1);
}

const headerLen = buf.readUInt32BE(4);
const division = buf.readUInt16BE(12);
const msToTicks = (ms) => Math.round((ms / 500) * division);

const maxTimingTicks = msToTicks(args.timingMs);
const rollTicks = msToTicks(args.rollMs);

const trackChunks = [];
let pos = 8 + headerLen;
while (pos + 8 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = buf.readUInt32BE(pos + 4);
    trackChunks.push({ start: pos, dataStart: pos + 8, dataEnd: pos + 8 + len });
    pos = pos + 8 + len;
}

if (trackChunks.length === 0) {
    console.error('No MTrk chunks found.');
    process.exit(1);
}

function readVarLen(buffer, p) {
    let value = 0, b;
    do {
        b = buffer[p++];
        value = (value << 7) | (b & 0x7f);
    } while (b & 0x80);
    return { value, next: p };
}

function encodeVarLen(n) {
    if (n < 0) n = 0;
    const out = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
        out.unshift((n & 0x7f) | 0x80);
        n >>= 7;
    }
    return Buffer.from(out);
}

const parsed = trackChunks.map((t, trackIdx) => {
    const events = [];
    let p = t.dataStart;
    let absTick = 0;
    let runningStatus = null;

    while (p < t.dataEnd) {
        const d = readVarLen(buf, p);
        p = d.next;
        absTick += d.value;

        const start = p;
        const status = buf[p];

        if (status === 0xFF) {
            const lenByte = buf[p + 2];
            p += 3 + lenByte;
            events.push({ absTick, kind: 'meta', bytes: buf.subarray(start, p) });
        } else if (status === 0xF0 || status === 0xF7) {
            const lenByte = buf[p + 1];
            p += 2 + lenByte;
            events.push({ absTick, kind: 'sysex', bytes: buf.subarray(start, p) });
        } else {
            let typeByte;
            if (status < 0x80) {
                if (runningStatus == null) break;
                typeByte = runningStatus;
            } else {
                typeByte = status;
                runningStatus = status;
                p++;
            }
            const type = typeByte & 0xF0;
            const channel = typeByte & 0x0F;

            if (type === 0x90 || type === 0x80) {
                const note = buf[p];
                const vel = buf[p + 1];
                p += 2;
                const isNoteOn = type === 0x90 && vel > 0;
                events.push({
                    absTick,
                    kind: isNoteOn ? 'noteOn' : 'noteOff',
                    channel, note, velocity: vel, statusByte: typeByte,
                });
            } else if (type === 0xC0 || type === 0xD0) {
                p += 1;
                events.push({ absTick, kind: 'channelShort', channel, statusByte: typeByte, data: buf.subarray(p - 1, p) });
            } else {
                p += 2;
                events.push({ absTick, kind: 'channelShort', channel, statusByte: typeByte, data: buf.subarray(p - 2, p) });
            }
        }
    }
    return events;
});

for (let ti = 0; ti < parsed.length; ti++) {
    if (ti === 0) continue;
    const events = parsed[ti];

    const openNotes = new Map();
    for (const ev of events) {
        if (ev.kind === 'noteOn') {
            const key = `${ev.channel}-${ev.note}`;
            if (!openNotes.has(key)) openNotes.set(key, []);
            openNotes.get(key).push(ev);
        } else if (ev.kind === 'noteOff') {
            const key = `${ev.channel}-${ev.note}`;
            const stack = openNotes.get(key);
            if (stack && stack.length > 0) {
                const on = stack.shift();
                on.matchedOff = ev;
            }
        }
    }

    const byTickChannel = new Map();
    for (const ev of events) {
        if (ev.kind !== 'noteOn') continue;
        const key = `${ev.absTick}-${ev.channel}`;
        if (!byTickChannel.has(key)) byTickChannel.set(key, []);
        byTickChannel.get(key).push(ev);
    }

    for (const [, group] of byTickChannel) {
        if (group.length < 2) continue;
        if (args.rollOrder === 'down') group.sort((a, b) => b.note - a.note);
        else group.sort((a, b) => a.note - b.note);
        for (let i = 0; i < group.length; i++) group[i].rollOffsetTicks = i * rollTicks;
    }

    for (const ev of events) {
        if (ev.kind !== 'noteOn') continue;
        const jitter = maxTimingTicks > 0 ? Math.round((rng() * 2 - 1) * maxTimingTicks) : 0;
        const roll = ev.rollOffsetTicks ?? 0;
        ev.newTimingOffset = jitter + roll;
        if (args.velocity > 0) {
            const dv = Math.round((rng() * 2 - 1) * args.velocity);
            ev.newVelocity = Math.max(args.minVel, Math.min(args.maxVel, ev.velocity + dv));
        } else {
            ev.newVelocity = ev.velocity;
        }
        if (ev.matchedOff) ev.matchedOff.newTimingOffset = ev.newTimingOffset;
    }
}

function encodeTrack(events) {
    const adjusted = events.map((ev, idx) => ({
        ev, idx,
        adjustedTick: ev.absTick + (ev.newTimingOffset ?? 0),
    }));
    adjusted.sort((a, b) => a.adjustedTick - b.adjustedTick || a.idx - b.idx);

    const out = [];
    let lastTick = 0;

    for (const { ev, adjustedTick } of adjusted) {
        const delta = Math.max(0, adjustedTick - lastTick);
        lastTick = adjustedTick;
        out.push(encodeVarLen(delta));

        if (ev.kind === 'meta' || ev.kind === 'sysex') {
            out.push(ev.bytes);
        } else if (ev.kind === 'noteOn') {
            out.push(Buffer.from([ev.statusByte, ev.note & 0x7F, (ev.newVelocity ?? ev.velocity) & 0x7F]));
        } else if (ev.kind === 'noteOff') {
            out.push(Buffer.from([ev.statusByte, ev.note & 0x7F, ev.velocity & 0x7F]));
        } else if (ev.kind === 'channelShort') {
            out.push(Buffer.from([ev.statusByte]));
            out.push(ev.data);
        }
    }
    return Buffer.concat(out);
}

const trackBuffers = parsed.map((events) => {
    const data = encodeTrack(events);
    const hdr = Buffer.alloc(8);
    hdr.write('MTrk', 0, 'ascii');
    hdr.writeUInt32BE(data.length, 4);
    return Buffer.concat([hdr, data]);
});

const outBuf = Buffer.concat([buf.subarray(0, 8 + headerLen), ...trackBuffers]);

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, outBuf);

let noteCount = 0, chordCount = 0;
for (let ti = 1; ti < parsed.length; ti++) {
    for (const ev of parsed[ti]) {
        if (ev.kind === 'noteOn') {
            noteCount++;
            if (ev.rollOffsetTicks) chordCount++;
        }
    }
}

console.error(
    `humanize-midi: ${noteCount} notes, ${chordCount} chord-rolled, ` +
    `timing ±${maxTimingTicks}t (±${args.timingMs}ms), ` +
    `vel ±${args.velocity}, roll ${rollTicks}t (${args.rollMs}ms, ${args.rollOrder})`
);