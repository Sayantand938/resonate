// src/midi/remap.mjs
// Rewrite channel numbers for every event in each track, so that
// each voice has its own dedicated MIDI channel.
//
// Why: abcjs reuses channel 0 across multiple tracks, which makes
// per-track instrument assignment impossible. We force each track
// onto its own channel so program_changes apply cleanly.
//
// No dependencies; operates on raw bytes.

import { isMidi, headerLength, trackChunks, encodeTrackChunk } from './chunks.mjs';

/**
 * @param {Buffer} midiBuffer
 * @param {Object<number, number>} trackToChannel
 *   Map of track index → target channel. Example:
 *     { 1: 0, 2: 1, 3: 2 }
 *   Track 0 (conductor) is never touched.
 * @returns {Buffer}
 */
export function remapChannels(midiBuffer, trackToChannel = {}) {
    if (!trackToChannel || Object.keys(trackToChannel).length === 0) {
        return midiBuffer;
    }
    if (!isMidi(midiBuffer)) return midiBuffer;

    const headerLen = headerLength(midiBuffer);
    const tracks = trackChunks(midiBuffer);
    if (tracks.length === 0) return midiBuffer;

    // Rewrite one track: change every channel-voice event to use targetCh.
    // Program changes are dropped entirely (we'll inject our own later).
    function rewriteTrack(t, targetCh) {
        const out = [];
        let p = t.dataStart;
        while (p < t.dataEnd) {
            // Variable-length delta: capture the original bytes so we can
            // re-emit them exactly.
            const deltaStart = p;
            let delta = 0, b;
            do { b = midiBuffer[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);
            const deltaBytes = midiBuffer.subarray(deltaStart, p);

            const start = p;
            const status = midiBuffer[p];

            // Meta event — copy verbatim.
            if (status === 0xFF) {
                const len = midiBuffer[p + 2];
                p += 3 + len;
                out.push(deltaBytes, midiBuffer.subarray(start, p));
                continue;
            }

            // SysEx — copy verbatim.
            if (status === 0xF0 || status === 0xF7) {
                const len = midiBuffer[p + 1];
                p += 2 + len;
                out.push(deltaBytes, midiBuffer.subarray(start, p));
                continue;
            }

            const type = status & 0xF0;
            const need = (type === 0xC0 || type === 0xD0) ? 2 : 3;
            p += need;

            // Drop program changes entirely. We'll insert ours.
            if (type === 0xC0) continue;

            // Rewrite channel-voice events to use targetCh.
            const rewritten = Buffer.from(midiBuffer.subarray(start, p));
            rewritten[0] = (status & 0xF0) | (targetCh & 0x0F);

            out.push(deltaBytes, rewritten);
        }

        return encodeTrackChunk(Buffer.concat(out));
    }

    // Build output.
    const out = [midiBuffer.subarray(0, 8 + headerLen)];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        const targetCh = trackToChannel[i];

        // Track 0 (conductor) or un-mapped tracks: copy verbatim.
        if (i === 0 || targetCh == null) {
            out.push(midiBuffer.subarray(t.start, t.dataEnd));
            continue;
        }

        out.push(rewriteTrack(t, targetCh));
    }
    return Buffer.concat(out);
}
