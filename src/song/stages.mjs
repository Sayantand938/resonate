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
// score  (song.md -> score.abc + score.meta.json via YuE2)
// =====================================================================

export async function runScore(config, songFolder) {
    const scorer = new SongScorer(config);
    return scorer.score(songFolder);
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

    // Optional humanization: rewrite score.mid -> score.human.mid
    const h = config.render.humanize;
    if (h && h.enabled) {
        const hArgs = [
            path.join(root, 'scripts', 'humanize-midi.mjs'),
            midiPath,
            humanMidiPath,
            '--timing-ms', String(h.timingMs),
            '--velocity', String(h.velocity),
            '--roll-ms', String(h.rollMs),
            '--roll-order', h.rollOrder,
            '--min-vel', String(h.minVel),
            '--max-vel', String(h.maxVel),
            '--seed', String(h.seed),
        ];
        await run('node', hArgs);

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
        humanized: Boolean(h && h.enabled),
    };
}

// =====================================================================
// render  (score.mid or score.human.mid -> song.wav)
// =====================================================================

export async function runRender(config, songFolder, {
    soundfont,
    gain,
    lufs,
    keep,
} = {}) {
    const root = projectRoot();

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

    const backend = config.render.backend ?? 'fluidsynth';
    const g = gain ?? config.render.gain;

    if (backend === 'vst3') {
        const routing = config.render.vst3Routing ?? [];
        if (routing.length === 0) {
            throw new Error('render.vst3_routing is empty in config.yaml');
        }
        for (const r of routing) {
            if (!fs.existsSync(r.vst3)) {
                throw new Error(`VST3 not found: ${r.vst3}`);
            }
        }

        const routesJson = JSON.stringify(
            routing.map((r) => ({
                channels: r.channels,
                vst3: r.vst3,
                gain: r.gain ?? 1.0,
            }))
        );

        const args = [
            path.join(root, 'scripts', 'midi2wav-vst.mjs'),
            midiPath,
            wavPath,
            '--routes', routesJson,
            '--normalize',
        ];
        if (config.render.sampleRate) {
            args.push('--sr', String(config.render.sampleRate));
        }

        await run('node', args);

        if (!fs.existsSync(wavPath)) {
            throw new Error(`midi2wav-vst did not produce ${wavPath}`);
        }
        return { wavPath, midiPath };
    }

    // FluidSynth backend
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