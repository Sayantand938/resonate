import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { parseSongMarkdown } from './parser.mjs';
import { planToPromptBlock } from './models.mjs';
import { requireApiKey } from '../config.mjs';
import { slugify, songFolderName } from '../../util.mjs';

export class SongWriter {
    constructor(config) {
        requireApiKey(config);
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.api.baseUrl,
        });
    }

    _loadPrompt() {
        const p = this.config.lyrics.writerPromptFile;
        if (!fs.existsSync(p)) throw new Error(`Writer prompt not found: ${p}`);
        return fs.readFileSync(p, 'utf8');
    }

    _uniqueFolder(root, baseName) {
        let folder = path.join(root, baseName);
        let n = 2;
        while (fs.existsSync(folder)) {
            folder = path.join(root, `${baseName}-${n}`);
            n++;
        }
        return folder;
    }

    async write(plan, existingFolder = null) {
        const lc = this.config.lyrics;
        const systemPrompt = this._loadPrompt();

        const userPrompt =
            'Write the full song based on this plan. Follow the Output Schema ' +
            'exactly: `# TITLE`, then `# STYLE`, then `# LYRICS`.\n\n' +
            '--- PLAN ---\n' +
            planToPromptBlock(plan) +
            '\n--- END PLAN ---';

        const response = await this.client.chat.completions.create({
            model: lc.writerModel,
            temperature: lc.writerTemperature,
            max_tokens: lc.maxTokens,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        });

        const content = response.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) throw new Error('Writer returned an empty response.');

        const parsed = parseSongMarkdown(content);
        if (!parsed.is_valid) {
            throw new Error(
                'Writer output missing `# TITLE` or `# LYRICS`.\n' +
                content.slice(0, 500)
            );
        }

        const slug = slugify(parsed.title);
        const baseName = songFolderName(slug, { datePrefix: lc.datePrefixFilenames });

        let folder;
        if (existingFolder) {
            folder = existingFolder;
            fs.mkdirSync(folder, { recursive: true });
        } else {
            fs.mkdirSync(this.config.paths.songsDir, { recursive: true });
            folder = this._uniqueFolder(this.config.paths.songsDir, baseName);
            fs.mkdirSync(folder);
        }

        // Write plan.json first, then song.md. song.md is the pipeline gate,
        // so its presence implies plan.json also exists.
        let planPath = null;
        if (lc.savePlan) {
            planPath = path.join(folder, 'plan.json');
            fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
        }

        const songPath = path.join(folder, 'song.md');
        fs.writeFileSync(songPath, content, 'utf8');

        return {
            title: parsed.title,
            slug: path.basename(folder),
            folder,
            songPath,
            planPath,
            content,
            parsed,
            plan,
        };
    }
}