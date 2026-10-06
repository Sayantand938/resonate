// src/song/stages.mjs — one function per stage.
//
// Each stage is a thin orchestration layer: it works out the file paths and
// the effective config, then delegates to the engine modules under
// src/abc/, src/midi/, and src/audio/. Nothing here spawns a subprocess —
// the standalone CLIs in scripts/ are wrappers over these same modules.

import fs from 'node:fs';
import path from 'node:path';
import { Planner } from './lyrics/planner.mjs';
import { SongWriter } from './lyrics/writer.mjs';
import { SongScorer } from './score/generator.mjs';
import {
    SheetSageClient,
    findSourceAudio,
    SOURCE_NAMES,
} from './score/sheetsage-client.mjs';
import { parseSongMarkdown } from './lyrics/parser.mjs';
import { renderWithAbcjs } from '../abc/engine.mjs';
import { humanizeMidiBuffer } from '../midi/humanize.mjs';
import { renderWithBackend } from '../audio/backends.mjs';
import {
    generateVideo,
    findThumbnail,
    THUMBNAIL_NAMES,
    VIDEO_FILENAME,
} from '../video/generator.mjs';

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
// score  (song.md -> score.abc + score.meta.json via YuE2)
// =====================================================================

export async function runScore(config, songFolder) {
    const scorer = new SongScorer(config);
    return scorer.score(songFolder);
}

// =====================================================================
// transcribe  (og_song.* -> score.abc via SheetSage2)
//
// The mirror of the score stage: instead of inventing a score from lyrics,
// it listens to an existing recording. Same output artifact, so midi/render/
// video are unchanged.
// =====================================================================

export async function runTranscribe(config, songFolder) {
    const sourcePath = findSourceAudio(songFolder);
    if (!sourcePath) {
        throw new Error(
            `No source recording in ${songFolder} — expected one of: `
            + SOURCE_NAMES.join(', ')
        );
    }

    const client = new SheetSageClient(config);
    const { abc, meta } = await client.transcribe(sourcePath);

    const abcPath = path.join(songFolder, 'score.abc');
    fs.writeFileSync(abcPath, abc, 'utf8');

    const metaPath = path.join(songFolder, 'score.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

    return {
        abcPath,
        metaPath,
        sourcePath,
        provider: meta.provider,
        elapsedMs: meta.elapsed_ms,
    };
}

// =====================================================================
// midi  (score.abc -> score.mid via abcjs, optionally humanized)
// =====================================================================

export async function runMidi(config, songFolder, {
    program,
    tempo,
    title,
    composer,
} = {}) {
    const abcPath = path.join(songFolder, 'score.abc');
    const midiPath = path.join(songFolder, 'score.mid');
    const humanMidiPath = path.join(songFolder, 'score.human.mid');

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
    const programsByChannel = {
        0: vp.melody ?? 0,
        1: vp.ins ?? 0,
        2: vp.accompaniment ?? 0,
        3: vp.accompaniment2 ?? vp.accompaniment ?? 0,
    };

    await renderWithAbcjs({
        abcPath,
        outMidiPath: midiPath,
        programsByChannel,
        title,
        composer,
        tempo,
        program,
    });

    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI render did not produce ${midiPath}`);
    }

    // Optional humanization: rewrite score.mid -> score.human.mid
    const h = config.render.humanize;
    const humanized = Boolean(h && h.enabled);
    if (humanized) {
        const result = humanizeMidiBuffer(fs.readFileSync(midiPath), {
            timingMs: h.timingMs,
            velocity: h.velocity,
            rollMs: h.rollMs,
            rollOrder: h.rollOrder,
            minVel: h.minVel,
            maxVel: h.maxVel,
            seed: h.seed,
        });
        fs.writeFileSync(humanMidiPath, result.buffer);

        if (!fs.existsSync(humanMidiPath)) {
            throw new Error(`humanize-midi did not produce ${humanMidiPath}`);
        }
    }

    return {
        midiPath,
        humanMidiPath,
        abcPath,
        title,
        composer,
        humanized,
    };
}

// =====================================================================
// render  (score.mid or score.human.mid -> song.wav)
// =====================================================================

export async function runRender(config, songFolder, { keep = false } = {}) {
    // Prefer the humanized MIDI if it exists and humanize is enabled.
    const h = config.render.humanize;
    const humanMidiPath = path.join(songFolder, 'score.human.mid');
    const cleanMidiPath = path.join(songFolder, 'score.mid');

    let midiPath;
    if (h && h.enabled && fs.existsSync(humanMidiPath)) {
        midiPath = humanMidiPath;
    } else if (fs.existsSync(cleanMidiPath)) {
        midiPath = cleanMidiPath;
    } else {
        throw new Error(`Missing score.mid in ${songFolder}`);
    }

    const wavPath = path.join(songFolder, 'song.wav');

    // Backend selection, validation, and loudness normalization all live in
    // the registry; stages only decide which MIDI to render.
    const result = await renderWithBackend({
        backend: config.render.backend ?? 'fluidsynth',
        midiPath,
        wavPath,
        config,
        keep,
        // Stages run silently on success; the CLI wrappers report instead.
        silent: true,
    });

    return { wavPath: result.wavPath, midiPath };
}

// =====================================================================
// video  (song.wav + thumbnail -> song.mp4)
// =====================================================================

export async function runVideo(config, songFolder) {
    const wavPath = path.join(songFolder, 'song.wav');
    if (!fs.existsSync(wavPath)) {
        throw new Error(`Missing song.wav in ${songFolder}`);
    }

    const imagePath = findThumbnail(songFolder);
    if (!imagePath) {
        throw new Error(
            'Thumbnail file not present — expected one of: '
            + THUMBNAIL_NAMES.join(', ')
        );
    }

    const outPath = path.join(songFolder, VIDEO_FILENAME);
    const v = config.video ?? {};

    await generateVideo({
        wavPath,
        imagePath,
        outPath,
        width: v.width,
        height: v.height,
        fps: v.fps,
        fit: v.fit,
        crf: v.crf,
        preset: v.preset,
        audioBitrate: v.audioBitrate,
        // Stages run silently on success; the CLI wrappers report instead.
        silent: true,
    });

    return { outPath, wavPath, imagePath };
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
