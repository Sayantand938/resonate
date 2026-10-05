import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { projectRoot } from '../util.mjs';

let _cache = null;

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

    const data = yaml.load(fs.readFileSync(configPath, 'utf8')) ?? {};
    const base = path.dirname(configPath);

    // AI_API is required only by the lyrics stages. Individual stage runners
    // read config.apiKey lazily; if it's missing they throw a clear error.
    const apiKey = process.env.AI_API ?? null;

    const lyricsRaw = data.lyrics ?? {};
    const scoreRaw = data.score ?? {};
    const renderRaw = data.render ?? {};
    const pathsRaw = data.paths ?? {};
    const apiRaw = data.api ?? {};

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
        render: {
            soundfont: renderRaw.soundfont ?? null,
            sampleRate: Number(renderRaw.sample_rate ?? 44100),
            gain: Number(renderRaw.gain ?? 1.0),
            lufs: Number(renderRaw.lufs ?? -14),
            timeoutSeconds: Number(renderRaw.timeout_seconds ?? 300),
            composer: renderRaw.composer ?? null,

            // WAV render backend: "fluidsynth" (default) or "vst3".
            backend: String(renderRaw.backend ?? 'fluidsynth').toLowerCase(),

            // VST3 routing: array of { channels: [int], vst3: str, gain?: num }
            vst3Routing: Array.isArray(renderRaw.vst3_routing)
                ? renderRaw.vst3_routing.map((r) => ({
                    channels: Array.isArray(r.channels) ? r.channels : [r.channels],
                    vst3: path.resolve(base, r.vst3 ?? ''),
                    gain: Number(r.gain ?? 1.0),
                }))
                : [],

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
        apiKey,
    };

    if (!configPathOverride) _cache = cfg;
    return cfg;
}

/**
 * Assert that the config has everything a lyrics stage needs.
 * Called from Planner / SongWriter constructors.
 */
export function requireApiKey(config) {
    if (!config.apiKey) {
        throw new Error(
            'AI_API not set. Add it to .env or the environment before running ' +
            'lyrics-stage commands.'
        );
    }
}