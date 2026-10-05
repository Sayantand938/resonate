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

        const abcText = await this._callYue2(parsed);

        const abcPath = path.join(folder, 'score.abc');
        fs.writeFileSync(abcPath, abcText, 'utf8');

        return {
            title: parsed.title,
            folder,
            abcPath,
            abcText,
        };
    }

    async _callYue2(parsed) {
        const sc = this.config.score;
        if (sc.provider !== 'yue2') {
            throw new Error(`Unknown score provider: ${sc.provider}`);
        }
        const client = new Yue2Client(sc);
        return client.generateAbc({
            style: parsed.style,
            lyrics: parsed.lyrics,
            seed: sc.seed,
        });
    }
}