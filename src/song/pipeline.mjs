// src/song/pipeline.mjs
// Stage-scoped pipeline functions.
//
// Each stage is a declaration: what its input is, what its output is, and
// what work to do. The loop that walks folders applying those declarations
// lives in ./stage-runner.mjs — this file only describes the stages.
//
// Every stage takes an OPTIONAL folder. When it is omitted, the stage
// iterates over every song in songs/.

import fs from 'node:fs';
import path from 'node:path';
import {
    runStage,
    runSequential,
    resultOk,
    resultFail,
    taggedProgress,
} from './stage-runner.mjs';
import {
    runPlan, runWrite, runScore, runMidi, runRender, runVideo, runTranscribe,
} from './stages.mjs';
import { findThumbnail, VIDEO_FILENAME } from '../video/generator.mjs';
import { findSourceAudio, SOURCE_NAMES } from './score/sheetsage-client.mjs';

// =====================================================================
// lyrics — create N new songs
//
// Not a folder-iterating stage: it produces folders rather than editing
// them. It still shares the result/progress contract so the CLI's summary
// works the same way for all commands.
// =====================================================================

export async function stageLyrics(config, {
    n = 1,
    theme,
    genre,
    mood,
    onProgress,
} = {}) {
    const stage = 'lyrics';
    const results = [];
    const progress = taggedProgress(onProgress, stage);

    for (let i = 0; i < n; i++) {
        const label = n === 1 ? 'song' : `song ${i + 1}/${n}`;
        if (progress) progress({ phase: 'start', label });

        try {
            const plan = await runPlan(config, { theme, genre, mood });
            const writer = await runWrite(config, plan);
            const r = resultOk(writer.folder, {
                stage,
                title: writer.title,
            });
            results.push(r);
            if (progress) progress({ phase: 'done', label, result: r });
        } catch (err) {
            const r = resultFail(null, err.message, stage);
            results.push(r);
            if (progress) progress({ phase: 'fail', label, result: r });
        }
    }

    return results;
}

// =====================================================================
// score — song.md → score.abc + score.meta.json
// =====================================================================

export function stageScore(config, { folder = null, force = false, onProgress } = {}) {
    return runStage({
        stage: 'score',
        songsDir: config.paths.songsDir,
        folder, force, onProgress,
        inputLabel: 'song.md',
        outputLabel: 'score.abc',
        hasInput: (f) => fs.existsSync(path.join(f, 'song.md')),
        hasOutput: (f) => fs.existsSync(path.join(f, 'score.abc')),
        run: async (f) => {
            const out = await runScore(config, f);
            return {
                title: out.title,
                outputPath: out.abcPath,
                seed: out.seed,
            };
        },
    });
}

// =====================================================================
// transcribe — og_song.* → score.abc + score.meta.json (SheetSage2)
// =====================================================================

export function stageTranscribe(config, { folder = null, force = false, onProgress } = {}) {
    return runStage({
        stage: 'transcribe',
        songsDir: config.paths.songsDir,
        folder, force, onProgress,
        inputLabel: `${SOURCE_NAMES[0]} etc.`,
        outputLabel: 'score.abc',
        hasInput: (f) => findSourceAudio(f) !== null,
        hasOutput: (f) => fs.existsSync(path.join(f, 'score.abc')),
        run: async (f) => {
            const out = await runTranscribe(config, f);
            return {
                outputPath: out.abcPath,
                source: path.basename(out.sourcePath),
                elapsedMs: out.elapsedMs,
            };
        },
    });
}

// =====================================================================
// midi — score.abc → score.mid (+ score.human.mid)
// =====================================================================

export function stageMidi(config, { folder = null, force = false, onProgress } = {}) {
    return runStage({
        stage: 'midi',
        songsDir: config.paths.songsDir,
        folder, force, onProgress,
        inputLabel: 'score.abc',
        outputLabel: 'score.mid',
        hasInput: (f) => fs.existsSync(path.join(f, 'score.abc')),
        hasOutput: (f) => fs.existsSync(path.join(f, 'score.mid')),
        run: async (f) => {
            const out = await runMidi(config, f);
            return {
                outputPath: out.midiPath,
                humanized: out.humanized,
            };
        },
    });
}

// =====================================================================
// render — score.mid → song.wav
// =====================================================================

export function stageRender(config, { folder = null, force = false, onProgress } = {}) {
    return runStage({
        stage: 'render',
        songsDir: config.paths.songsDir,
        folder, force, onProgress,
        inputLabel: 'score.mid',
        outputLabel: 'song.wav',
        hasInput: (f) => fs.existsSync(path.join(f, 'score.mid')),
        hasOutput: (f) => fs.existsSync(path.join(f, 'song.wav')),
        run: async (f) => {
            const out = await runRender(config, f);
            return { outputPath: out.wavPath };
        },
    });
}

// =====================================================================
// video — song.wav + thumbnail → song.mp4
// =====================================================================

export function stageVideo(config, { folder = null, force = false, onProgress } = {}) {
    return runStage({
        stage: 'video',
        songsDir: config.paths.songsDir,
        folder, force, onProgress,
        inputLabel: 'song.wav',
        outputLabel: VIDEO_FILENAME,
        hasInput: (f) => fs.existsSync(path.join(f, 'song.wav')),
        hasOutput: (f) => fs.existsSync(path.join(f, VIDEO_FILENAME)),
        // No thumbnail, no video: we never invent cover art.
        extraSkipReason: (f) => (findThumbnail(f) ? null : 'thumbnail file not present'),
        extraSkipWarn: true,
        run: async (f) => {
            const out = await runVideo(config, f);
            return {
                outputPath: out.outPath,
                thumbnail: out.imagePath,
            };
        },
    });
}

// =====================================================================
// all — score + midi + render
//
// Single-folder runs stop at the first hard failure; batch runs push every
// song through every stage so one broken song does not halt the rest.
// Both modes return the concatenated results of all three stages, so the
// CLI summary can report per-stage progress and the intermediate skip
// reasons (e.g. "score.abc exists") rather than swallowing them into a
// single "render" line.
// =====================================================================

export function stageAll(config, { folder = null, force = false, onProgress } = {}) {
    return runSequential(
        [stageScore, stageMidi, stageRender],
        {
            config,
            folder,
            force,
            onProgress,
            shortCircuit: Boolean(folder),
        }
    );
}