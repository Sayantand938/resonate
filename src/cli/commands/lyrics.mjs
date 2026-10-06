// src/cli/commands/lyrics.mjs
// `resonate lyrics` — create N new songs (plan.json + song.md).

import path from 'node:path';
import Table from 'cli-table3';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { stageLyrics } from '../../song/pipeline.mjs';
import { makeProgress } from '../progress.mjs';
import { setExit } from '../summary.mjs';

export function registerLyrics(program) {
    program
        .command('lyrics')
        .description('Create N new songs (plan.json + song.md)')
        .option('-n, --n <count>', 'number of songs to create', (v) => parseInt(v, 10), 1)
        .option('-t, --theme <text>', 'theme seed (single-song mode only)')
        .option('-g, --genre <text>', 'genre seed reused across all songs')
        .option('-m, --mood <text>', 'mood seed reused across all songs')
        .action(async (opts) => {
            const config = loadConfig();
            const n = opts.n;

            if (!Number.isInteger(n) || n < 1) {
                console.error(chalk.red('--n must be a positive integer'));
                setExit(1);
                return;
            }
            if (n > 1 && opts.theme) {
                console.error(chalk.red(`--theme can only be used with --n 1 (got --n ${n})`));
                setExit(1);
                return;
            }

            console.log('');
            console.log(`Creating ${n} new song${n === 1 ? '' : 's'}`);
            if (opts.theme) console.log(`  theme: ${opts.theme}`);
            if (opts.genre) console.log(`  genre: ${opts.genre}`);
            if (opts.mood) console.log(`  mood:  ${opts.mood}`);
            console.log('');

            const progress = makeProgress();
            const results = await stageLyrics(config, {
                n,
                theme: opts.theme,
                genre: opts.genre,
                mood: opts.mood,
                onProgress: progress.onProgress,
            });

            const failCount = results.filter((r) => !r.ok).length;
            const okCount = results.length - failCount;

            console.log('');
            console.log(`Done: ${okCount} succeeded, ${failCount} failed.`);
            console.log('');

            if (okCount > 0) {
                const table = new Table({
                    head: ['#', 'song', 'folder'],
                    colAligns: ['right', 'left', 'left'],
                    style: { head: [], border: [] },
                });
                let i = 1;
                for (const r of results) {
                    if (!r.ok) continue;
                    table.push([i++, r.title, path.basename(r.folder)]);
                }
                console.log(table.toString());
                console.log('');
            }

            if (failCount > 0) setExit(1);
        });
}
