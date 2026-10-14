import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { projectRoot } from '../util.mjs';

let _cache = null;

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, override) {
    if (!isPlainObject(base)) return override;
    if (!isPlainObject(override)) return override === undefined ? base : override;

    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        out[key] = isPlainObject(value) && isPlainObject(base[key])
            ? deepMerge(base[key], value)
            : value;
    }
    return out;
}

function readYamlIfExists(p) {
    if (!fs.existsSync(p)) return null;
    return yaml.load(fs.readFileSync(p, 'utf8')) ?? {};
}

function readMergedConfig(configPath) {
    const data = readYamlIfExists(configPath) ?? {};
    const localPath = path.join(path.dirname(configPath), 'config.local.yaml');
    const local = readYamlIfExists(localPath);
    return { data: local ? deepMerge(data, local) : data, localPath };
}

/**
 * Normalize one instrument entry from the menu into { engine, vst3|sfz }.
 *
 * Accepted shapes:
 *   "C:/path/to/plugin.vst3"                         (vst3, shorthand)
 *   { engine: vst3,  vst3: "C:/path/to/plugin.vst3" }
 *   { engine: sfizz, sfz:  "C:/path/to/soundfont.sfz" }
 */
function normalizeInstrumentEntry(raw, name) {
    if (typeof raw === 'string') {
        return { engine: 'vst3', vst3: raw };
    }
    if (isPlainObject(raw)) {
        const engine = String(raw.engine ?? 'vst3').toLowerCase();
        if (engine === 'vst3') {
            if (!raw.vst3) {
                throw new Error(
                    `instrument "${name}" declares engine vst3 but has no "vst3" path.`
                );
            }
            return { engine: 'vst3', vst3: raw.vst3 };
        }
        if (engine === 'sfizz') {
            if (!raw.sfz) {
                throw new Error(
                    `instrument "${name}" declares engine sfizz but has no "sfz" path.`
                );
            }
            return { engine: 'sfizz', sfz: raw.sfz };
        }
        throw new Error(
            `instrument "${name}" names unknown engine "${raw.engine}". `
            + `Known engines: vst3, sfizz.`
        );
    }
    throw new Error(`instrument "${name}" must be a string or an object.`);
}

/** Normalize the whole instrument menu. */
function normalizeInstruments(raw) {
    if (!isPlainObject(raw)) return {};
    const out = {};
    for (const [name, value] of Object.entries(raw)) {
        try {
            out[name] = normalizeInstrumentEntry(value, name);
        } catch (err) {
            throw new Error(`render.instruments.${name}: ${err.message}`);
        }
    }
    return out;
}

/**
 * Normalize a voice → instrument-name map, validating that every named
 * instrument exists in the menu. Returns { voiceName: instrumentName }.
 *
 * If a value is an object (legacy inline entry), it is normalized inline
 * and registered under a synthetic name so older configs keep working.
 * New configs should use a bare instrument name.
 */
function normalizeVoiceMap(raw, instrumentNames, label, instrumentsOut) {
    if (!isPlainObject(raw)) return {};
    const out = {};

    for (const [voiceName, value] of Object.entries(raw)) {
        if (typeof value === 'string') {
            if (!instrumentNames.has(value)) {
                throw new Error(
                    `render.${label}.${voiceName} names instrument "${value}" `
                    + `but no such instrument exists. Known instruments: `
                    + `${[...instrumentNames].join(', ') || '(none)'}.`
                );
            }
            out[voiceName] = value;
            continue;
        }

        // Legacy inline object — register it under a synthetic name so the
        // rest of the pipeline only ever deals with names.
        if (isPlainObject(value)) {
            const synthetic = `__inline__${label}__${voiceName}`;
            instrumentsOut[synthetic] = normalizeInstrumentEntry(value, synthetic);
            instrumentNames.add(synthetic);
            out[voiceName] = synthetic;
            continue;
        }

        throw new Error(
            `render.${label}.${voiceName} must be an instrument name or an `
            + `inline { engine, vst3|sfz } object.`
        );
    }

    return out;
}

/** Normalize a voice → gain map. */
function normalizeGains(raw) {
    if (!isPlainObject(raw)) return {};
    const out = {};
    for (const [voiceName, value] of Object.entries(raw)) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            throw new Error(`render.gains.${voiceName} must be a number.`);
        }
        out[voiceName] = n;
    }
    return out;
}

/**
 * Read `songs/<slug>/render.local.yaml`, if present. Returns the parsed
 * object, or null.
 */
export function readSongRenderOverride(songFolder) {
    if (!songFolder) return null;
    const p = path.join(songFolder, 'render.local.yaml');
    if (!fs.existsSync(p)) return null;
    return yaml.load(fs.readFileSync(p, 'utf8')) ?? {};
}

