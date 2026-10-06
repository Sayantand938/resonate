#!/usr/bin/env node
// tools/diff-midi.mjs — report what changed between two MIDI files.
//
// Built for verifying humanization: compare score.mid against
// score.human.mid and see exactly how much timing and velocity moved.
//
// Usage:
//   node tools/diff-midi.mjs <before.mid> <after.mid>
//
// Notes are matched per track, per channel+pitch, to the nearest tick. They
// cannot be matched by position: the humanizer re-sorts each track's events
// by their new tick, so note order is not preserved.

import fs from 'node:fs';
import {
    parseMidiEvents,
    readHeader,
    firstTempo,
} from '../src/midi/events.mjs';
import { parseArgs, die } from '../src/cli/args.mjs';

const USAGE = 'node tools/diff-midi.mjs <before.mid> <after.mid>';

const args = parseArgs(process.argv.slice(2));
const [beforePath, afterPath] = args.positional;

if (!beforePath || !afterPath) die(null, USAGE);
for (const p of [beforePath, afterPath]) {
    if (!fs.existsSync(p)) die(`MIDI not found: ${p}`);
}

const beforeBuf = fs.readFileSync(beforePath);
const afterBuf = fs.readFileSync(afterPath);

let before;
let after;
let header;
try {
    before = parseMidiEvents(beforeBuf);
    after = parseMidiEvents(afterBuf);
    header = readHeader(afterBuf);
} catch (err) {
    die(err.message);
}

const noteOns = (events) => events.filter((e) => e.kind === 'noteOn');

const beforeCount = before.tracks.reduce((s, t) => s + noteOns(t).length, 0);
const afterCount = after.tracks.reduce((s, t) => s + noteOns(t).length, 0);

console.log('\n=== DIFF ===');
console.log(`  before   ${beforePath}  (${beforeCount} note-ons)`);
console.log(`  after    ${afterPath}  (${afterCount} note-ons)`);

if (beforeCount !== afterCount) {
    console.log(`\n  WARNING: note-on counts differ — a transform that adds or`);
    console.log('  removes notes cannot be summarised as timing/velocity drift.');
}

/**
 * Pair up note-ons track by track: same channel and pitch, nearest tick
 * first. Returns matched pairs plus counts of anything left over.
 */
function matchNotes() {
    const pairs = [];
    let unmatched = 0;
    const trackCount = Math.min(before.tracks.length, after.tracks.length);

    for (let t = 0; t < trackCount; t++) {
        const aNotes = noteOns(after.tracks[t]);
        const buckets = new Map();
        for (const ev of aNotes) {
            const key = `${ev.channel}:${ev.note}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(ev);
        }

        for (const ev of noteOns(before.tracks[t])) {
            const candidates = buckets.get(`${ev.channel}:${ev.note}`);
            if (!candidates || candidates.length === 0) { unmatched++; continue; }

            let best = 0;
            for (let i = 1; i < candidates.length; i++) {
                const d = Math.abs(candidates[i].absTick - ev.absTick);
                if (d < Math.abs(candidates[best].absTick - ev.absTick)) best = i;
            }
            pairs.push({ track: t, before: ev, after: candidates[best] });
            candidates.splice(best, 1);
        }
    }
    return { pairs, unmatched };
}

const { pairs, unmatched } = matchNotes();

if (pairs.length === 0) die('No note-ons could be matched between the two files.');

if (unmatched) {
    console.log(`\n  WARNING: ${unmatched} note-on(s) in the earlier file have no`);
    console.log('  counterpart of the same channel and pitch — the files are not a');
    console.log('  pure timing/velocity edit of each other.');
}

const { usPerQuarter } = firstTempo(after.tracks);
const msPerTick = (1000 * (usPerQuarter / 1_000_000)) / header.division;

// ---- per-channel deltas ---------------------------------------------

const byChannel = new Map();
for (const { before: x, after: y } of pairs) {
    if (!byChannel.has(y.channel)) byChannel.set(y.channel, []);
    byChannel.get(y.channel).push({
        dTick: y.absTick - x.absTick,
        dVel: y.velocity - x.velocity,
    });
}

const range = (nums) => (nums.length
    ? `${Math.min(...nums)}..${Math.max(...nums)}`
    : '—');
const mean = (nums) => (nums.length
    ? (nums.reduce((s, v) => s + v, 0) / nums.length).toFixed(1)
    : '—');

console.log('\n=== PER CHANNEL ===');
console.log('  ch   notes  timing Δ (ticks)      Δ (ms)        velocity Δ');

for (const ch of [...byChannel.keys()].sort((x, y) => x - y)) {
    const rows = byChannel.get(ch);
    const dTicks = rows.map((r) => r.dTick);
    const dVels = rows.map((r) => r.dVel);

    console.log(
        `  ${String(ch).padEnd(4)} ${String(rows.length).padStart(5)}`
        + `  ${range(dTicks).padEnd(20)}`
        + ` ${`${(Math.min(...dTicks) * msPerTick).toFixed(0)}..${(Math.max(...dTicks) * msPerTick).toFixed(0)}`.padEnd(12)}`
        + ` ${range(dVels)} (mean ${mean(dVels)})`
    );
}

// ---- summary ---------------------------------------------------------

const dTicks = pairs.map((p) => p.after.absTick - p.before.absTick);
const dVels = pairs.map((p) => p.after.velocity - p.before.velocity);
const movedTime = dTicks.filter((d) => d !== 0).length;
const movedVel = dVels.filter((d) => d !== 0).length;
const peakTicks = Math.max(...dTicks.map(Math.abs));
const peakVel = Math.max(...dVels.map(Math.abs));

// ---- chord roll ------------------------------------------------------
// Notes that shared a tick before and no longer do afterwards.

const groups = new Map();
for (const p of pairs) {
    const key = `${p.track}:${p.before.absTick}:${p.before.channel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
}

let chordGroups = 0;
let rolledGroups = 0;
for (const [, group] of groups) {
    if (group.length < 2) continue;
    chordGroups++;
    if (new Set(group.map((p) => p.after.absTick)).size > 1) rolledGroups++;
}

console.log('\n=== SUMMARY ===');
console.log(`  matched              ${pairs.length} note-ons`);
console.log(`  timing changed       ${movedTime} (${((movedTime / pairs.length) * 100).toFixed(0)}%)`
    + `   peak ±${peakTicks} ticks (±${(peakTicks * msPerTick).toFixed(1)} ms)`);
console.log(`  velocity changed     ${movedVel} (${((movedVel / pairs.length) * 100).toFixed(0)}%)`
    + `   peak ±${peakVel}`);
console.log(`  chord groups         ${chordGroups} (${rolledGroups} staggered by the roll)`);
console.log('');
