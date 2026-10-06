// src/song/pipeline.mjs
// Stage-scoped pipeline functions. Each stage takes an OPTIONAL folder;
// when omitted, it iterates over every song in songs/.
//
// Every stage:
//   - skips songs whose output already exists (unless force=true)
//   - skips songs whose input is missing (with a reason)
//   - reports progress via onProgress callback
//   - returns an array of result objects
//
// Progress events:
//   { phase: 'start'|'done'|'skip'|'fail', stage, folder, label?, result? }
//
// `stage` is set on every event by the stage runner, so downstream
// consumers (the CLI) can prefix batch output with the stage name.

import fs from 'node:fs';
import path from 'node:path';
import { findSongFolders } from './paths.mjs';
import {
    runPlan, runWrite, runScore, runMidi, runRender, runVideo, runTranscribe,
} from './stages.mjs';
import { findThumbnail, VIDEO_FILENAME } from '../video/generator.mjs';
import { findSourceAudio, SOURCE_NAMES } from './score/sheetsage-client.mjs';

// =====================================================================
// helpers
// =====================================================================

function listTargetFolders(config, folder) {
    if (folder) return [folder];
    return findSongFolders(config.paths.songsDir);
}

function resultOk(folder, extra = {}) {
    return { ok: true, folder, ...extra };
}
function resultSkip(folder, reason, stage, extra = {}) {
    return { ok: true, folder, skipped: true, reason, stage, ...extra };
}
function resultFail(folder, error, stage) {
    return { ok: false, folder, error, stage };
}

// Wrap onProgress so every event carries the stage name.
function taggedProgress(onProgress, stage) {
    if (!onProgress) return undefined;
    return (event) => onProgress({ ...event, stage });
}

// =====================================================================
// lyrics — create N new songs
// =====================================================================

export async function stageLyrics(config, {
    n = 1,
    theme,
    genre,
    mood,
    onProgress,
} = {}) {
    const results = [];
    const progress = taggedProgress(onProgress, 'lyrics');

    for (let i = 0; i < n; i++) {
        const label = n === 1 ? 'song' : `song ${i + 1}/${n}`;
        if (progress) progress({ phase: 'start', label });

        try {
            const plan = await runPlan(config, { theme, genre, mood });
            const writer = await runWrite(config, plan);
            const r = resultOk(writer.folder, {
                title: writer.title,
                stage: 'lyrics',
            });
            results.push(r);
            if (progress) progress({ phase: 'done', label, result: r });
        } catch (err) {
            const r = resultFail(null, err.message, 'lyrics');
            results.push(r);
            if (progress) progress({ phase: 'fail', label, result: r });
        }
    }

    return results;
}

// =====================================================================
// score — song.md → score.abc + score.meta.json
// =====================================================================

