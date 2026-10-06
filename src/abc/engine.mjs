// src/abc/engine.mjs
// Render ABC notation to a MIDI file using abcjs, in-process.
//
// abcjs is imported lazily: it is a sizeable browser-oriented bundle, and
// commands like `resonate list` should not pay to load it.

import fs from 'node:fs';
import path from 'node:path';
import { injectTitleAndComposer, injectPrograms } from '../midi/meta.mjs';
import { remapChannels } from '../midi/remap.mjs';

let _abcjs = null;

async function loadAbcjs() {
    if (_abcjs) return _abcjs;
    // abcjs expects a browser-ish global; give it one before the import.
    if (typeof globalThis.window === 'undefined') {
        globalThis.window = globalThis;
    }
    _abcjs = (await import('abcjs')).default;
    return _abcjs;
}

/**
 * @param {Object} opts
 * @param {string} opts.abcPath
 * @param {string} opts.outMidiPath
 * @param {Object<number, number>} opts.programsByChannel
 * @param {string} [opts.title]
 * @param {string} [opts.composer]
 * @param {number} [opts.tempo]
 * @param {number} [opts.program]
 * @returns {Promise<{midiPath: string}>}
 */
export async function renderWithAbcjs({
    abcPath,
    outMidiPath,
    programsByChannel = {},
    title,
    composer,
    tempo,
    program,
}) {
    if (!fs.existsSync(abcPath)) {
        throw new Error(`ABC file not found: ${abcPath}`);
    }

    const abcjs = await loadAbcjs();
    if (typeof abcjs.synth?.getMidiFile !== 'function') {
        throw new Error('abcjs.synth.getMidiFile is not available.');
    }

    const source = fs.readFileSync(abcPath, 'utf8');

    const htmlArray = await abcjsMidiHtml(source, { tempo, program });
    if (!Array.isArray(htmlArray) || htmlArray.length === 0) {
        throw new Error('abcjs did not return any MIDI.');
    }

    let midiBuffer = midiFromAbcjsHtml(htmlArray[0]);
    midiBuffer = injectTitleAndComposer(midiBuffer, { title, composer });

    // Derive the track → channel remap from the ABC source and the MIDI
    // buffer abcjs produced. abcjs emits track 0 as conductor, tracks 1..N
    // for the named voices, and — if the ABC has chord symbols — a final
    // track for auto-generated accompaniment. That accompaniment uses
    // channels 0 and 2 by default, which collides with the melody voice.
    // We remap every track to its own dedicated channel.
    const trackToChannel = deriveTrackToChannelMap(source, midiBuffer);
    if (Object.keys(trackToChannel).length > 0) {
        midiBuffer = remapChannels(midiBuffer, trackToChannel);
    }

    if (Object.keys(programsByChannel).length) {
        midiBuffer = injectPrograms(midiBuffer, programsByChannel);
    }

    fs.mkdirSync(path.dirname(outMidiPath), { recursive: true });
    fs.writeFileSync(outMidiPath, midiBuffer);
    return { midiPath: outMidiPath };
}

// Helpers --------------------------------------------------------------

/**
 * Parse a `--programs` CLI spec into a channel → GM program map.
 *
 * Accepts either explicit pairs or bare positions:
 *   "0:24,1:0,2:0"   → { 0: 24, 1: 0, 2: 0 }
 *   "24,0,0"         → { 0: 24, 1: 0, 2: 0 }
 *
 * @param {string} [str]
 * @returns {Object<number, number>}
 */
export function parseProgramsSpec(str) {
    const map = {};
    if (!str) return map;

    if (str.includes(':')) {
        for (const pair of str.split(',')) {
            const [ch, prog] = pair.split(':').map((s) => Number(s.trim()));
            if (Number.isInteger(ch) && Number.isInteger(prog)) map[ch] = prog;
        }
    } else {
        str.split(',').forEach((p, i) => {
            const prog = Number(p.trim());
            if (Number.isInteger(prog)) map[i] = prog;
        });
    }
    return map;
}

