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

    const apiKey = process.env.AI_API;
    if (!apiKey) {
        throw new Error('AI_API not set. Add it to .env or the environment.');
    }

    const lyricsRaw = data.lyrics ?? {};
    const scoreRaw = data.score ?? {};
    const renderRaw = data.render ?? {};
    const pathsRaw = data.paths ?? {};
    const apiRaw = data.api ?? {};

    const writerModel = lyricsRaw.writer_model ?? 'openai/gpt-5.6-luna';
    const plannerModel = lyricsRaw.planner_model ?? writerModel;

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
            numInferenceSteps: Number(scoreRaw.num_inference_steps ?? 32),
            timeoutSeconds: Number(scoreRaw.timeout_seconds ?? 600),
        },
        render: {
            soundfont: renderRaw.soundfont ?? null,
            sampleRate: Number(renderRaw.sample_rate ?? 44100),
            gain: Number(renderRaw.gain ?? 1.0),
            lufs: Number(renderRaw.lufs ?? -14),
            timeoutSeconds: Number(renderRaw.timeout_seconds ?? 300),
        },
        apiKey,
    };

    if (!configPathOverride) _cache = cfg;
    return cfg;
}