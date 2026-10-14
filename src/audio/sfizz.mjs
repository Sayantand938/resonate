// src/audio/sfizz.mjs
// MIDI file → WAV through one or more SFZ soundfonts, via the sfizz_render CLI.
//
// sfizz_render takes one SFZ per invocation and renders every MIDI channel
// through it, so a multi-voice song needs one invocation per SFZ, each fed a
// temp MIDI containing only that voice's channels, then a mix.
//
// In practice, renderWithBackend calls this either:
//   - once with all routes, when every route uses sfizz (the fast path), or
//   - once per route with a single-route array, when the song spans engines.
// Both are handled below; a single route takes a shortcut with no temp files.
//
// Pure renderer: it does not set output loudness. Level is decided by
// src/audio/loudness.mjs and applied by the caller, same as the VST3 path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parseMidiEvents } from '../midi/events.mjs';
import { isMidi, headerLength, encodeTrackChunk } from '../midi/chunks.mjs';
import { encodeVarLen } from '../midi/varlen.mjs';
import { mixWavs } from './mix.mjs';

/**
 * Write a copy of `midiBuffer` containing only the given channels.
 *
 * Track 0 (conductor) is always copied verbatim — it holds tempo and time
 * signature, which every render needs. Every other track's events are
 * filtered: channel-voice events for the wanted channels are kept, meta and
 * sysex events are kept, channel events for other channels are dropped.
 *
 * When `channels` is null or empty, the buffer is returned unchanged.
 */
export function extractChannels(midiBuffer, channels) {
    if (!channels || channels.length === 0) return midiBuffer;
    if (!isMidi(midiBuffer)) return midiBuffer;

    const wanted = new Set(channels);
    const { tracks } = parseMidiEvents(midiBuffer);
    const headerLen = headerLength(midiBuffer);

    const out = [midiBuffer.subarray(0, 8 + headerLen)];

    tracks.forEach((events, trackIndex) => {
        // Track 0 is the conductor: always verbatim.
        if (trackIndex === 0) {
            out.push(reencode(events));
            return;
        }

        const kept = events.filter((ev) => {
            if (ev.kind === 'meta' || ev.kind === 'sysex') return true;
            if (ev.channel == null) return true;
            return wanted.has(ev.channel);
        });

        // Drop empty tracks entirely rather than writing zero-event MTrk
        // chunks — sfizz behaves better with a clean track list.
        if (kept.length === 0) return;
        out.push(reencode(kept));
    });

    return Buffer.concat(out);
}

/** Re-encode a parsed event list back into an MTrk chunk. */
function reencode(events) {
    const out = [];
    let lastTick = 0;

    for (const ev of events) {
        const delta = Math.max(0, ev.absTick - lastTick);
        lastTick = ev.absTick;
        out.push(encodeVarLen(delta));

        if (ev.kind === 'meta' || ev.kind === 'sysex') {
            out.push(ev.bytes);
        } else if (ev.kind === 'noteOn') {
            out.push(Buffer.from([ev.statusByte, ev.note & 0x7F, ev.velocity & 0x7F]));
        } else if (ev.kind === 'noteOff') {
            out.push(Buffer.from([ev.statusByte, ev.note & 0x7F, ev.velocity & 0x7F]));
        } else if (ev.kind === 'channelShort') {
            out.push(Buffer.from([ev.statusByte]));
            out.push(ev.data);
        }
    }

    out.push(Buffer.from([0x00, 0xFF, 0x2F, 0x00]));
    return encodeTrackChunk(Buffer.concat(out));
}

/**
 * @param {Object} opts
 * @param {string} opts.midiPath
 * @param {string} opts.wavPath
 * @param {Array<{channels:number[], sfz:string, gain?:number}>} opts.routes
 * @param {number} [opts.sampleRate=44100]
 * @param {string} [opts.sfizzBin='sfizz_render']
 * @param {boolean} [opts.silent=false]
 * @returns {Promise<{wavPath:string}>}
 */
export async function renderMidiToWavSfizz({
    midiPath,
    wavPath,
    routes,
    sampleRate = 44100,
    sfizzBin = 'sfizz_render',
    silent = false,
}) {
    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI not found: ${midiPath}`);
    }
    if (!Array.isArray(routes) || routes.length === 0) {
        throw new Error('Routes must be a non-empty array.');
    }
    for (let i = 0; i < routes.length; i++) {
        const r = routes[i];
        if (!Array.isArray(r.channels) || !r.sfz) {
            throw new Error(`Route ${i} must have "channels" (array) and "sfz" (string).`);
        }
        if (!fs.existsSync(r.sfz)) {
            throw new Error(`Route ${i} SFZ not found: ${r.sfz}`);
        }
    }

    // ---- single route: render the whole MIDI through it directly ----
    //
    // This is the path renderWithBackend uses in the multi-engine case
    // (one route per call), and in the single-engine case when a song has
    // exactly one sfizz voice. No temp files, no mix — the caller handles
    // gain and (if there are sibling voices) mixes the result.
    if (routes.length === 1) {
        const r = routes[0];
        await runSfizz({
            sfizzBin,
            sfz: r.sfz,
            midiPath,
            wavPath,
            sampleRate,
            silent,
        });
        return { wavPath };
    }

    // ---- multiple routes: one sfizz_render per route, then mix ----
    //
    // Only reached when renderWithBackend is called with several sfizz
    // routes at once (all-sfizz songs). Each route gets a channel-filtered
    // MIDI, its own sfizz_render invocation, and its own gain at the mix.
    const midiBuffer = fs.readFileSync(midiPath);
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-sfizz-'));
    const parts = [];
    try {
        for (let i = 0; i < routes.length; i++) {
            const r = routes[i];
            const partMidi = path.join(tmpDir, `route-${i}.mid`);
            const partWav = path.join(tmpDir, `route-${i}.wav`);

            fs.writeFileSync(partMidi, extractChannels(midiBuffer, r.channels));

            await runSfizz({
                sfizzBin,
                sfz: r.sfz,
                midiPath: partMidi,
                wavPath: partWav,
                sampleRate,
                silent,
            });

            parts.push({ wavPath: partWav, gain: r.gain ?? 1.0 });
        }

        await mixWavs(parts, wavPath, { sampleRate, silent });
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(wavPath)) {
        throw new Error(`sfizz render did not produce ${wavPath}`);
    }
    return { wavPath };
}

async function runSfizz({ sfizzBin, sfz, midiPath, wavPath, sampleRate, silent }) {
    const args = [
        '--sfz', sfz,
        '--midi', midiPath,
        '--wav', wavPath,
        '--samplerate', String(sampleRate),
    ];

    try {
        await execa(sfizzBin, args, {
            stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'],
        });
    } catch (err) {
        throw new Error(
            `sfizz_render failed (exit ${err.exitCode ?? '?'}): `
            + (err.stderr || err.message || '').split('\n')[0]
        );
    }

    if (!fs.existsSync(wavPath)) {
        throw new Error(`sfizz_render did not produce ${wavPath}`);
    }
}