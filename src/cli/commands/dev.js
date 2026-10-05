// src/cli/commands/dev.js
// Hidden dev tools: `plan` and `write`.

import fs from 'node:fs';
import { loadConfig } from '../../song/config.mjs';
import { runPlan, runWrite } from '../../song/stages.mjs';

export function registerDev(program) {
    program
        .command('plan', { hidden: true })
        .description('Generate a single song plan (dev tool; writes JSON to stdout)')
        .option('-t, --theme <text>')
        .option('-g, --genre <text>')
        .option('-m, --mood <text>')
        .option('-o, --output <file>', 'write plan to this file instead of stdout')
        .action(async (opts) => {
            const config = loadConfig();
            const plan = await runPlan(config, {
                theme: opts.theme,
                genre: opts.genre,
                mood: opts.mood,
            });

            const json = JSON.stringify(plan, null, 2) + '\n';
            if (opts.output) {
                fs.writeFileSync(opts.output, json, 'utf8');
                console.log(`\n  ${opts.output}\n`);
            } else {
                process.stdout.write(json);
            }
        });

    program
        .command('write <planJson>', { hidden: true })
        .description('Write lyrics from plan.json (dev tool; creates a song folder)')
        .action(async (planJson) => {
            const config = loadConfig();
            const plan = JSON.parse(fs.readFileSync(planJson, 'utf8'));
            const result = await runWrite(config, plan);

            console.log('');
            console.log(`  ${result.title}`);
            console.log(`  ${result.folder}`);
            console.log('');
        });
}