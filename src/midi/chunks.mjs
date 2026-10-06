// src/midi/chunks.mjs
// Raw-byte structure helpers shared by every MIDI transform in this folder.
//
// A standard MIDI file is: "MThd" + length + header data, followed by one
// or more "MTrk" + length + event-data chunks. Everything here works on
// Buffers and never parses musical meaning — see the sibling modules for
// that.

export const MIDI_HEADER = 'MThd';
export const TRACK_HEADER = 'MTrk';

/** A MIDI file must be at least 14 bytes and start with "MThd". */
export function isMidi(buffer) {
    return buffer.length >= 14
        && buffer.toString('ascii', 0, 4) === MIDI_HEADER;
}

/** Byte length of the header chunk's data (excludes the 8-byte chunk header). */
export function headerLength(buffer) {
    return buffer.readUInt32BE(4);
}

/** Offset of the first MTrk chunk. */
export function firstTrackOffset(buffer) {
    return 8 + headerLength(buffer);
}

/**
 * Byte ranges of every MTrk chunk in the file.
 *
 * @returns {Array<{start:number, dataStart:number, dataEnd:number}>}
 *   `start` is the offset of the "MTrk" magic; `dataStart`/`dataEnd` bound
 *   the event data only.
 */
export function trackChunks(buffer) {
    const chunks = [];
    let pos = firstTrackOffset(buffer);

    while (pos + 8 <= buffer.length) {
        if (buffer.toString('ascii', pos, pos + 4) !== TRACK_HEADER) break;
        const len = buffer.readUInt32BE(pos + 4);
        chunks.push({ start: pos, dataStart: pos + 8, dataEnd: pos + 8 + len });
        pos = pos + 8 + len;
    }
    return chunks;
}

/** Wrap event data in a fresh MTrk chunk header with the correct length. */
export function encodeTrackChunk(data) {
    const header = Buffer.alloc(8);
    header.write(TRACK_HEADER, 0, 'ascii');
    header.writeUInt32BE(data.length, 4);
    return Buffer.concat([header, data]);
}
