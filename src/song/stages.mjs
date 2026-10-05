// src/song/stages.mjs — one function per stage + the full pipeline.

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { projectRoot } from '../util.mjs';
import { Planner } from './lyrics/planner.mjs';
import { SongWriter } from './lyrics/writer.mjs';
import { SongScorer } from './score/generator.mjs';
import { parseSongMarkdown } from './lyrics/parser.mjs';
import { patchMscz } from './pdf-meta.mjs';

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

export async function runScore(config, songFolder, { dryRun = false } = {}) {
    const scorer = new SongScorer(config);
    return scorer.score(songFolder, { dryRun });
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
            } catch { /* ignore */ }
        }
    }
    if (composer == null) {
        composer = config.render.composer ?? null;
    }

    const root = projectRoot();
    const args = [path.join(root, 'scripts', 'abc2midi.mjs'), abcPath, midiPath];
    if (program != null) args.push('--program', String(program));
    if (tempo != null) args.push('--tempo', String(tempo));
    if (title != null) args.push('--title', String(title));
    if (composer != null) args.push('--composer', String(composer));

    await run('node', args);

    if (!fs.existsSync(midiPath)) {
        throw new Error(`abc2midi did not produce ${midiPath}`);
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
        try { fs.unlinkSync(normMidi); } catch { }
    }
    if (!fs.existsSync(wavPath)) {
        throw new Error(`midi2wav did not produce ${wavPath}`);
    }
    return { wavPath, midiPath };
}

// =====================================================================
// pdf  (score.mid -> score.mscz -> patch -> score.pdf)
// =====================================================================

export async function runPdf(config, songFolder, {
    title,
    composer,
} = {}) {
    const midiPath = path.join(songFolder, 'score.mid');
    const msczPath = path.join(songFolder, 'score.mscz');
    const pdfPath = path.join(songFolder, 'score.pdf');

    if (!fs.existsSync(midiPath)) {
        throw new Error(`Missing score.mid in ${songFolder}`);
    }

    const musescore = config.render.musescorePath;
    if (!musescore) {
        throw new Error('Set render.musescore_path in config.yaml.');
    }
    if (!fs.existsSync(musescore)) {
        throw new Error(`MuseScore not found: ${musescore}`);
    }

    if (title == null) {
        const songPath = path.join(songFolder, 'song.md');
        if (fs.existsSync(songPath)) {
            try {
                const parsed = parseSongMarkdown(fs.readFileSync(songPath, 'utf8'));
                if (parsed.title) title = parsed.title;
            } catch { /* ignore */ }
        }
    }
    if (composer == null) {
        composer = config.render.composer ?? null;
    }

    // --- Step 1: MIDI -> MSCZ ---
    const job1 = path.join(songFolder, '.musescore-1.json');
    fs.writeFileSync(job1, JSON.stringify([{ in: 'score.mid', out: 'score.mscz' }]), 'utf8');
    try {
        await run(musescore, ['-j', job1], { cwd: songFolder });
    } finally {
        try { fs.unlinkSync(job1); } catch { }
    }

    if (!fs.existsSync(msczPath)) {
        throw new Error(`MuseScore did not produce ${msczPath}`);
    }

    // --- Step 2: patch title + composer into the MSCZ XML ---
    await patchMscz(msczPath, { title, composer });

    // --- Step 3: MSCZ -> PDF ---
    const job2 = path.join(songFolder, '.musescore-2.json');
    fs.writeFileSync(job2, JSON.stringify([{ in: 'score.mscz', out: 'score.pdf' }]), 'utf8');
    try {
        await run(musescore, ['-j', job2], { cwd: songFolder });
    } finally {
        try { fs.unlinkSync(job2); } catch { }
    }

    if (!fs.existsSync(pdfPath)) {
        throw new Error(`MuseScore did not produce ${pdfPath}`);
    }

    return { pdfPath, msczPath, midiPath, title, composer };
}

// =====================================================================
// song  (full pipeline)
// =====================================================================

export async function runSong(config, {
    theme, genre, mood,
    dryScore = false,
    keep = false,
    pdf = false,
} = {}) {
    const plan = await runPlan(config, { theme, genre, mood });
    const writer = await runWrite(config, plan);
    await runScore(config, writer.folder, { dryRun: dryScore });
    const midi = await runMidi(config, writer.folder);
    const render = await runRender(config, writer.folder, { keep });

    let pdfResult = null;
    if (pdf) {
        pdfResult = await runPdf(config, writer.folder);
    }

    return {
        ...writer,
        abcPath: path.join(writer.folder, 'score.abc'),
        midiPath: midi.midiPath,
        wavPath: render.wavPath,
        pdfPath: pdfResult?.pdfPath ?? null,
    };
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