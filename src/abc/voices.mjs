// src/abc/voices.mjs
// Pair MIDI channels back to the ABC voice that produced them.
//
// The pipeline renders ABC to MIDI through abcjs, which lays out its tracks
// by a convention (track 0 = conductor, tracks 1..N = named voices in order,
// track N+1 = auto-generated accompaniment). track-map.mjs already knows
// that convention. This module adds the missing half: which ABC voice name
// ended up on which channel, so config can say
//
//   Vocal → this VST3
//   Ins → that VST3
//
// instead of
//
//   channel 0 → this VST3
//   channel 1 → that VST3
//
// Channel numbers are an implementation detail of abcjs and shift when
// voices are added or reordered. Voice names come from the score itself
// and stay put.

import { deriveTrackToChannelMap } from './track-map.mjs';

/**
 * Reserved key for abcjs's auto-generated chord track. It has no ABC voice
 * name of its own, so config refers to it by this string.
 */
export const ACCOMPANIMENT_KEY = 'accompaniment';

/**
 * Voice names in ABC source order — the order abcjs emits them as tracks.
 *
 * Both `V:` header lines and inline `[V:...]` markers count. Missing an
 * inline marker would under-count voices and shift every channel below,
 * so both forms are collected.
 */
function voiceNamesInOrder(abcSource) {
    const seen = new Set();
    const order = [];
    const HEADER_RE = /^\s*V:\s*([^\s[\]]+)/;
    const INLINE_RE = /\[V:\s*([^\s\]]+)/g;

    for (const rawLine of String(abcSource).split(/\r?\n/)) {
        const headerMatch = rawLine.match(HEADER_RE);
        if (headerMatch && !seen.has(headerMatch[1])) {
            seen.add(headerMatch[1]);
            order.push(headerMatch[1]);
        }
        let m;
        while ((m = INLINE_RE.exec(rawLine)) !== null) {
            if (!seen.has(m[1])) {
                seen.add(m[1]);
                order.push(m[1]);
            }
        }
    }
    return order;
}

/**
 * Map MIDI channel → ABC voice name.
 *
 * @param {string} abcSource    the ABC text
 * @param {Buffer} midiBuffer   abcjs's raw MIDI output (before title /
 *                              program / channel post-processing)
 * @returns {Object<number, string>}
 *   Example for a two-voice score with chord symbols:
 *     { 0: 'Vocal', 1: 'Ins', 2: 'accompaniment' }
 *   Returns {} if the ABC has no voices or the MIDI cannot be parsed —
 *   in that case callers should fall back to whatever they did before.
 */
export function voiceNamesByChannel(abcSource, midiBuffer) {
    const trackToChannel = deriveTrackToChannelMap(abcSource, midiBuffer);
    if (Object.keys(trackToChannel).length === 0) return {};

    const names = voiceNamesInOrder(abcSource);
    const channelToName = {};

    // Tracks 1..N are the named voices, in the order they first appear
    // in the ABC.
    for (let i = 0; i < names.length; i++) {
        const track = i + 1;
        const channel = trackToChannel[track];
        if (channel != null) channelToName[channel] = names[i];
    }

    // The final track, if one exists past the named voices, is the
    // abcjs-generated chord track from the "C", "G7", "Fmaj7" symbols.
    const accompTrack = names.length + 1;
    if (trackToChannel[accompTrack] != null) {
        channelToName[trackToChannel[accompTrack]] = ACCOMPANIMENT_KEY;
    }

    return channelToName;
}