#!/usr/bin/env node
// scripts/show-collisions.mjs — find ticks where two or more tracks
// play the same pitch at the same time (a "doubled" note).
//
// Usage: node scripts/show-collisions.mjs <path-to.mid>

import fs from 'node:fs';

const path = process.argv[2];
if (!path) {
    console.error('Usage: node scripts/show-collisions.mjs <path-to.mid>');
    process.exit(1);
}

const buf = fs.readFileSync(path);
const division = buf.readUInt16BE(12);
const headerLen = buf.readUInt32BE(4);

let pos = 8 + headerLen;
let trackNum = 0;

// events[trackIdx] = [{ tick, type, ch, pitch, vel }]
const eventsByTrack = [];

while (pos + 8 <= buf.length) {
    if (buf.toString('ascii', pos, pos + 4) !== 'MTrk') break;
    const len = buf.readUInt32BE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;

    const events = [];
    let p = dataStart;
    let absTick = 0;

    while (p < dataEnd) {
        let delta = 0, b;
        do { b = buf[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
        absTick += delta;

        const status = buf[p];
        if (status === 0xFF) {
            const metaLen = buf[p + 2];
            p += 3 + metaLen;
            continue;
        }
        if (status === 0xF0 || status === 0xF7) {
            const sysexLen = buf[p + 1];
            p += 2 + sysexLen;
            continue;
        }

        const type = status & 0xF0;
        const ch = status & 0x0F;

        if (type === 0x90) {
            const pitch = buf[p + 1];
            const vel = buf[p + 2];
            if (vel > 0) {
                events.push({ tick: absTick, ch, pitch, vel });
            }
            p += 3;
        } else if (type === 0x80) {
            p += 3;
        } else if (type === 0xC0) {
            p += 2;
        } else if (type === 0xB0 || type === 0xE0 || type === 0xA0) {
            p += 3;
        } else if (type === 0xD0) {
            p += 2;
        } else {
            break;
        }
    }

    eventsByTrack.push(events);
    pos = dataEnd;
    trackNum++;
}

// Build a map: tick → list of (track, ch, pitch, vel)
const byTick = new Map();
for (let t = 0; t < eventsByTrack.length; t++) {
    for (const e of eventsByTrack[t]) {
        if (!byTick.has(e.tick)) byTick.set(e.tick, []);
        byTick.get(e.tick).push({ track: t, ...e });
    }
}

// Find ticks where ≥2 tracks play the same pitch.
const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function nameOf(pitch) {
    const octave = Math.floor(pitch / 12) - 1;
    return `${noteNames[pitch % 12]}${octave}`;
}

const collisions = [];
for (const [tick, notes] of byTick) {
    // Group by pitch.
    const byPitch = new Map();
    for (const n of notes) {
        if (!byPitch.has(n.pitch)) byPitch.set(n.pitch, []);
        byPitch.get(n.pitch).push(n);
    }
    for (const [pitch, list] of byPitch) {
        // Distinct tracks playing this pitch simultaneously?
        const tracks = new Set(list.map((n) => n.track));
        if (tracks.size >= 2) {
            collisions.push({ tick, pitch, list, tracks: [...tracks].sort() });
        }
    }
}

console.log(`Total simultaneous-note-on events: ${[...byTick.values()].reduce((a, l) => a + l.length, 0)}`);
console.log(`Collisions (same pitch on ≥2 tracks at same tick): ${collisions.length}`);
console.log('');

if (collisions.length === 0) {
    console.log('No pitch collisions found. The "doubling" you hear is either:');
    console.log('  - octave doubling (not the same pitch)');
    console.log('  - a chord tone coinciding with the melody by chance');
    console.log('  - the accompaniment playing a different pitch that');
    console.log('    happens to sound consonant/aligned with the melody');
    process.exit(0);
}

// Print first 60 collisions.
const shown = collisions.slice(0, 60);
for (const c of shown) {
    const beat = (c.tick / division).toFixed(2);
    const parts = c.list.map((n) => `trk${n.track}/ch${n.ch}/vel${n.vel}`).join(' + ');
    console.log(`tick ${String(c.tick).padStart(7)} (beat ${beat.padStart(6)}): ${nameOf(c.pitch)} (${c.pitch})  ${parts}`);
}

if (collisions.length > shown.length) {
    console.log(`\n... and ${collisions.length - shown.length} more.`);
}

// Also summarize collisions per track-pair.
const pairCounts = new Map();
for (const c of collisions) {
    const key = c.tracks.join('+');
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
}
console.log('');
console.log('Collisions by track pair:');
for (const [key, count] of [...pairCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  tracks ${key}: ${count}`);
}

// Octave doublings (same pitch class, different octave, same tick).
console.log('');
console.log('Octave doublings (same pitch class, different octave, same tick):');
const octaveDoubles = [];
for (const [tick, notes] of byTick) {
    const byPc = new Map();
    for (const n of notes) {
        const pc = n.pitch % 12;
        if (!byPc.has(pc)) byPc.set(pc, []);
        byPc.get(pc).push(n);
    }
    for (const [, list] of byPc) {
        const distinctPitches = new Set(list.map((n) => n.pitch));
        const tracks = new Set(list.map((n) => n.track));
        if (distinctPitches.size >= 2 && tracks.size >= 2) {
            octaveDoubles.push({ tick, list });
        }
    }
}
console.log(`  ${octaveDoubles.length} occurrences`);
const shownOct = octaveDoubles.slice(0, 20);
for (const od of shownOct) {
    const beat = (od.tick / division).toFixed(2);
    const parts = od.list.map((n) => `${nameOf(n.pitch)}@trk${n.track}/ch${n.ch}`).join(' + ');
    console.log(`  tick ${String(od.tick).padStart(7)} (beat ${beat.padStart(6)}): ${parts}`);
}
if (octaveDoubles.length > shownOct.length) {
    console.log(`  ... and ${octaveDoubles.length - shownOct.length} more.`);
}