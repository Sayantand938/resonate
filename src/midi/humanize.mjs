// src/midi/humanize.mjs
// Rewrite a MIDI buffer to add subtle timing jitter, velocity jitter, and
// chord roll — the difference between a mechanical and a played feel.
//
// IMPORTANT: the order in which `rng()` is consumed is part of the output
// contract. With a fixed non-zero seed the result is reproducible, so any
// change to the loop structure below changes every rendered song.

import { isMidi, headerLength, encodeTrackChunk } from './chunks.mjs';
import { encodeVarLen } from './varlen.mjs';
import { parseMidiEvents, firstTempo } from './events.mjs';

/**
 * Deterministic PRNG (mulberry32) when seeded, `Math.random` when not.
 *
 * seed 0 means "no seed" — a fresh random result on every run.
 */
export function makeRng(seed) {
    if (!seed) return Math.random;
    let a = seed >>> 0;
    return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {Buffer} inputBuffer
 * @param {Object} [opts]
 * @param {number} [opts.timingMs=15]   max timing jitter per note, ± ms
 * @param {number} [opts.velocity=8]    max velocity jitter per note, ±
 * @param {number} [opts.rollMs=12]     stagger between same-tick chord notes, ms
 * @param {'up'|'down'} [opts.rollOrder='up']
 * @param {number} [opts.minVel=40]
 * @param {number} [opts.maxVel=115]
 * @param {number} [opts.seed=0]        0 = random each run
 * @returns {{buffer: Buffer, stats: Object}}
 */
export function humanizeMidiBuffer(inputBuffer, {
    timingMs = 15,
    velocity = 8,
    rollMs = 12,
    rollOrder = 'up',
    minVel = 40,
    maxVel = 115,
    seed = 0,
} = {}) {
    if (!isMidi(inputBuffer)) {
        throw new Error('Not a MIDI file.');
    }

    const buf = Buffer.from(inputBuffer);
    const headerLen = headerLength(buf);
    const division = buf.readUInt16BE(12);

    const rng = makeRng(seed);

    // Shared walker (src/midi/events.mjs) — see the note at the top of this
    // file: the RNG is consumed in track/event order, so the parse order is
    // part of the output contract.
    const { tracks: parsed } = parseMidiEvents(buf);

    // Convert the millisecond settings using the file's actual tempo. The
    // first version of this hardcoded 500 ms/beat (120 BPM), so at 70 BPM a
    // "15 ms" jitter was really 25 ms -- 71% stronger than configured, and
    // worse the slower the song.
    const { usPerQuarter } = firstTempo(parsed);
    const msPerTick = (usPerQuarter / 1000) / division;
    const msToTicks = (ms) => Math.round(ms / msPerTick);

    const maxTimingTicks = msToTicks(timingMs);
    const rollTicks = msToTicks(rollMs);
    // One walk step of max/3 reaches the bound in roughly ten notes.
    const driftStepTicks = maxTimingTicks / 3;

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
            if (rollOrder === 'down') group.sort((a, b) => b.note - a.note);
            else group.sort((a, b) => a.note - b.note);
            for (let i = 0; i < group.length; i++) group[i].rollOffsetTicks = i * rollTicks;
        }

        // Timing drifts as a bounded random walk rather than independent
        // per-note noise. A player pushes and pulls a phrase as a unit;
        // uncorrelated jitter on every note is what makes a part read as an
        // unsteady beginner. Reset per track so the parts still start
        // together.
        let drift = 0;
        for (const ev of events) {
            if (ev.kind !== 'noteOn') continue;
            if (maxTimingTicks > 0) {
                drift += (rng() * 2 - 1) * driftStepTicks;
                drift = Math.max(-maxTimingTicks, Math.min(maxTimingTicks, drift));
            }
            const jitter = Math.round(drift);
            const roll = ev.rollOffsetTicks ?? 0;
            ev.newTimingOffset = jitter + roll;
            if (velocity > 0) {
                const dv = Math.round((rng() * 2 - 1) * velocity);
                ev.newVelocity = Math.max(minVel, Math.min(maxVel, ev.velocity + dv));
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

    const trackBuffers = parsed.map((events) => encodeTrackChunk(encodeTrack(events)));
    const outBuf = Buffer.concat([buf.subarray(0, 8 + headerLen), ...trackBuffers]);

    let noteCount = 0, chordCount = 0;
    for (let ti = 1; ti < parsed.length; ti++) {
        for (const ev of parsed[ti]) {
            if (ev.kind === 'noteOn') {
                noteCount++;
                if (ev.rollOffsetTicks) chordCount++;
            }
        }
    }

    return {
        buffer: outBuf,
        stats: {
            notes: noteCount,
            chords: chordCount,
            maxTimingTicks,
            timingMs,
            velocity,
            rollTicks,
            rollMs,
            rollOrder,
        },
    };
}

/** One-line human summary, used by the CLI wrapper. */
export function formatHumanizeStats(stats) {
    return `humanize-midi: ${stats.notes} notes, ${stats.chords} chord-rolled, `
        + `timing ±${stats.maxTimingTicks}t (±${stats.timingMs}ms), `
        + `vel ±${stats.velocity}, roll ${stats.rollTicks}t (${stats.rollMs}ms, ${stats.rollOrder})`;
}
