// src/midi/normalize.mjs
// Rewrite MIDI note-on velocities into a target range.
//
// Walks the MIDI structure properly (delta-times, meta, sysex, channel events)
// so we only rewrite bytes that are actually note-on velocity fields. A naive
// byte scan could corrupt meta payloads or sysex data that happened to contain
// a 0x9n byte.

import { isMidi, trackChunks } from './chunks.mjs';

/**
 * Two-pass velocity normalization: find every note-on velocity byte, then
 * linearly rescale the source min..max onto targetMin..targetMax.
 *
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

    const tracks = trackChunks(buf);
    if (tracks.length === 0) {
        throw new Error('No MTrk chunks found.');
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
        throw new Error('No note-on events found in the MIDI data.');
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

    return {
        buffer: buf,
        stats: {
            notes: velOffsets.length,
            srcMin,
            srcMax,
            srcMean: Math.round(sum / velOffsets.length),
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