/**
 * Build the { trackIndex → channel } map for the given ABC source and
 * the MIDI buffer abcjs produced from it.
 *
 * Track 0: conductor — never remapped.
 * Tracks 1..N: named voices, in order of first appearance. Each gets
 *   channel 0..N-1.
 * Track N+1 (if present): abcjs's auto-generated accompaniment. Gets
 *   channel N — the next free channel.
 *
 * @param {string} abcSource
 * @param {Buffer} midiBuffer
 * @returns {Object<number, number>}
 */
function deriveTrackToChannelMap(abcSource, midiBuffer) {
    const seen = new Set();
    const order = [];

    for (const rawLine of String(abcSource).split(/\r?\n/)) {
        const m = rawLine.match(/^\s*V:\s*([^\s\[\]]+)/);
        if (!m) continue;
        const name = m[1];
        if (seen.has(name)) continue;
        seen.add(name);
        order.push(name);
    }

    const voiceCount = order.length;
    const midiTrackCount = countMidiTracks(midiBuffer);
    const hasAccompaniment = midiTrackCount > voiceCount + 1;

    const map = {};
    const maxChannels = 16;

    const usableVoices = Math.min(voiceCount, maxChannels);
    if (voiceCount > maxChannels) {
        console.error(
            `[warn] abc-engine: ${voiceCount} voices in ABC, but MIDI ` +
            `has only ${maxChannels} channels. Voices beyond ${maxChannels} ` +
            `will share channels with earlier voices.`
        );
    }
    for (let i = 0; i < usableVoices; i++) {
        map[i + 1] = i;
    }

    if (hasAccompaniment) {
        const accompTrackIdx = voiceCount + 1;
        const accompChannel = voiceCount;
        if (accompChannel < maxChannels) {
            map[accompTrackIdx] = accompChannel;
        } else {
            console.error(
                `[warn] abc-engine: no free channel for accompaniment; ` +
                `leaving it on its original channels (may collide).`
            );
        }
    }

    return map;
}

function countMidiTracks(midiBuffer) {
    if (midiBuffer.length < 14) return 0;
    if (midiBuffer.toString('ascii', 0, 4) !== 'MThd') return 0;
    return midiBuffer.readUInt16BE(10);
}

/**
 * Run abcjs over ABC source and return its raw output entries.
 *
 * Exposed so tools/abcjs-debug.mjs can inspect what abcjs produced *before*
 * the title/program/channel post-processing below.
 *
 * @param {string} abcSource
 * @param {{tempo?:number, program?:number}} [opts]
 * @returns {Promise<string[]>}
 */
export async function abcjsMidiHtml(abcSource, { tempo, program } = {}) {
    const abcjs = await loadAbcjs();

    let source = abcSource;
    if (tempo != null) {
        if (/^Q:/m.test(source)) {
            source = source.replace(/^Q:.*$/m, `Q:1/4=${tempo}`);
        } else {
            source = source.replace(/^(X:[^\n]*\n)/m, `$1Q:1/4=${tempo}\n`);
        }
    }

    const midiOptions = {};
    if (Number.isInteger(program)) midiOptions.program = program;

    return abcjs.synth.getMidiFile(source, midiOptions);
}

/** Decode one abcjs output entry into a MIDI buffer. */
export function midiFromAbcjsHtml(html) {
    const m = html.match(/href\s*=\s*"data:audio\/midi,([^"]*)"/i);
    if (!m) throw new Error('Could not find MIDI data URL in abcjs output.');
    return percentDecodeToBuffer(m[1]);
}

function percentDecodeToBuffer(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        const ch = str[i];
        if (ch === '%' && i + 2 < str.length + 1) {
            const hex = str.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
                bytes.push(parseInt(hex, 16));
                i += 2;
                continue;
            }
        }
        bytes.push(ch.charCodeAt(0) & 0xff);
    }
    return Buffer.from(bytes);
}
