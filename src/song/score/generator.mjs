import fs from 'node:fs';
import path from 'node:path';
import { parseSongMarkdown } from '../lyrics/parser.mjs';
import { Yue2Client } from './yue2-client.mjs';

export class SongScorer {
    constructor(config) {
        this.config = config;
    }

    async score(folder) {
        const songPath = path.join(folder, 'song.md');
        if (!fs.existsSync(songPath)) {
            throw new Error(`Missing song.md in ${folder}`);
        }

        const parsed = parseSongMarkdown(fs.readFileSync(songPath, 'utf8'));
        if (!parsed.is_valid) {
            throw new Error(`${songPath} missing # TITLE or # LYRICS.`);
        }

        const seed = this._resolveSeed();
        const abcText = await this._callYue2(parsed, seed);

        const abcPath = path.join(folder, 'score.abc');
        fs.writeFileSync(abcPath, abcText, 'utf8');

        return {
            title: parsed.title,
            folder,
            abcPath,
            abcText,
            seed,
        };
    }

    /**
     * Pick a seed for this YuE2 call.
     *
     *   random  → fresh 31-bit integer on every call
     *   fixed   → config.score.seed, used for every song
     *
     * In "random" mode the seed is ephemeral — it's not written anywhere,
     * so a re-run of the same song produces a different composition. If
     * you want to keep a random result, keep the generated score.abc.
     */
    _resolveSeed() {
        const sc = this.config.score;
        if (sc.seedMode === 'random') {
            return Math.floor(Math.random() * 2 ** 31);
        }
        return sc.seed;
    }

    async _callYue2(parsed, seed) {
        const sc = this.config.score;
        if (sc.provider !== 'yue2') {
            throw new Error(`Unknown score provider: ${sc.provider}`);
        }
        const client = new Yue2Client(sc);
        return client.generateAbc({
            style: parsed.style,
            lyrics: parsed.lyrics,
            seed,
        });
    }
}