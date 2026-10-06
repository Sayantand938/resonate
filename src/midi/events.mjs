// src/midi/events.mjs
// Parse a MIDI file into per-track event lists with absolute tick positions.
//
// This is the one MIDI event reader in the project: the humanizer and every
// tool under tools/ go through it, instead of each walking raw bytes again.
//
// The walker is deliberately strict about structure — it honours running
// status and skips meta/sysex payloads by length so a 0x9n byte inside a text
// payload can never be mistaken for a note-on.

import { isMidi, headerLength, trackChunks } from './chunks.mjs';
import { readVarLen } from './varlen.mjs';

/**
 * @typedef {Object} MidiEvent
 * @property {number} absTick        absolute tick from the start of the track
 * @property {'meta'|'sysex'|'noteOn'|'noteOff'|'channelShort'} kind
 * @property {number} [channel]      0-15, channel-voice events only
 * @property {number} [note]
 * @property {number} [velocity]
 * @property {number} [velocityOffset] byte offset of the velocity field
 * @property {number} [statusByte]   full status byte as written
 * @property {Buffer} [bytes]        verbatim bytes, meta and sysex only
 * @property {Buffer} [data]         payload, channelShort only
 */

/** Header chunk fields: format, declared track count, and ticks per quarter. */
export function readHeader(buffer) {
    if (!isMidi(buffer)) throw new Error('Not a MIDI file.');
    return {
        format: buffer.readUInt16BE(8),
        trackCount: buffer.readUInt16BE(10),
        division: buffer.readUInt16BE(12),
    };
}

function parseTrack(buffer, chunk, trackIndex) {
    const events = [];
    let p = chunk.dataStart;
    let absTick = 0;
    let runningStatus = null;

    while (p < chunk.dataEnd) {
        const delta = readVarLen(buffer, p);
        p = delta.next;
        absTick += delta.value;

        const start = p;
        const status = buffer[p];

        if (status === 0xFF) {
            const lenByte = buffer[p + 2];
            p += 3 + lenByte;
            events.push({ absTick, kind: 'meta', bytes: buffer.subarray(start, p) });
        } else if (status === 0xF0 || status === 0xF7) {
            const lenByte = buffer[p + 1];
            p += 2 + lenByte;
            events.push({ absTick, kind: 'sysex', bytes: buffer.subarray(start, p) });
        } else {
            let typeByte;
            if (status < 0x80) {
                // Running status: reuse the previous status byte.
                if (runningStatus == null) {
                    throw new Error(
                        `Malformed MIDI: data byte 0x${status.toString(16)} in track `
                        + `${trackIndex} at byte ${p} has no preceding status byte.`
                    );
                }
                typeByte = runningStatus;
            } else {
                typeByte = status;
                runningStatus = status;
                p++;
            }
            const type = typeByte & 0xF0;
            const channel = typeByte & 0x0F;

            if (type === 0x90 || type === 0x80) {
                const note = buffer[p];
                const vel = buffer[p + 1];
                // Byte offset of the velocity field, for transforms that
                // rescale velocities in place.
                const velocityOffset = p + 1;
                p += 2;
                // A note-on with velocity 0 is a note-off in disguise.
                const isNoteOn = type === 0x90 && vel > 0;
                events.push({
                    absTick,
                    kind: isNoteOn ? 'noteOn' : 'noteOff',
                    channel, note, velocity: vel, velocityOffset, statusByte: typeByte,
                });
            } else if (type === 0xC0 || type === 0xD0) {
                p += 1;
                events.push({
                    absTick, kind: 'channelShort', channel,
                    statusByte: typeByte, data: buffer.subarray(p - 1, p),
                });
            } else {
                p += 2;
                events.push({
                    absTick, kind: 'channelShort', channel,
                    statusByte: typeByte, data: buffer.subarray(p - 2, p),
                });
            }
        }
    }

    if (p > chunk.dataEnd) {
        throw new Error(
            `Malformed MIDI: an event in track ${trackIndex} declares more bytes `
            + `than the track holds (ran to ${p}, track ends at ${chunk.dataEnd}).`
        );
    }

    return events;
}

/**
 * Parse every track.
 *
 * Throws on structurally broken input rather than silently returning the
 * events it managed to read, so a corrupted file cannot quietly produce a
 * half-processed result.
 *
 * @param {Buffer} buffer
 * @returns {{tracks: MidiEvent[][], headerLength: number, division: number}}
 */
export function parseMidiEvents(buffer) {
    if (!isMidi(buffer)) throw new Error('Not a MIDI file.');

    const chunks = trackChunks(buffer);
    if (chunks.length === 0) throw new Error('No MTrk chunks found.');

    return {
        tracks: chunks.map((t, i) => parseTrack(buffer, t, i)),
        headerLength: headerLength(buffer),
        division: buffer.readUInt16BE(12),
    };
}

// ---------------------------------------------------------------------
// Meta event decoding
// ---------------------------------------------------------------------

/** Meta event sub-type byte (0x03 = track name, 0x51 = tempo, ...). */
export function metaType(event) {
    return event.kind === 'meta' && event.bytes.length >= 3 ? event.bytes[1] : null;
}

const TEXT_META = new Set([0x01, 0x02, 0x03, 0x04, 0x05]);

/** Decode a text meta event (track name, lyric, marker, ...) to a string. */
export function metaText(event) {
    if (event.kind !== 'meta') return null;
    if (!TEXT_META.has(event.bytes[1])) return null;
    const len = event.bytes[2];
    return event.bytes.subarray(3, 3 + len).toString('utf8');
}

/** Decode a set_tempo meta event to microseconds per quarter note. */
export function metaTempo(event) {
    if (metaType(event) !== 0x51) return null;
    return (event.bytes[3] << 16) | (event.bytes[4] << 8) | event.bytes[5];
}

/**
 * First set_tempo in the file, falling back to the MIDI default of
 * 500000 us/quarter (120 BPM). Good enough for reporting a duration; the
 * Python VST renderer resolves tempo the same way.
 *
 * @param {MidiEvent[][]} tracks
 * @returns {{usPerQuarter:number, tick:number, explicit:boolean}}
 */
export function firstTempo(tracks) {
    for (const events of tracks) {
        for (const ev of events) {
            const t = metaTempo(ev);
            if (t != null) return { usPerQuarter: t, tick: ev.absTick, explicit: true };
        }
    }
    return { usPerQuarter: 500_000, tick: 0, explicit: false };
}
