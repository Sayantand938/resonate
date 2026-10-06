// src/midi/normalize.mjs
// Rewrite MIDI note-on velocities into a target range.
//
// Two-pass: find every note-on velocity field, then linearly rescale the
// source min..max onto targetMin..targetMax.
//
// The walk comes from src/midi/events.mjs, so only bytes that really are
// note-on velocity fields are touched. A naive byte scan would corrupt meta
// payloads or sysex data that happened to contain a 0x9n byte, and a
// hand-rolled walker that does not honour running status silently stops
// early and half-normalizes the file.

import { isMidi } from './chunks.mjs';
import { parseMidiEvents } from './events.mjs';

/**
 * @param {Buffer} inputBuffer
 * @param {Object} [opts]
 * @param {number} [opts.targetMin=96]
 * @param {number} [opts.targetMax=112]
 * @returns {{buffer: Buffer, stats: Object}}
 */
export function normalizeMidiBuffer(inputBuffer, {
    targetMin = 96,
    targetMax = 112,
} = {}) {
    if (!Number.isFinite(targetMin) || !Number.isFinite(targetMax) || targetMin > targetMax) {
        throw new Error(`Invalid velocity range: ${targetMin}..${targetMax}`);
    }
    if (!isMidi(inputBuffer)) {
        throw new Error('Not a MIDI file (missing MThd header).');
    }

    // Copy: the caller's buffer is not ours to mutate in place.
    const buf = Buffer.from(inputBuffer);
    const { tracks } = parseMidiEvents(buf);

    const noteOns = tracks.flat().filter((ev) => ev.kind === 'noteOn');
    if (noteOns.length === 0) {
        throw new Error('No note-on events found in the MIDI data.');
    }

    // Pass 1 — source range.
    let srcMin = 128, srcMax = 0, sum = 0;
    for (const ev of noteOns) {
        if (ev.velocity < srcMin) srcMin = ev.velocity;
        if (ev.velocity > srcMax) srcMax = ev.velocity;
        sum += ev.velocity;
    }
    const srcRange = srcMax - srcMin || 1;
    const dstRange = targetMax - targetMin;

    // Pass 2 — rewrite in place.
    for (const ev of noteOns) {
        const scaled = Math.round(
            targetMin + ((ev.velocity - srcMin) / srcRange) * dstRange
        );
        buf[ev.velocityOffset] = Math.max(1, Math.min(127, scaled));
    }

    return {
        buffer: buf,
        stats: {
            notes: noteOns.length,
            srcMin,
            srcMax,
            srcMean: Math.round(sum / noteOns.length),
            targetMin,
            targetMax,
        },
    };
}

/** One-line human summary, used by the CLI wrapper. */
export function formatNormalizeStats(stats) {
    return `normalize-midi: ${stats.notes} notes, `
        + `src ${stats.srcMin}..${stats.srcMax} (mean ${stats.srcMean}) `
        + `-> ${stats.targetMin}..${stats.targetMax}`;
}
