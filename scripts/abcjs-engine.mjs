// scripts/abcjs-engine.mjs
// Render an ABC file to MIDI using abcjs (in-process).

import fs from 'node:fs';
import {
    injectTitleAndComposer,
    injectPrograms,
} from '../src/song/midi-meta.mjs';
import { remapChannels } from '../src/song/midi-remap.mjs';

if (typeof globalThis.window === 'undefined') {
    globalThis.window = globalThis;
}

const abcjs = (await import('abcjs')).default;

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
    if (typeof abcjs.synth?.getMidiFile !== 'function') {
        throw new Error('abcjs.synth.getMidiFile is not available.');
    }

    let source = fs.readFileSync(abcPath, 'utf8');

    if (tempo != null) {
        if (/^Q:/m.test(source)) {
            source = source.replace(/^Q:.*$/m, `Q:1/4=${tempo}`);
        } else {
            source = source.replace(/^(X:[^\n]*\n)/m, `$1Q:1/4=${tempo}\n`);
        }
    }

    const midiOptions = {};
    if (Number.isInteger(program)) midiOptions.program = program;

    const htmlArray = abcjs.synth.getMidiFile(source, midiOptions);
    if (!Array.isArray(htmlArray) || htmlArray.length === 0) {
        throw new Error('abcjs did not return any MIDI.');
    }

    let midiBuffer = extractMidiFromHtml(htmlArray[0]);
    midiBuffer = injectTitleAndComposer(midiBuffer, { title, composer });
    midiBuffer = remapChannels(midiBuffer, { 1: 0, 2: 1, 3: 2, 4: 3 });

    if (Object.keys(programsByChannel).length) {
        midiBuffer = injectPrograms(midiBuffer, programsByChannel);
    }

    fs.mkdirSync(require_path_dir(outMidiPath), { recursive: true });
    fs.writeFileSync(outMidiPath, midiBuffer);
    return { midiPath: outMidiPath };
}

// Helpers --------------------------------------------------------------

import path from 'node:path';
function require_path_dir(p) { return path.dirname(p); }

function extractMidiFromHtml(html) {
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