export async function stageScore(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    const folders = listTargetFolders(config, folder);
    const results = [];
    const progress = taggedProgress(onProgress, 'score');

    for (const f of folders) {
        const name = path.basename(f);
        const songPath = path.join(f, 'song.md');
        const abcPath = path.join(f, 'score.abc');

        if (!fs.existsSync(songPath)) {
            const r = resultSkip(f, 'no song.md', 'score');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (fs.existsSync(abcPath) && !force) {
            const r = resultSkip(f, 'score.abc exists', 'score');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await runScore(config, f);
            const r = resultOk(f, {
                title: out.title,
                stage: 'score',
                outputPath: out.abcPath,
                seed: out.seed,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, 'score');
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// transcribe — og_song.* → score.abc + score.meta.json (SheetSage2)
// =====================================================================

export async function stageTranscribe(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    const folders = listTargetFolders(config, folder);
    const results = [];
    const progress = taggedProgress(onProgress, 'transcribe');

    for (const f of folders) {
        const name = path.basename(f);
        const sourcePath = findSourceAudio(f);
        const abcPath = path.join(f, 'score.abc');

        if (!sourcePath) {
            const r = resultSkip(f, `no ${SOURCE_NAMES[0]} etc.`, 'transcribe');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (fs.existsSync(abcPath) && !force) {
            const r = resultSkip(f, 'score.abc exists', 'transcribe');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await runTranscribe(config, f);
            const r = resultOk(f, {
                stage: 'transcribe',
                outputPath: out.abcPath,
                source: path.basename(out.sourcePath),
                elapsedMs: out.elapsedMs,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, 'transcribe');
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// midi — score.abc → score.mid (+ score.human.mid)
// =====================================================================

export async function stageMidi(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    const folders = listTargetFolders(config, folder);
    const results = [];
    const progress = taggedProgress(onProgress, 'midi');

    for (const f of folders) {
        const name = path.basename(f);
        const abcPath = path.join(f, 'score.abc');
        const midiPath = path.join(f, 'score.mid');

        if (!fs.existsSync(abcPath)) {
            const r = resultSkip(f, 'no score.abc', 'midi');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (fs.existsSync(midiPath) && !force) {
            const r = resultSkip(f, 'score.mid exists', 'midi');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await runMidi(config, f);
            const r = resultOk(f, {
                stage: 'midi',
                outputPath: out.midiPath,
                humanized: out.humanized,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, 'midi');
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// render — score.mid → song.wav
// =====================================================================

export async function stageRender(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    const folders = listTargetFolders(config, folder);
    const results = [];
    const progress = taggedProgress(onProgress, 'render');

    for (const f of folders) {
        const name = path.basename(f);
        const midiPath = path.join(f, 'score.mid');
        const wavPath = path.join(f, 'song.wav');

        if (!fs.existsSync(midiPath)) {
            const r = resultSkip(f, 'no score.mid', 'render');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (fs.existsSync(wavPath) && !force) {
            const r = resultSkip(f, 'song.wav exists', 'render');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await runRender(config, f);
            const r = resultOk(f, {
                stage: 'render',
                outputPath: out.wavPath,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, 'render');
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// video — song.wav + thumbnail → song.mp4
// =====================================================================

export async function stageVideo(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    const folders = listTargetFolders(config, folder);
    const results = [];
    const progress = taggedProgress(onProgress, 'video');

    for (const f of folders) {
        const name = path.basename(f);
        const wavPath = path.join(f, 'song.wav');
        const videoPath = path.join(f, VIDEO_FILENAME);

        if (!fs.existsSync(wavPath)) {
            const r = resultSkip(f, 'no song.wav', 'video');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (fs.existsSync(videoPath) && !force) {
            const r = resultSkip(f, `${VIDEO_FILENAME} exists`, 'video');
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        // No thumbnail, no video: we never invent cover art.
        if (!findThumbnail(f)) {
            const r = resultSkip(f, 'thumbnail file not present', 'video', {
                warn: true,
            });
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await runVideo(config, f);
            const r = resultOk(f, {
                stage: 'video',
                outputPath: out.outPath,
                thumbnail: out.imagePath,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, 'video');
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// all — score + midi + render
// =====================================================================

export async function stageAll(config, {
    folder = null,
    force = false,
    onProgress,
} = {}) {
    // In "all" mode each stage runs over the same folder set. Downstream
    // stages automatically skip folders whose upstream output is missing.

    if (folder) {
        // Single-folder mode: run all three stages sequentially, return
        // the render stage's results.
        const s = await stageScore(config, { folder, force });
        const sRes = s[0];
        if (!sRes.ok && !sRes.skipped) return [sRes];

        const m = await stageMidi(config, { folder, force });
        const mRes = m[0];
        if (!mRes.ok && !mRes.skipped) return [mRes];

        return stageRender(config, { folder, force });
    }

    // Batch mode: run each stage across all folders with its own
    // progress tag, concatenate results.
    const scoreResults = await stageScore(config, { force, onProgress });
    const midiResults = await stageMidi(config, { force, onProgress });
    const renderResults = await stageRender(config, { force, onProgress });

    return [...scoreResults, ...midiResults, ...renderResults];
}