// src/song/stages.mjs — one function per stage + the full pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { projectRoot } from '../util.mjs';
import { Planner } from './lyrics/planner.mjs';
import { SongWriter } from './lyrics/writer.mjs';
import { SongScorer } from './score/generator.mjs';
import { parseSongMarkdown } from './lyrics/parser.mjs';

// Silent execa — output captured, thrown only on failure.
async function run(cmd, args, { cwd } = {}) {
    try {
        await execa(cmd, args, { cwd, stdio: 'pipe' });
    } catch (err) {
        const out = (err.stdout || err.stderr || '').trim();
        throw new Error(
            `${cmd} failed (exit ${err.exitCode ?? '?'})` +
            (out ? `\n${out.split('\n').slice(-8).join('\n')}` : '')
        );
    }
}

// =====================================================================
// plan
// =====================================================================

export async function runPlan(config, { theme, genre, mood } = {}) {
    const planner = new Planner(config);
    return planner.plan(buildSeed({ theme, genre, mood }));
}

// =====================================================================
// write
// =====================================================================

export async function runWrite(config, plan) {
    const writer = new SongWriter(config);
    return writer.write(plan);
}

// =====================================================================
// score  (song.md -> score.abc via YuE2)
// =====================================================================

export async function runScore(config, songFolder) {
    const scorer = new SongScorer(config);
    return scorer.score(songFolder);
}

// =====================================================================
// midi  (score.abc -> score.mid via abcjs)
// =====================================================================

export async function runMidi(config, songFolder, {
    program,
    tempo,
    title,
    composer,
} = {}) {
    const abcPath = path.join(songFolder, 'score.abc');
    const midiPath = path.join(songFolder, 'score.mid');

    if (!fs.existsSync(abcPath)) {
        throw new Error(`Missing score.abc in ${songFolder}`);
    }

    if (title == null) {
        const songPath = path.join(songFolder, 'song.md');
        if (fs.existsSync(songPath)) {
            try {
                const parsed = parseSongMarkdown(fs.readFileSync(songPath, 'utf8'));
                if (parsed.title) title = parsed.title;
            } catch (err) {
                console.error(
                    `[warn] could not read title from ${songPath}: ${err.message}`
                );
            }
        }
    }
    if (composer == null) composer = config.render.composer ?? null;

    const vp = config.render.voicePrograms ?? {};
    const programMap = {
        0: vp.melody ?? 0,
        1: vp.ins ?? 0,
        2: vp.accompaniment ?? 0,
        3: vp.accompaniment2 ?? vp.accompaniment ?? 0,
    };
    const programsStr = Object.entries(programMap)
        .map(([ch, prog]) => `${ch}:${prog}`)
        .join(',');

    const root = projectRoot();
    const args = [path.join(root, 'scripts', 'abc-render.mjs'), abcPath, midiPath];
    if (program != null) args.push('--program', String(program));
    if (tempo != null) args.push('--tempo', String(tempo));
    if (title != null) args.push('--title', String(title));
    if (composer != null) args.push('--composer', String(composer));
    args.push('--programs', programsStr);

    await run('node', args);

    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI render did not produce ${midiPath}`);
    }
    return { midiPath, abcPath, title, composer };
}

// =====================================================================
// render  (score.mid -> song.wav via FluidSynth + ffmpeg)
// =====================================================================

export async function runRender(config, songFolder, {
    soundfont,
    gain,
    lufs,
    keep,
} = {}) {
    const root = projectRoot();
    const midiPath = path.join(songFolder, 'score.mid');
    const wavPath = path.join(songFolder, 'song.wav');

    if (!fs.existsSync(midiPath)) {
        throw new Error(`Missing score.mid in ${songFolder}`);
    }

    const normMidi = path.join(songFolder, '.score.loud.mid');
    await run('node', [
        path.join(root, 'scripts', 'normalize-midi.mjs'),
        midiPath,
        normMidi,
    ]);

    const args = [
        path.join(root, 'scripts', 'midi2wav.mjs'),
        normMidi,
        wavPath,
    ];
    const sf = soundfont ?? config.render.soundfont;
    const g = gain ?? config.render.gain;
    const l = lufs ?? config.render.lufs;

    if (sf) args.push('--sf', sf);
    if (g != null) args.push('--gain', String(g));
    if (l != null) args.push('--lufs', String(l));
    if (keep) args.push('--keep');

    await run('node', args);

    if (!keep) {
        try { fs.unlinkSync(normMidi); } catch { /* ignore */ }
    }
    if (!fs.existsSync(wavPath)) {
        throw new Error(`midi2wav did not produce ${wavPath}`);
    }
    return { wavPath, midiPath };
}

// =====================================================================
// Helpers
// =====================================================================

function buildSeed({ theme, genre, mood }) {
    const parts = [];
    if (theme) parts.push(`Theme: ${theme}`);
    if (genre) parts.push(`Genre: ${genre}`);
    if (mood) parts.push(`Mood: ${mood}`);

    if (parts.length === 0) {
        return (
            'Pick a theme, genre, mood, and story entirely on your own. ' +
            'Surprise me — no user seed provided.'
        );
    }
    return (
        'Use these as the seed for the song. Fill in anything not specified ' +
        'on your own:\n\n' + parts.join('\n')
    );
}