export function loadConfig(configPathOverride) {
    if (_cache && !configPathOverride) return _cache;

    dotenv.config({ override: false });

    const root = projectRoot();
    const configPath = configPathOverride
        ? path.resolve(configPathOverride)
        : path.join(root, 'config.yaml');

    if (!fs.existsSync(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    const data = readMergedConfig(configPath).data;
    const base = path.dirname(configPath);

    const apiKey = process.env.AI_API ?? null;

    const lyricsRaw = data.lyrics ?? {};
    const scoreRaw = data.score ?? {};
    const transcribeRaw = data.transcribe ?? {};
    const renderRaw = data.render ?? {};
    const pathsRaw = data.paths ?? {};
    const apiRaw = data.api ?? {};
    const humanRaw = renderRaw.humanize ?? data.humanize ?? {};
    const loudRaw = renderRaw.loudness ?? {};
    const videoRaw = data.video ?? {};

    const writerModel = lyricsRaw.writer_model ?? 'openai/gpt-5.6-luna';
    const plannerModel = lyricsRaw.planner_model ?? writerModel;

    // ---- Instrument menu + voice defaults ----
    //
    // `instruments` is the catalogue. `voices` maps ABC voice names to
    // instrument names. Both are fully validated here so a typo fails at
    // load, not mid-render.
    const instruments = normalizeInstruments(renderRaw.instruments);
    const instrumentNames = new Set(Object.keys(instruments));

    const voices = normalizeVoiceMap(
        renderRaw.voices,
        instrumentNames,
        'voices',
        instruments
    );

    const gains = normalizeGains(renderRaw.gains);

    const cfg = {
        root: base,
        paths: {
            songsDir: path.resolve(base, pathsRaw.songs_dir ?? 'songs'),
        },
        api: {
            baseUrl: apiRaw.base_url ?? 'https://api.aicredits.in/v1',
        },
        lyrics: {
            plannerModel,
            plannerPromptFile: path.resolve(base, lyricsRaw.planner_prompt_file),
            plannerTemperature: Number(lyricsRaw.planner_temperature ?? 1.0),
            writerModel,
            writerPromptFile: path.resolve(base, lyricsRaw.writer_prompt_file),
            writerTemperature: Number(lyricsRaw.writer_temperature ?? 0.9),
            maxTokens: Number(lyricsRaw.max_tokens ?? 4000),
            savePlan: Boolean(lyricsRaw.save_plan ?? true),
            dateInFolder: Boolean(lyricsRaw.date_in_folder ?? true),
        },
        score: {
            provider: scoreRaw.provider ?? 'yue2',
            baseUrl: scoreRaw.base_url ?? 'http://127.0.0.1:8080',
            endpoint: scoreRaw.endpoint ?? '/v1/tasks/run',
            model: scoreRaw.model ?? 'yue2-music',
            cot: scoreRaw.cot ?? 'full',
            stopAfter: scoreRaw.stop_after ?? 'abc',
            seed: Number(scoreRaw.seed ?? 1234),
            seedMode: String(scoreRaw.seed_mode ?? 'fixed').toLowerCase(),
            numInferenceSteps: Number(scoreRaw.num_inference_steps ?? 32),
            timeoutSeconds: Number(scoreRaw.timeout_seconds ?? 600),
        },
        transcribe: {
            provider: transcribeRaw.provider ?? 'sheetsage2',
            baseUrl: transcribeRaw.base_url ?? 'http://127.0.0.1:8081',
            endpoint: transcribeRaw.endpoint ?? '/v1/tasks/run',
            model: transcribeRaw.model ?? 'sheetsage2',
            sampleRate: transcribeRaw.sample_rate ?? null,
            timeoutSeconds: Number(transcribeRaw.timeout_seconds ?? 1800),
        },
        render: {
            sampleRate: Number(renderRaw.sample_rate ?? 44100),
            timeoutSeconds: Number(renderRaw.timeout_seconds ?? 300),
            composer: renderRaw.composer ?? null,

            loudness: {
                enabled: Boolean(loudRaw.enabled ?? true),
                targetLufs: Number(
                    loudRaw.target_lufs ?? renderRaw.lufs ?? -14
                ),
                truePeakDb: Number(loudRaw.true_peak_db ?? -1),
            },

            backend: String(renderRaw.backend ?? 'vst3').toLowerCase(),
            sfizzBin: String(renderRaw.sfizz_bin ?? 'sfizz_render'),

            // The menu and the house defaults.
            instruments,
            voices,
            gains,

            // Populated per-song by applySongOverride. Empty by default so
            // a song with no render.local.yaml behaves exactly as before.
            songVoiceOverrides: {},
            songGainOverrides: {},

            voiceFallbackPolicy: String(
                renderRaw.voice_fallback_policy ?? 'error'
            ).toLowerCase(),
            voiceFallback: renderRaw.voice_fallback
                ? normalizeInstrumentEntry(renderRaw.voice_fallback, 'voice_fallback')
                : null,

            vst3Routing: Array.isArray(renderRaw.vst3_routing)
                ? renderRaw.vst3_routing.map((r) => ({
                    channels: Array.isArray(r.channels) ? r.channels : [r.channels],
                    vst3: path.resolve(base, r.vst3 ?? ''),
                    gain: Number(r.gain ?? 1.0),
                }))
                : [],

            humanize: {
                enabled: Boolean(humanRaw.enabled ?? false),
                timingMs: Number(humanRaw.timing_ms ?? 15),
                velocity: Number(humanRaw.velocity ?? 8),
                rollMs: Number(humanRaw.chord_roll_ms ?? 12),
                rollOrder: String(humanRaw.roll_order ?? 'up').toLowerCase(),
                minVel: Number(humanRaw.min_vel ?? 40),
                maxVel: Number(humanRaw.max_vel ?? 115),
                seed: Number(humanRaw.seed ?? 0),
            },
        },
        video: {
            width: Number(videoRaw.width ?? 1920),
            height: Number(videoRaw.height ?? 1080),
            fps: Number(videoRaw.fps ?? 30),
            fit: String(videoRaw.fit ?? 'blur').toLowerCase(),
            crf: Number(videoRaw.crf ?? 18),
            preset: String(videoRaw.preset ?? 'medium'),
            audioBitrate: String(videoRaw.audio_bitrate ?? '192k'),
        },
        apiKey,
    };

    if (!configPathOverride) _cache = cfg;
    return cfg;
}

/**
 * Apply a song's `render.local.yaml` on top of the loaded config.
 *
 * The local file is *sparse*: it names only the voices it wants different.
 * Everything it does not name falls through to the global default.
 *
 *   render:
 *     voices:
 *       accompaniment: livingroom-upright-piano-micro-sfz
 *       Ins: AGML
 *     gains:
 *       accompaniment: 1.5
 *
 * Every instrument name is validated against the menu here, so a typo is
 * a load-time error rather than a render-time surprise.
 *
 * @param {object} config       result of loadConfig()
 * @param {string} songFolder
 * @returns {object}            a shallow-cloned config with overrides applied
 */
export function applySongOverride(config, songFolder) {
    const override = readSongRenderOverride(songFolder);
    if (!override) return config;

    const renderRaw = override.render ?? {};
    const voiceOverridesRaw = renderRaw.voices;
    const gainOverridesRaw = renderRaw.gains;

    const hasVoices = isPlainObject(voiceOverridesRaw)
        && Object.keys(voiceOverridesRaw).length > 0;
    const hasGains = isPlainObject(gainOverridesRaw)
        && Object.keys(gainOverridesRaw).length > 0;

    if (!hasVoices && !hasGains) return config;

    const songName = path.basename(songFolder);
    const instrumentNames = new Set(Object.keys(config.render.instruments));

    const voiceOverrides = {};

    if (hasVoices) {
        for (const [voiceName, instrumentName] of Object.entries(voiceOverridesRaw)) {
            if (typeof instrumentName !== 'string') {
                console.error(
                    `[warn] ${songName}/render.local.yaml: `
                    + `render.voices.${voiceName} must be an instrument name `
                    + `(a string). Ignoring.`
                );
                continue;
            }
            if (!instrumentNames.has(instrumentName)) {
                console.error(
                    `[warn] ${songName}/render.local.yaml: `
                    + `render.voices.${voiceName} names "${instrumentName}" `
                    + `but no such instrument exists. Known instruments: `
                    + `${[...instrumentNames].join(', ') || '(none)'}. Ignoring.`
                );
                continue;
            }
            voiceOverrides[voiceName] = instrumentName;
        }
    }

    const gainOverrides = {};

    if (hasGains) {
        for (const [voiceName, value] of Object.entries(gainOverridesRaw)) {
            const n = Number(value);
            if (!Number.isFinite(n)) {
                console.error(
                    `[warn] ${songName}/render.local.yaml: `
                    + `render.gains.${voiceName} = "${value}" is not a number. Ignoring.`
                );
                continue;
            }
            gainOverrides[voiceName] = n;
        }
    }

    return {
        ...config,
        render: {
            ...config.render,
            songVoiceOverrides: voiceOverrides,
            songGainOverrides: gainOverrides,
        },
    };
}

/**
 * Assert that the config has everything a lyrics stage needs.
 *
 * The lyrics stage is the only consumer of `config.apiKey`; every other
 * stage works offline. This is called by the Planner and SongWriter
 * constructors so a missing key fails at construction with a clear
 * message, rather than as a confusing 401 from the OpenAI client.
 */
export function requireApiKey(config) {
    if (!config.apiKey) {
        throw new Error(
            'AI_API not set. Add it to .env or the environment before running ' +
            'lyrics-stage commands.'
        );
    }
}