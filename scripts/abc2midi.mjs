#!/usr/bin/env node
// scripts/abc2midi.mjs — ABC file → MIDI file.
// Dispatches to either abcjs (in-process) or abc2midi (external binary).
//
// Usage:
//   node scripts/abc2midi.mjs <in.abc> <out.mid>
//     [--engine abcjs|abc2midi]
//     [--programs c0:p0,c1:p1]              (per-channel, abcjs)
//     [--voice-programs Vocal:24,Ins:24]    (per-voice, abc2midi)
//     [--tempo BPM] [--title TEXT] [--composer TEXT]
//     [--program N] [--abc2midi <path>]

import fs from 'node:fs';
import path from 'node:path';
import { renderWithAbcjs } from './abcjs-engine.mjs';
import { renderWithAbc2Midi } from './abc2midi-engine.mjs';

function parseArgs(argv) {
    const out = {
        positional: [],
        engine: 'abcjs',
        programs: null,
        voicePrograms: null,
        tempo: null,
        title: null,
        composer: null,
        program: null,
        abc2midiPath: 'C:/Program Files/abcmidi/abc2midi.exe',
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--engine') out.engine = argv[++i];
        else if (a === '--program') out.program = Number(argv[++i]);
        else if (a === '--programs') out.programs = argv[++i];
        else if (a === '--voice-programs') out.voicePrograms = argv[++i];
        else if (a === '--tempo') out.tempo = Number(argv[++i]);
        else if (a === '--title') out.title = argv[++i];
        else if (a === '--composer') out.composer = argv[++i];
        else if (a === '--abc2midi') out.abc2midiPath = argv[++i];
        else out.positional.push(a);
    }
    return out;
}

function parseProgramsByChannel(str) {
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

function parseProgramsByVoice(str) {
    const map = {};
    if (!str) return map;
    for (const pair of str.split(',')) {
        const [name, prog] = pair.split(':').map((s) => s.trim());
        const p = Number(prog);
        if (name && Number.isInteger(p)) map[name] = p;
    }
    return map;
}

const opts = parseArgs(process.argv.slice(2));
const [inPath, outPath] = opts.positional;

if (!inPath || !outPath) {
    console.error('Usage: node scripts/abc2midi.mjs <in.abc> <out.mid> [--engine abcjs|abc2midi] [--programs c0:p0,c1:p1] [--voice-programs Vocal:24,Ins:24] [--tempo BPM] [--title TEXT] [--composer TEXT] [--program N] [--abc2midi <path>]');
    process.exit(1);
}
if (!fs.existsSync(inPath)) {
    console.error(`ABC file not found: ${inPath}`);
    process.exit(1);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });

const programsByChannel = parseProgramsByChannel(opts.programs);
const programsByVoice = parseProgramsByVoice(opts.voicePrograms);

try {
    if (opts.engine === 'abc2midi') {
        await renderWithAbc2Midi({
            abcPath: inPath,
            outMidiPath: outPath,
            programsByVoiceName: programsByVoice,
            abc2midiPath: opts.abc2midiPath,
        });
    } else {
        await renderWithAbcjs({
            abcPath: inPath,
            outMidiPath: outPath,
            programsByChannel,
            title: opts.title,
            composer: opts.composer,
            tempo: opts.tempo,
            program: opts.program,
        });
    }
} catch (err) {
    // Fallback: if abc2midi failed, try abcjs.
    if (opts.engine === 'abc2midi') {
        console.error(`abc2midi failed, falling back to abcjs:`);
        console.error('  ' + err.message.split('\n')[0]);
        await renderWithAbcjs({
            abcPath: inPath,
            outMidiPath: outPath,
            programsByChannel,
            title: opts.title,
            composer: opts.composer,
            tempo: opts.tempo,
            program: opts.program,
        });
    } else {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

console.error(`Wrote ${outPath} (${fs.statSync(outPath).size} bytes)`);