// src/song/midi-meta.mjs
// Inject title (track_name) and composer (copyright) into track 0 of a
// standard MIDI file. No dependencies; operates on raw bytes.
//
// Note: this does NOT control PDF headers — MuseScore reads staff labels
// from MIDI track names, and page headers from .mscz XML only. This
// injection is for DAWs / players that show MIDI file metadata.

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