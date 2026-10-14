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
import { voiceNamesByChannel } from '../abc/voices.mjs';
import { humanizeMidiBuffer } from '../midi/humanize.mjs';
import { renderWithBackend } from '../audio/backends.mjs';
import { applySongOverride } from './config.mjs';
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

    await renderWithAbcjs({
        abcPath,
        outMidiPath: midiPath,
        programsByChannel: {},
        title,
        composer,
        tempo,
        program,
    });

    if (!fs.existsSync(midiPath)) {
        throw new Error(`MIDI render did not produce ${midiPath}`);
    }

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
    const abcPath = path.join(songFolder, 'score.abc');

    // Apply this song's render.local.yaml (per-voice instrument choices)
    // on top of the loaded config. A song with no override file returns
    // the config unchanged, so existing songs behave exactly as before.
    const effectiveConfig = applySongOverride(config, songFolder);

    const routes = buildVoiceRoutes(effectiveConfig, abcPath, midiPath, songFolder);

    const result = await renderWithBackend({
        backend: effectiveConfig.render.backend ?? 'vst3',
        midiPath,
        wavPath,
        config: effectiveConfig,
        routes,
        keep,
        silent: true,
    });

    return { wavPath: result.wavPath, midiPath, engines: result.engines };
}

/**
 * Build a routes array from the ABC voice names.
 *
 * For each voice in the ABC, the effective instrument is resolved as:
 *
 *   1. the song's own choice
 *      (songs/<slug>/render.local.yaml → render.voices.<VoiceName>)
 *   2. otherwise the house default
 *      (config.yaml → render.voices.<VoiceName>)
 *   3. otherwise `render.voice_fallback_policy`:
 *        "fallback"  warn, then use `render.voice_fallback`
 *        "error"     throw, naming the voice
 *
 * Gain resolves the same way, per voice:
 *
 *   1. song override  (render.local.yaml → render.gains.<VoiceName>)
 *   2. house default  (config.yaml → render.gains.<VoiceName>)
 *   3. 1.0
 *
 * An instrument is looked up by name in `render.instruments` and turned
 * into a route carrying its engine and path. Every route names its engine
 * explicitly; the dispatcher in backends.mjs never infers.
 */
function buildVoiceRoutes(config, abcPath, midiPath, songFolder) {
    const render = config.render;
    const instruments = render.instruments ?? {};
    if (!render.voices || Object.keys(render.voices).length === 0) {
        return undefined;
    }

    if (!fs.existsSync(abcPath) || !fs.existsSync(midiPath)) {
        return undefined;
    }

    const abcSource = fs.readFileSync(abcPath, 'utf8');
    const midiBuffer = fs.readFileSync(midiPath);
    const channelToVoice = voiceNamesByChannel(abcSource, midiBuffer);

    if (Object.keys(channelToVoice).length === 0) {
        return undefined;
    }

    const defaultGains = render.gains ?? {};
    const songGains = render.songGainOverrides ?? {};
    const songVoices = render.songVoiceOverrides ?? {};

    const fallbackPolicy = render.voiceFallbackPolicy ?? 'error';
    const fallbackEntry = render.voiceFallback ?? null;
    const songName = path.basename(songFolder || path.dirname(abcPath));

    const routes = [];

    for (const [chStr, voiceName] of Object.entries(channelToVoice)) {
        // ---- instrument: local → global → fallback → error ----
        const chosenName = songVoices[voiceName] ?? render.voices[voiceName];
        let entry = chosenName ? instruments[chosenName] : null;

        if (!entry) {
            if (fallbackPolicy === 'fallback' && fallbackEntry) {
                console.error(
                    `[warn] no instrument for ABC voice "${voiceName}" in `
                    + `${songName} — using fallback. `
                    + `Add it to render.voices in config.yaml, or set `
                    + `render.voices.${voiceName} in the song's `
                    + `render.local.yaml.`
                );
                entry = fallbackEntry;
            } else {
                throw new Error(
                    `No instrument for ABC voice "${voiceName}" in ${songName}. `
                    + `Add render.voices.${voiceName} in config.yaml, or set `
                    + `render.voices.${voiceName} in the song's `
                    + `render.local.yaml, or set `
                    + `render.voice_fallback_policy: fallback.`
                );
            }
        }

        // ---- gain: local → global → 1.0 ----
        const gain = songGains[voiceName]
            ?? defaultGains[voiceName]
            ?? 1.0;

        // ---- emit the route ----
        const engine = entry.engine ?? 'vst3';
        const route = {
            engine,
            channels: [Number(chStr)],
            gain,
        };

        if (engine === 'vst3') {
            route.vst3 = entry.vst3;
        } else if (engine === 'sfizz') {
            route.sfz = entry.sfz;
        } else {
            throw new Error(
                `Voice "${voiceName}" in ${songName} resolves to instrument `
                + `"${chosenName ?? '(fallback)'}" with unknown engine `
                + `"${engine}". Known engines: vst3, sfizz.`
            );
        }

        routes.push(route);
    }

    return routes;
}

// =====================================================================
// video
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