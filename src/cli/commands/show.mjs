// src/cli/commands/show.mjs
// `resonate show [song]` — detailed per-song status view.

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../../song/config.mjs';
import { readMeta, targetFolders } from '../helpers.mjs';
import { measureLoudness } from '../../audio/loudness.mjs';
import { findThumbnail, VIDEO_FILENAME } from '../../video/generator.mjs';
import { parseSongMarkdown } from '../../song/lyrics/parser.mjs';

export function registerShow(program) {
    program
        .command('show [songFolder]')
        .description('Detailed status for one song (or all songs)')
        .option('--loudness', 'measure each song.wav with ffmpeg (slower)')
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

                if (i > 0) console.log('');
                console.log(chalk.bold(name));

                const songPath = path.join(folder, 'song.md');
                if (fs.existsSync(songPath)) {
                    const { title } = parseSongMarkdown(fs.readFileSync(songPath, 'utf8'));
                    if (title) console.log(`  title         ${chalk.bold(title)}`);
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
                    if (opts.loudness) await printLoudness(wavPath, config);
                } else {
                    console.log(`  song.wav      ${chalk.dim('[--]')}`);
                }

                const videoPath = path.join(folder, VIDEO_FILENAME);
                const thumb = findThumbnail(folder);
                if (fs.existsSync(videoPath)) {
                    const sizeMb = (fs.statSync(videoPath).size / 1024 / 1024).toFixed(1);
                    console.log(`  ${VIDEO_FILENAME.padEnd(13)} ${chalk.green('[OK]')}  ${sizeMb} MB`);
                } else if (!thumb) {
                    console.log(
                        `  ${VIDEO_FILENAME.padEnd(13)} ${chalk.yellow('[--]')}`
                        + `  ${chalk.yellow('thumbnail file not present')}`
                    );
                } else {
                    console.log(`  ${VIDEO_FILENAME.padEnd(13)} ${chalk.dim('[--]')}`);
                }
            }

            console.log('');
        });
}

/**
 * Measure a rendered WAV and report it against the configured target.
 *
 * Opt-in (`--loudness`) because it costs a full ffmpeg pass per song — fine
 * for one song, slow across a whole library.
 */
async function printLoudness(wavPath, config) {
    const target = config.render.loudness?.targetLufs ?? -14;
    const ceiling = config.render.loudness?.truePeakDb ?? -1;

    let measured;
    try {
        measured = await measureLoudness(wavPath);
    } catch (err) {
        console.log(`  loudness      ${chalk.dim(`[measure failed: ${err.message}]`)}`);
        return;
    }

    // loudnorm lands within a few tenths of the target, so allow that slack.
    const onTarget = Math.abs(measured.inputLufs - target) <= 0.7;
    const peakOk = measured.inputTruePeak <= ceiling + 0.1;
    const colour = onTarget && peakOk ? chalk.green : chalk.yellow;

    console.log(
        `  loudness      ${colour(`${measured.inputLufs.toFixed(1)} LUFS`)}`
        + `   ${colour(`${measured.inputTruePeak.toFixed(1)} dBFS peak`)}`
        + `   ${onTarget && peakOk ? chalk.green('on target') : colour(`target ${target} LUFS / ${ceiling} dBTP`)}`
    );
}
