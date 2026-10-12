// src/abc/engine.mjs
// Render ABC notation to a MIDI file using abcjs, in-process.
//
// abcjs is imported lazily: it is a sizeable browser-oriented bundle, and
// commands like `resonate list` should not pay to load it.

import fs from 'node:fs';
import path from 'node:path';
import { injectTitleAndComposer, injectPrograms } from '../midi/meta.mjs';
import { remapChannels } from '../midi/remap.mjs';
import { deriveTrackToChannelMap } from './track-map.mjs';

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
 * @param {Object<number, number>} [opts.trackToChannel]
 *   Override the derived track → channel map. When omitted, the map is
 *   derived from the ABC source and the MIDI abcjs produced (see
 *   track-map.mjs). Pass it explicitly when the caller already knows the
 *   layout — for example, when replaying a previously rendered file.
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
    trackToChannel,
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

    // abcjs emits track 0 as conductor, tracks 1..N for the named voices,
    // and — if the ABC has chord symbols — a final track for the auto-
    // generated accompaniment. That accompaniment reuses channels 0 and 2,
    // which collides with the melody voice. Remap each track to its own
    // dedicated channel before injecting programs.
    const remap = trackToChannel ?? deriveTrackToChannelMap(source, midiBuffer);
    if (Object.keys(remap).length > 0) {
        midiBuffer = remapChannels(midiBuffer, remap);
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
            if (Number.isInteger(ch) && Number.isInteger(prog)) {
                if (ch > 15) {
                    console.error(
                        `[warn] abc-engine: --programs channel ${ch} is out of range (0-15); ignoring.`
                    );
                    continue;
                }
                map[ch] = prog;
            }
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