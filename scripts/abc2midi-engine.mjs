// scripts/abc2midi-engine.mjs
// Render an ABC file to MIDI using the abc2midi binary (external).
//
// Called from runMidi when engine = "abc2midi".
// Handles normalization, subprocess invocation, and cleanup.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { normalizeAbcForEngines } from '../src/song/abc-normalize.mjs';

/**
 * @param {Object} opts
 * @param {string} opts.abcPath          Source ABC file.
 * @param {string} opts.outMidiPath      Where to write the MIDI file.
 * @param {Object<string, number>} opts.programsByVoiceName
 * @param {string} opts.abc2midiPath     Path to abc2midi.exe.
 * @returns {Promise<{midiPath: string}>}
 */
export async function renderWithAbc2Midi({
    abcPath,
    outMidiPath,
    programsByVoiceName = {},
    abc2midiPath,
}) {
    if (!fs.existsSync(abcPath)) {
        throw new Error(`ABC file not found: ${abcPath}`);
    }
    if (!abc2midiPath || !fs.existsSync(abc2midiPath)) {
        throw new Error(`abc2midi not found: ${abc2midiPath}`);
    }

    const source = fs.readFileSync(abcPath, 'utf8');
    const { abc: normalized } = normalizeAbcForEngines(source, programsByVoiceName);

    // abc2midi writes to a file next to the input by default. Write the
    // normalized ABC to a temp file so we don't pollute the song folder.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-abc2midi-'));
    const tmpAbc = path.join(tmpDir, 'normalized.abc');
    fs.writeFileSync(tmpAbc, normalized, 'utf8');

    try {
        await execa(abc2midiPath, [tmpAbc, '-o', outMidiPath], {
            stdio: 'pipe',
        });
    } catch (err) {
        const out = (err.stdout || err.stderr || '').trim();
        throw new Error(
            `abc2midi failed (exit ${err.exitCode ?? '?'}):\n` +
            (out ? out.split('\n').slice(-15).join('\n') : err.message)
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    if (!fs.existsSync(outMidiPath)) {
        throw new Error(`abc2midi did not produce ${outMidiPath}`);
    }

    return { midiPath: outMidiPath };
}