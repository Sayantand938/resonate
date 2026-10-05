import fs from 'node:fs';
import OpenAI from 'openai';
import { normalizePlan } from './models.mjs';

export class Planner {
    constructor(config) {
        this.config = config;
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: config.api.baseUrl,
        });
    }

    _loadPrompt() {
        const p = this.config.lyrics.plannerPromptFile;
        if (!fs.existsSync(p)) throw new Error(`Planner prompt not found: ${p}`);
        return fs.readFileSync(p, 'utf8');
    }

    async plan(userSeed) {
        const lc = this.config.lyrics;
        const systemPrompt = this._loadPrompt();

        const completion = await this.client.chat.completions.create({
            model: lc.plannerModel,
            temperature: lc.plannerTemperature,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userSeed },
            ],
            response_format: { type: 'json_object' },
        });

        const content = completion.choices?.[0]?.message?.content;
        if (!content) throw new Error('Planner returned empty content.');

        let raw;
        try {
            raw = JSON.parse(content);
        } catch (e) {
            throw new Error(
                `Planner output was not valid JSON: ${e.message}\n---\n${content.slice(0, 500)}`
            );
        }

        return normalizePlan(raw);
    }
}