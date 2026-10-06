// src/cli/commands/show.mjs
// `resonate show [song]` — detailed per-song status view.

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { readMeta, targetFolders } from '../helpers.mjs';

export function registerShow(program) {
    program
        .command('show [songFolder]')
        .description('Detailed status for one song (or all songs)')
        .action(async (songFolderArg) => {
            const config = loadConfig();
            const folders = targetFolders(config, songFolderArg);

            if (folders.length === 0) {
                console.log('No songs found.');
                return;
            }

            for (let i = 0; i < folders.length; i++) {
                const folder = folders[i];
                const name = path.basename(folder);

                if (i > 0) console.log('');
                console.log(chalk.bold(name));

                const songPath = path.join(folder, 'song.md');
                if (fs.existsSync(songPath)) {
                    const content = fs.readFileSync(songPath, 'utf8');
                    const m = content.match(/^#\s+TITLE\s*\n+([^\n#]+)/m);
                    if (m) console.log(`  title         ${chalk.bold(m[1].trim())}`);
                }

                const planPath = path.join(folder, 'plan.json');
                if (fs.existsSync(planPath)) {
                    console.log(`  plan.json     ${chalk.green('[OK]')}  ${fs.statSync(planPath).size} bytes`);
                } else {
                    console.log(`  plan.json     ${chalk.dim('[--]')}`);
                }

                if (fs.existsSync(songPath)) {
                    console.log(`  song.md       ${chalk.green('[OK]')}  ${fs.statSync(songPath).size} bytes`);
                } else {
                    console.log(`  song.md       ${chalk.dim('[--]')}`);
                }

                const abcPath = path.join(folder, 'score.abc');
                if (fs.existsSync(abcPath)) {
                    console.log(`  score.abc     ${chalk.green('[OK]')}  ${fs.statSync(abcPath).size} bytes`);
                } else {
                    console.log(`  score.abc     ${chalk.dim('[--]')}`);
                }

                const meta = readMeta(folder);
                if (meta) {
                    const requested = meta.requested_at
                        ? new Date(meta.requested_at).toLocaleString()
                        : '?';
                    console.log(`  score.meta    ${chalk.green('[OK]')}  seed=${meta.seed}`);
                    console.log(`                       model=${meta.model ?? '?'}`);
                    console.log(`                       elapsed=${(meta.elapsed_ms / 1000).toFixed(1)}s  requested=${requested}`);
                } else {
                    console.log(`  score.meta    ${chalk.dim('[--]')}`);
                }

                const midiPath = path.join(folder, 'score.mid');
                if (fs.existsSync(midiPath)) {
                    console.log(`  score.mid     ${chalk.green('[OK]')}  ${fs.statSync(midiPath).size} bytes`);
                } else {
                    console.log(`  score.mid     ${chalk.dim('[--]')}`);
                }

                const humanPath = path.join(folder, 'score.human.mid');
                if (fs.existsSync(humanPath)) {
                    const h = config.render.humanize;
                    const detail = h && h.enabled
                        ? `  (timing ±${h.timingMs}ms, vel ±${h.velocity}, roll ${h.rollMs}ms)`
                        : '';
                    console.log(`  score.human   ${chalk.green('[OK]')}  ${fs.statSync(humanPath).size} bytes${detail}`);
                } else {
                    console.log(`  score.human   ${chalk.dim('[--]')}`);
                }

                const wavPath = path.join(folder, 'song.wav');
                if (fs.existsSync(wavPath)) {
                    const sizeMb = (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1);
                    console.log(`  song.wav      ${chalk.green('[OK]')}  ${sizeMb} MB`);
                } else {
                    console.log(`  song.wav      ${chalk.dim('[--]')}`);
                }
            }

            console.log('');
        });
}
