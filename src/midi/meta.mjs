// src/midi/meta.mjs
// Two independent byte-level operations on a standard MIDI file:
//
//   1. injectTitleAndComposer() — writes track_name + copyright meta into track 0
//   2. injectPrograms()         — writes program_change events at the start of
//                                 each channel used by each non-conductor track
//
// Both walk the file structurally. injectPrograms uses the shared event
// parser (src/midi/events.mjs) rather than re-walking raw bytes, so the
// running-status and meta/sysex handling is the same code every other
// transform in this folder relies on.

import {
    isMidi,
    firstTrackOffset,
    headerLength,
    trackChunks,
    encodeTrackChunk,
} from './chunks.mjs';
import { encodeVarLen } from './varlen.mjs';
import { parseMidiEvents } from './events.mjs';

/** Cap on a single meta text payload, per the MIDI spec (length is 7-bit). */
const META_TEXT_MAX_BYTES = 0x7f;

export function injectTitleAndComposer(midiBuffer, { title, composer } = {}) {
    if (!title && !composer) return midiBuffer;
    if (!isMidi(midiBuffer)) return midiBuffer;

    const headerLen = headerLength(midiBuffer);
    const pos = firstTrackOffset(midiBuffer);
    if (midiBuffer.toString('ascii', pos, pos + 4) !== 'MTrk') return midiBuffer;

    const trackLen = midiBuffer.readUInt32BE(pos + 4);
    const trackStart = pos + 8;
    const trackEnd = trackStart + trackLen;

    const events = [];
    let p = trackStart;
    while (p < trackEnd) {
        let delta = 0, b;
        do { b = midiBuffer[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);

        const start = p;
        const status = midiBuffer[p];

        if (status === 0xFF) {
            const type = midiBuffer[p + 1];
            const len = midiBuffer[p + 2];
            p += 3 + len;
            // Drop any existing track_name / copyright / text — the new
            // values replace them.
            if (type === 0x03 || type === 0x01 || type === 0x02) continue;
            events.push({ delta, bytes: midiBuffer.subarray(start, p) });
        } else if (status === 0xF0 || status === 0xF7) {
            const len = midiBuffer[p + 1];
            p += 2 + len;
            events.push({ delta, bytes: midiBuffer.subarray(start, p) });
        } else {
            const type = status & 0xF0;
            const need = (type === 0xC0 || type === 0xD0) ? 2 : 3;
            p += need;
            events.push({ delta, bytes: midiBuffer.subarray(start, p) });
        }
    }

    const newEvents = [];
    if (title) newEvents.push(metaTextEvent(0x03, title));
    if (composer) newEvents.push(metaTextEvent(0x02, composer));

    for (const ev of events) {
        newEvents.push(encodeVarLen(ev.delta));
        newEvents.push(ev.bytes);
    }

    const hasEot = events.some(
        (ev) => ev.bytes[0] === 0xFF && ev.bytes[1] === 0x2F
    );
    if (!hasEot) newEvents.push(Buffer.from([0x00, 0xFF, 0x2F, 0x00]));

    const data = Buffer.concat(newEvents);

    return Buffer.concat([
        midiBuffer.subarray(0, pos),
        encodeTrackChunk(data),
        midiBuffer.subarray(trackEnd),
    ]);
}

function metaTextEvent(type, text) {
    const payload = Buffer.from(text, 'utf8');
    if (payload.length > META_TEXT_MAX_BYTES) {
        console.error(
            `[warn] meta: text meta 0x${type.toString(16)} is ${payload.length} `
            + `bytes; MIDI caps this at ${META_TEXT_MAX_BYTES}. Truncating.`
        );
    }
    const capped = payload.subarray(0, META_TEXT_MAX_BYTES);
    return Buffer.concat([
        Buffer.from([0x00, 0xFF, type, capped.length]),
        capped,
    ]);
}

/**
 * Insert program_change events at the start of each non-conductor track,
 * one per channel that the track actually uses.
 *
 * This does NOT assume each track uses a single channel. abcjs's
 * chord-following accompaniment writes notes to two channels (typically
 * 0 and 2) so it can stagger chord-tone durations. We inject a program
 * change for every channel we see that has a configured program.
 *
 * @param {Buffer} midiBuffer
 * @param {Object<number, number>} programsByChannel
 *   Map of channel → GM program number. Example:
 *     { 0: 24, 1: 24, 2: 0, 3: 0 }
 *   Channels not listed are left alone.
 * @returns {Buffer}
 */
export function injectPrograms(midiBuffer, programsByChannel = {}) {
    if (!programsByChannel || Object.keys(programsByChannel).length === 0) {
        return midiBuffer;
    }
    if (!isMidi(midiBuffer)) return midiBuffer;

    const headerLen = headerLength(midiBuffer);
    const chunks = trackChunks(midiBuffer);
    if (chunks.length === 0) return midiBuffer;

    // Use the shared parser so the running-status and meta/sysex handling
    // is identical to every other transform.
    let tracks;
    try {
        ({ tracks } = parseMidiEvents(midiBuffer));
    } catch (err) {
        console.error(
            `[warn] meta: could not parse MIDI (${err.message}); `
            + 'skipping program injection.'
        );
        return midiBuffer;
    }

    const out = [midiBuffer.subarray(0, 8 + headerLen)];
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Conductor — meta only, no channels.
        if (i === 0) {
            out.push(midiBuffer.subarray(chunk.start, chunk.dataEnd));
            continue;
        }

        const channels = channelsUsed(tracks[i] ?? []);
        const programEntries = channels
            .filter((ch) => programsByChannel[ch] != null)
            .map((ch) => ({ channel: ch, program: programsByChannel[ch] }));

        if (programEntries.length === 0) {
            out.push(midiBuffer.subarray(chunk.start, chunk.dataEnd));
            continue;
        }

        out.push(insertProgramChanges(midiBuffer, chunk, programEntries));
    }
    return Buffer.concat(out);
}

/** Distinct channels touched by any channel-voice event in a parsed track. */
function channelsUsed(events) {
    const seen = new Set();
    for (const ev of events) {
        if (ev.channel != null) seen.add(ev.channel);
    }
    return [...seen].sort((a, b) => a - b);
}

function insertProgramChanges(midiBuffer, chunk, programEntries) {
    const headerBytes = [];
    for (const { channel, program } of programEntries) {
        headerBytes.push(
            Buffer.from([
                0x00,                       // delta = 0
                0xC0 | (channel & 0x0F),
                program & 0x7F,
            ])
        );
    }
    const data = midiBuffer.subarray(chunk.dataStart, chunk.dataEnd);
    return encodeTrackChunk(Buffer.concat([...headerBytes, data]));
}