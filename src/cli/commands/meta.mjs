// src/cli/commands/meta.mjs
// `resonate meta [song]` — YuE2 generation info for one song or all songs.

import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { readMeta, targetFolders } from '../helpers.mjs';
import { setExit } from '../summary.mjs';

export function registerMeta(program) {
    program
        .command('meta [songFolder]')
        .description('Show the saved YuE2 generation info for a song (or all songs)')
        .option('--json', 'print the raw JSON instead of a summary')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            const folders = targetFolders(config, songFolderArg);

            if (folders.length === 0) {
                console.log('No songs found.');
                return;
            }

            for (let i = 0; i < folders.length; i++) {
                const folder = folders[i];
                const name = path.basename(folder);
                const meta = readMeta(folder);

                if (!meta) {
                    if (folders.length === 1) {
                        console.error(`No score.meta.json in ${folder}`);
                        setExit(1);
                        return;
                    }
                    console.log(`${name}: ${chalk.dim('[--]')} no score.meta.json`);
                    continue;
                }

                if (opts.json) {
                    if (folders.length > 1) console.log(`=== ${name} ===`);
                    console.log(JSON.stringify(meta, null, 2));
                    if (i < folders.length - 1) console.log('');
                    continue;
                }

                if (i > 0) console.log('');
                console.log(chalk.bold(name));

                const req = meta.requested_at
                    ? new Date(meta.requested_at).toLocaleString()
                    : '?';
                const elapsed = typeof meta.elapsed_ms === 'number'
                    ? `${(meta.elapsed_ms / 1000).toFixed(1)}s`
                    : '?';

                console.log(`  provider      ${meta.provider ?? '?'}`);
                console.log(`  model         ${meta.model ?? '?'}`);
                console.log(`  endpoint      ${meta.endpoint ?? '?'}`);
                console.log(`  seed          ${meta.seed ?? '?'}`);
                console.log(`  requested     ${req}`);
                console.log(`  elapsed       ${elapsed}`);
                if (meta.response_summary) {
                    const rs = meta.response_summary;
                    console.log(`  abc           ${rs.abc_length ?? '?'} bytes, ${rs.abc_lines ?? '?'} lines`);
                }
                if (folders.length === 1) {
                    console.log('');
                    console.log(`  recreate      ${chalk.dim('resonate recreate')} ${name}`);
                }
            }

            console.log('');
        });
}
