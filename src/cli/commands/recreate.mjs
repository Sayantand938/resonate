// src/cli/commands/recreate.mjs
// `resonate recreate [song]` — re-issue the saved YuE2 request.

import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { runScore } from '../../song/stages.mjs';
import { readMeta, targetFolders } from '../helpers.mjs';
import { setExit } from '../summary.mjs';

export function registerRecreate(program) {
    program
        .command('recreate [songFolder]')
        .description('Regenerate score.abc from score.meta.json (uses the saved seed)')
        .action(async (songFolderArg) => {
            const config = loadConfig();
            const folders = targetFolders(config, songFolderArg);

            if (folders.length === 0) {
                console.log('No songs found.');
                return;
            }

            console.log('');
            console.log(songFolderArg
                ? `Recreating ${path.basename(folders[0])}`
                : 'Recreating all songs with metadata');
            console.log('');

            let okCount = 0;
            let skipCount = 0;
            let failCount = 0;
            const failures = [];

            for (const folder of folders) {
                const name = path.basename(folder);
                const meta = readMeta(folder);

                if (!meta) {
                    console.log(`${chalk.bold(name)}`);
                    console.log(`  score   ${chalk.dim('[--]')} (no score.meta.json)`);
                    skipCount++;
                    continue;
                }

                // Transcribed songs have no seed to re-issue -- they are not a
                // sampled generation, so recreating means re-listening.
                if (meta.provider && meta.provider !== 'yue2') {
                    console.log(`${chalk.bold(name)}`);
                    console.log(`  score   ${chalk.dim('[--]')} (${meta.provider}; use \`resonate transcribe --force\`)`);
                    skipCount++;
                    continue;
                }

                if (meta.seed == null) {
                    console.log(`${chalk.bold(name)}`);
                    console.log(`  score   ${chalk.red('[!!]')}  no seed in metadata`);
                    failCount++;
                    failures.push({ name, error: 'no seed in metadata' });
                    continue;
                }

                const recreateConfig = JSON.parse(JSON.stringify(config));
                recreateConfig.score.seedMode = 'fixed';
                recreateConfig.score.seed = meta.seed;

                process.stderr.write(`${chalk.bold(name)}\n`);
                process.stderr.write(`  score   ... `);

                try {
                    const out = await runScore(recreateConfig, folder);
                    const extra = out.title ? `  ${out.title}` : '';
                    process.stderr.write(`${chalk.green('[OK]')}  seed=${meta.seed}${extra}\n`);
                    okCount++;
                } catch (err) {
                    process.stderr.write(`${chalk.red('[!!]')}  ${err.message.split('\n')[0]}\n`);
                    failCount++;
                    failures.push({ name, error: err.message });
                }
            }

            console.log('');
            console.log(`[recreate] ${okCount} recreated, ${skipCount} skipped, ${failCount} failed.`);
            console.log('');

            if (failCount > 0) {
                console.log('Failures:');
                for (const f of failures) {
                    console.log(`  - ${chalk.red(f.name)}  —  ${f.error.split('\n')[0]}`);
                }
                console.log('');
                setExit(1);
            }
        });
}
