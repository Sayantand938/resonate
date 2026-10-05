// src/song/midi-meta.mjs
// Two independent byte-level operations on a standard MIDI file:
//
//   1. injectTitleAndComposer() — writes track_name + copyright meta into track 0
//   2. injectPrograms()         — writes a program_change event at the start of
//                                 each non-conductor track, based on channel
//
// Both walk the raw MIDI bytes; no dependencies.

export function injectTitleAndComposer(midiBuffer, { title, composer } = {}) {
    if (!title && !composer) return midiBuffer;
    if (midiBuffer.length < 14) return midiBuffer;
    if (midiBuffer.toString('ascii', 0, 4) !== 'MThd') return midiBuffer;

    const headerLen = midiBuffer.readUInt32BE(4);
    const pos = 8 + headerLen;
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
    const metaText = (t, text) => {
        const payload = Buffer.from(text, 'utf8');
        return Buffer.concat([Buffer.from([0x00, 0xFF, t, payload.length]), payload]);
    };

    if (title) newEvents.push(metaText(0x03, title));
    if (composer) newEvents.push(metaText(0x02, composer));

    for (const ev of events) {
        newEvents.push(encodeVarLen(ev.delta));
        newEvents.push(ev.bytes);
    }

    const hasEot = events.some(
        (ev) => ev.bytes[0] === 0xFF && ev.bytes[1] === 0x2F
    );
    if (!hasEot) newEvents.push(Buffer.from([0x00, 0xFF, 0x2F, 0x00]));

    const data = Buffer.concat(newEvents);
    const hdr = Buffer.alloc(8);
    hdr.write('MTrk', 0, 'ascii');
    hdr.writeUInt32BE(data.length, 4);

    return Buffer.concat([
        midiBuffer.subarray(0, pos),
        hdr,
        data,
        midiBuffer.subarray(trackEnd),
    ]);
}

/**
 * Insert a program_change event at the start of each non-conductor track.
 *
 * @param {Buffer} midiBuffer
 * @param {Object<number, number>} programsByChannel
 *   Map of channel → GM program number. Example:
 *     { 0: 24, 1: 24, 2: 0 }
 *   Channels not listed are left alone.
 * @returns {Buffer}
 */
export function injectPrograms(midiBuffer, programsByChannel = {}) {
    if (!programsByChannel || Object.keys(programsByChannel).length === 0) {
        return midiBuffer;
    }
    if (midiBuffer.length < 14) return midiBuffer;
    if (midiBuffer.toString('ascii', 0, 4) !== 'MThd') return midiBuffer;

    const headerLen = midiBuffer.readUInt32BE(4);
    let pos = 8 + headerLen;

    // Collect all MTrk chunk offsets.
    const tracks = [];
    while (pos + 8 <= midiBuffer.length) {
        if (midiBuffer.toString('ascii', pos, pos + 4) !== 'MTrk') break;
        const len = midiBuffer.readUInt32BE(pos + 4);
        tracks.push({
            start: pos,
            dataStart: pos + 8,
            dataEnd: pos + 8 + len,
        });
        pos = pos + 8 + len;
    }

    if (tracks.length === 0) return midiBuffer;

    // Determine the primary channel for each track by scanning its events.
    // We pick the first channel seen on a note-on event.
    function primaryChannel(t) {
        let p = t.dataStart;
        let sawChannel = null;
        while (p < t.dataEnd) {
            let delta = 0, b;
            do { b = midiBuffer[p++]; delta = (delta << 7) | (b & 0x7f); } while (b & 0x80);

            const status = midiBuffer[p];

            if (status === 0xFF) {
                const len = midiBuffer[p + 2];
                p += 3 + len;
            } else if (status === 0xF0 || status === 0xF7) {
                const len = midiBuffer[p + 1];
                p += 2 + len;
            } else {
                const type = status & 0xF0;
                const ch = status & 0x0F;
                const need = (type === 0xC0 || type === 0xD0) ? 2 : 3;
                if (type === 0x90 && sawChannel == null) {
                    sawChannel = ch;
                }
                p += need;
            }
        }
        return sawChannel;
    }

    // Rewrite a track by prepending a program_change event.
    function rewriteTrack(t, program, channel) {
        const newProgramChange = Buffer.from([
            0x00,                      // delta = 0
            0xC0 | (channel & 0x0F),   // program change on this channel
            program & 0x7F,            // GM program number
        ]);
        const data = midiBuffer.subarray(t.dataStart, t.dataEnd);
        const newData = Buffer.concat([newProgramChange, data]);
        const hdr = Buffer.alloc(8);
        hdr.write('MTrk', 0, 'ascii');
        hdr.writeUInt32BE(newData.length, 4);
        return Buffer.concat([hdr, newData]);
    }

    // Build output: header + rewritten tracks.
    const out = [midiBuffer.subarray(0, 8 + headerLen)];
    for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        // Skip track 0 (conductor) — no notes, no program needed.
        if (i === 0) {
            out.push(midiBuffer.subarray(t.start, t.dataEnd));
            continue;
        }
        const ch = primaryChannel(t);
        if (ch == null || programsByChannel[ch] == null) {
            out.push(midiBuffer.subarray(t.start, t.dataEnd));
            continue;
        }
        out.push(rewriteTrack(t, programsByChannel[ch], ch));
    }
    return Buffer.concat(out);
}

// ---------------------------------------------------------------------

function encodeVarLen(n) {
    if (n < 0) n = 0;
    const out = [n & 0x7f];
    n >>= 7;
    while (n > 0) {
        out.unshift((n & 0x7f) | 0x80);
        n >>= 7;
    }
    return Buffer.from(out);
}