import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { projectRoot } from '../util.mjs';

let _cache = null;

function isPlainObject(v) {
    return v != null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Recursively merge `override` onto `base`, returning a new object.
 *
 * Plain objects merge key by key; arrays and scalars replace wholesale.
 * This is what makes `config.local.yaml` able to redefine the whole
 * `render.vst3_routing` table rather than concatenating onto it.
 */
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

/**
 * Read and merge `config.yaml` with an optional gitignored
 * `config.local.yaml` sitting beside it.
 *
 * The local file holds machine-specific settings (absolute VST3 paths,
 * a different render backend, a pinned humanize seed) that must not be
 * committed. It is deep-merged over the tracked config, so it only needs
 * to name the keys it actually overrides.
 */
function readMergedConfig(configPath) {
    const data = yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {};

    const localPath = path.join(path.dirname(configPath), 'config.local.yaml');
    if (!fs.existsSync(localPath)) return { data, localPath: null };

    const local = yaml.load(fs.readFileSync(localPath, 'utf8')) ?? {};
    return { data: deepMerge(data, local), localPath };
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

    const voiceProgramsRaw = renderRaw.voice_programs ?? {};

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
            datePrefixFilenames: Boolean(lyricsRaw.date_prefix_filenames ?? true),
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
            soundfont: renderRaw.soundfont ?? null,
            sampleRate: Number(renderRaw.sample_rate ?? 44100),
            gain: Number(renderRaw.gain ?? 1.0),
            timeoutSeconds: Number(renderRaw.timeout_seconds ?? 300),
            composer: renderRaw.composer ?? null,

            // `render.lufs` is the pre-0.2 name for `loudness.target_lufs`;
            // still honoured as a fallback so old configs keep working.
            loudness: {
                enabled: Boolean(loudRaw.enabled ?? true),
                targetLufs: Number(
                    loudRaw.target_lufs ?? renderRaw.lufs ?? -14
                ),
                truePeakDb: Number(loudRaw.true_peak_db ?? -1),
            },

            backend: String(renderRaw.backend ?? 'fluidsynth').toLowerCase(),

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

            voicePrograms: {
                melody: Number(voiceProgramsRaw.melody ?? 0),
                ins: Number(voiceProgramsRaw.ins ?? 0),
                accompaniment: Number(
                    voiceProgramsRaw.accompaniment
                    ?? voiceProgramsRaw.chords
                    ?? 0
                ),
                accompaniment2: Number(
                    voiceProgramsRaw.accompaniment2
                    ?? voiceProgramsRaw.chords2
                    ?? voiceProgramsRaw.accompaniment
                    ?? voiceProgramsRaw.chords
                    ?? 0
                ),
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
 * Assert that the config has everything a lyrics stage needs.
 */
export function requireApiKey(config) {
    if (!config.apiKey) {
        throw new Error(
            'AI_API not set. Add it to .env or the environment before running ' +
            'lyrics-stage commands.'
        );
    }
}