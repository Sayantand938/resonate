#!/usr/bin/env node
// tools/inspect-midi.mjs — structural report for a MIDI file.
//
// Replaces the three separate inspector scripts; they all walked the same
// bytes and differed only in what they printed.
//
// Usage:
//   node tools/inspect-midi.mjs <file.mid> [--collisions]
//
//   --collisions   also report the same pitch sounding on two tracks at the
//                  same tick, which is the usual cause of a "doubled" part.

import fs from 'node:fs';
import {
    parseMidiEvents,
    readHeader,
    metaText,
    firstTempo,
} from '../src/midi/events.mjs';
import { parseArgs, die } from '../src/cli/args.mjs';

const USAGE = 'node tools/inspect-midi.mjs <file.mid> [--collisions]';

const args = parseArgs(process.argv.slice(2), {
    '--collisions': { key: 'collisions', kind: 'flag' },
});

const [filePath] = args.positional;
if (!filePath) die(null, USAGE);
if (!fs.existsSync(filePath)) die(`MIDI not found: ${filePath}`);

const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = (n) => `${PITCH[n % 12]}${Math.floor(n / 12) - 1}`;

const buf = fs.readFileSync(filePath);

let header;
let tracks;
try {
    header = readHeader(buf);
    ({ tracks } = parseMidiEvents(buf));
} catch (err) {
    die(err.message);
}

const stats = (nums) => {
    if (nums.length === 0) return null;
    const sum = nums.reduce((a, b) => a + b, 0);
    return {
        min: Math.min(...nums),
        max: Math.max(...nums),
        mean: sum / nums.length,
    };
};

const fmt = (n, digits = 1) => (n == null ? '—' : n.toFixed(digits));

// ---- header ----------------------------------------------------------

console.log(`\n=== HEADER ===  ${filePath}`);
console.log(`  format      ${header.format} (${header.format === 0 ? 'single track' : 'multi-track'})`);
console.log(`  tracks      ${tracks.length} (header declares ${header.trackCount})`);
console.log(`  division    ${header.division} ticks/quarter`);
console.log(`  size        ${buf.length.toLocaleString()} bytes`);

// ---- tempo -----------------------------------------------------------

const { usPerQuarter: tempoUs, tick: tempoTick, explicit: tempoFound } = firstTempo(tracks);
const secondsPerTick = (tempoUs / 1_000_000) / header.division;
console.log('\n=== TEMPO ===');
console.log(`  ${fmt(60_000_000 / tempoUs)} BPM  (${tempoUs} us/quarter) at tick ${tempoTick}`
    + (tempoFound ? '' : '  [default — no set_tempo found]'));

// ---- per track -------------------------------------------------------

console.log('\n=== TRACKS ===');
console.log('  #   name                    events  note-ons  channels  tick range');

let totalNotes = 0;
let lastTick = 0;

tracks.forEach((events, i) => {
    const noteOns = events.filter((e) => e.kind === 'noteOn');
    const channels = [...new Set(events.filter((e) => e.channel != null).map((e) => e.channel))]
        .sort((a, b) => a - b);
    const name = events.map(metaText).find((t) => t != null) ?? '';
    const end = events.length ? events[events.length - 1].absTick : 0;

    totalNotes += noteOns.length;
    lastTick = Math.max(lastTick, end);

    const range = noteOns.length
        ? `${noteOns[0].absTick}..${noteOns[noteOns.length - 1].absTick}`
        : '—';

    console.log(
        `  ${String(i).padEnd(3)} ${(name ? `"${name}"` : '—').padEnd(23)}`
        + `${String(events.length).padStart(6)}  ${String(noteOns.length).padStart(8)}`
        + `  ${(channels.join(',') || '—').padEnd(8)}  ${range}`
    );
});

// ---- per channel -----------------------------------------------------

const byChannel = new Map();
for (const events of tracks) {
    for (const ev of events) {
        if (ev.kind !== 'noteOn') continue;
        if (!byChannel.has(ev.channel)) byChannel.set(ev.channel, []);
        byChannel.get(ev.channel).push(ev);
    }
}

if (byChannel.size) {
    console.log('\n=== CHANNELS (note-ons) ===');
    console.log('  ch   notes   velocity           pitch range');
    for (const ch of [...byChannel.keys()].sort((a, b) => a - b)) {
        const notes = byChannel.get(ch);
        const vel = stats(notes.map((n) => n.velocity));
        const pitches = notes.map((n) => n.note);
        console.log(
            `  ${String(ch).padEnd(4)} ${String(notes.length).padStart(5)}`
            + `   ${String(vel.min).padStart(3)}..${String(vel.max).padEnd(3)} (mean ${fmt(vel.mean)})`
            + `   ${pitchName(Math.min(...pitches))}..${pitchName(Math.max(...pitches))}`
        );
    }
}

const durationS = lastTick * secondsPerTick;
const mm = Math.floor(durationS / 60);
const ss = (durationS % 60).toFixed(1).padStart(4, '0');
console.log('\n=== TOTAL ===');
console.log(`  ${totalNotes} note-ons across ${tracks.length} tracks, ${lastTick} ticks, ${mm}:${ss}`);

// ---- collisions (opt-in) --------------------------------------------

if (args.collisions) {
    const seen = new Map();
    let collisions = 0;
    const examples = [];

    tracks.forEach((events, trackIndex) => {
        for (const ev of events) {
            if (ev.kind !== 'noteOn') continue;
            const key = `${ev.absTick}:${ev.channel}:${ev.note}`;
            const prior = seen.get(key);
            if (prior != null && prior !== trackIndex) {
                collisions++;
                if (examples.length < 10) {
                    examples.push(`    tick ${ev.absTick}  ch${ev.channel} ${pitchName(ev.note)}  tracks ${prior}+${trackIndex}`);
                }
            } else if (prior == null) {
                seen.set(key, trackIndex);
            }
        }
    });

    console.log('\n=== COLLISIONS ===');
    console.log(`  ${collisions} same-pitch/same-tick event(s) across different tracks`);
    for (const e of examples) console.log(e);
    if (collisions === 0) {
        console.log('  Apparent doubling is octave doubling or chord tones, not duplicate pitches.');
    }
}

console.log('');
