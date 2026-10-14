// src/abc/track-map.mjs
// Work out which MIDI track abcjs emitted for which ABC voice, so each
// voice can be forced onto its own dedicated MIDI channel.
//
// Why this is not trivial: abcjs's output convention is
//
//   track 0          conductor (meta only)
//   tracks 1..N      the N named voices, in order of first appearance
//   track N+1        auto-generated accompaniment (only if the ABC had
//                    chord symbols)
//
// The accompaniment track uses channels 0 and 2, which collides with the
// melody voice. Remapping every voice to its own channel is what makes
// per-voice instrument assignment possible.
//
// The convention is not a documented contract, so this module:
//   - counts voices from the ABC source itself, not from the MIDI
//   - sanity-checks the assumptions it cannot verify, warning on stderr
//   - refuses to map when the input does not match the convention at all
//     (leaving the MIDI unremapped is safer than remapping it wrong)

import { trackChunks } from '../midi/chunks.mjs';
import { parseMidiEvents } from '../midi/events.mjs';

const MAX_CHANNELS = 16;

/**
 * @param {string} abcSource
 * @param {Buffer} midiBuffer   abcjs's raw MIDI output
 * @returns {Object<number, number>}  track index → target channel
 */
export function deriveTrackToChannelMap(abcSource, midiBuffer) {
    const voices = collectVoiceNames(abcSource);
    const voiceCount = voices.length;

    // We parse rather than trust the header's track count: parseMidiEvents
    // throws on structurally broken input, which is exactly the case where
    // we must not proceed with a guessed remap.
    let tracks;
    try {
        ({ tracks } = parseMidiEvents(midiBuffer));
    } catch (err) {
        console.error(
            `[warn] abc-engine: could not parse abcjs MIDI (${err.message}); `
            + 'leaving tracks on their original channels.'
        );
        return {};
    }

    const midiTrackCount = tracks.length;

    // Sanity: the convention assumes track 0 is meta-only. If it holds
    // note events, "tracks 1..N are voices" is false and every channel
    // assignment below is suspect.
    if (trackContainsNotes(tracks[0])) {
        console.error(
            '[warn] abc-engine: track 0 contains note events, but the channel '
            + 'map assumes it is meta-only conductor. Channel assignments may be wrong.'
        );
    }

    const hasAccompaniment = midiTrackCount > voiceCount + 1;
    const map = {};

    // The channel arithmetic below assumes exactly one track per declared
    // voice (plus conductor, plus optional accompaniment). A voice declared
    // in the ABC header but given no notes produces no track, which shifts
    // every subsequent voice onto the wrong channel — silently, because the
    // note data itself is still valid. Warn rather than proceed blind.
    const expectedTracks = 1 + voiceCount + (hasAccompaniment ? 1 : 0);
    if (midiTrackCount !== expectedTracks) {
        console.error(
            `[warn] abc-engine: ABC declares ${voiceCount} voice(s) but abcjs `
            + `emitted ${midiTrackCount} track(s) (expected ${expectedTracks}). `
            + `A voice may be declared but have no notes — channel assignments `
            + `below may be wrong.`
        );
    }

    if (voiceCount > MAX_CHANNELS) {
        console.error(
            `[warn] abc-engine: ${voiceCount} voices in ABC, but MIDI has only `
            + `${MAX_CHANNELS} channels. Voices beyond ${MAX_CHANNELS} will share.`
        );
    }

    const usableVoices = Math.min(voiceCount, MAX_CHANNELS);
    for (let i = 0; i < usableVoices; i++) {
        map[i + 1] = i;
    }

    if (hasAccompaniment) {
        const accompTrackIdx = voiceCount + 1;
        const accompChannel = voiceCount;
        if (accompChannel < MAX_CHANNELS) {
            map[accompTrackIdx] = accompChannel;
        } else {
            console.error(
                '[warn] abc-engine: no free channel for accompaniment; '
                + 'leaving it on its original channels (may collide).'
            );
        }
    }

    warnOnChannelCollisions(map);
    return map;
}

/**
 * Voice names in order of first appearance, from both `V:` header lines and
 * inline `[V:...]` markers.
 *
 * Missing an inline marker here would under-count voices, shifting every
 * subsequent track onto the wrong channel, so both forms have to be checked.
 */
function collectVoiceNames(abcSource) {
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
        // Inline markers can appear multiple times on one line.
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

function trackContainsNotes(events) {
    return events.some((ev) => ev.kind === 'noteOn');
}

/**
 * Two tracks sharing a channel would merge their instruments, which is
 * audible but easy to miss. Warn loudly rather than silently producing a
 * confusing render.
 */
function warnOnChannelCollisions(map) {
    const use = new Map();
    for (const [track, ch] of Object.entries(map)) {
        if (!use.has(ch)) use.set(ch, []);
        use.get(ch).push(track);
    }
    for (const [ch, tracks] of use) {
        if (tracks.length > 1) {
            console.error(
                `[warn] abc-engine: tracks ${tracks.join(', ')} both map to `
                + `channel ${ch}; their instruments will collide.`
            );
        }
    }
}