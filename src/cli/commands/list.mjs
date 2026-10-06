// src/cli/commands/list.mjs
// `resonate list` — table view of every song and its pipeline status.

import fs from 'node:fs';
import path from 'node:path';
import Table from 'cli-table3';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { findSongFolders } from '../../song/paths.mjs';
import { readMeta } from '../helpers.mjs';

export function registerList(program) {
    program
        .command('list')
        .description('Table view of every song and its pipeline status')
        .action(async () => {
            const config = loadConfig();
            const folders = findSongFolders(config.paths.songsDir);

            if (folders.length === 0) {
                console.log('No songs yet. Run `resonate lyrics` to create some.');
                return;
            }

            const OK = chalk.green('[OK]');
            const MISS = chalk.dim('[--]');

            const table = new Table({
                head: ['plan', 'lyrics', 'score', 'meta', 'midi', 'wav', 'song'],
                colAligns: ['middle', 'middle', 'middle', 'middle', 'middle', 'middle', 'left'],
                style: { head: [], border: [] },
            });

            for (const folder of folders) {
                const has = (f) => fs.existsSync(path.join(folder, f));
                const meta = readMeta(folder);

                table.push([
                    has('plan.json') ? OK : MISS,
                    has('song.md') ? OK : MISS,
                    has('score.abc') ? OK : MISS,
                    meta ? OK : MISS,
                    has('score.mid') ? OK : MISS,
                    has('song.wav') ? OK : MISS,
                    path.basename(folder),
                ]);
            }

            console.log('');
            console.log(table.toString());
            console.log('');
            console.log(`${OK}=present  ${MISS}=missing`);
            console.log('');
        });
}
