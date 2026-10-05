#!/usr/bin/env node
// bin/cli.js — the resonate CLI.
//
// Design: every stage command takes an OPTIONAL song folder. When omitted,
// it operates on every song in songs/. Stages skip existing outputs unless
// --force is given.

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import Table from 'cli-table3';

import { loadConfig } from '../src/song/config.mjs';
import { runPlan, runWrite } from '../src/song/stages.mjs';
import {
    findSongFolders, resolveSongFolder,
} from '../src/song/paths.mjs';
import {
    stageLyrics, stageScore, stageMidi, stageRender, stageAll,
} from '../src/song/pipeline.mjs';

const program = new Command();

program
    .name('resonate')
    .description('Song generation: theme → lyrics → ABC → MIDI → WAV')
    .version('0.1.0');

// =====================================================================
// console helpers
// =====================================================================

const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const OK_TAG = '[OK]';
const FAIL_TAG = '[!!]';
const SKIP_TAG = '[--]';

function makeProgress() {
    return ({ phase, label, folder, result }) => {
        const id = label || (folder ? path.basename(folder) : '?');

        if (phase === 'start') {
            process.stderr.write(`${id} ... `);
        } else if (phase === 'done') {
            const parts = [];
            if (result?.title) parts.push(result.title);
            if (result?.seed != null) parts.push(`seed=${result.seed}`);
            const extra = parts.length ? `  ${parts.join('  ')}` : '';
            process.stderr.write(`${OK_TAG}${extra}\n`);
        } else if (phase === 'skip') {
            const reason = result?.reason ?? 'skipped';
            process.stderr.write(`${DIM}${id} ... ${SKIP_TAG} (${reason})${RESET}\n`);
        } else if (phase === 'fail') {
            const firstLine = result?.error ? result.error.split('\n')[0] : 'failed';
            process.stderr.write(`${FAIL_TAG}  ${firstLine}\n`);
        }
    };
}

function printStageSummary(results, { stage, single = false }) {
    if (single) {
        const r = results[0];
        if (!r) return 0;
        if (r.skipped) {
            console.log(`\n  ${r.reason ?? 'skipped'}\n`);
            return 0;
        }
        if (!r.ok) {
            console.error(`\n  Error: ${r.error}\n`);
            return 1;
        }
        if (r.outputPath) console.log(`\n  ${r.outputPath}\n`);
        return 0;
    }

    const okCount = results.filter((r) => r.ok && !r.skipped).length;
    const skipCount = results.filter((r) => r.skipped).length;
    const failCount = results.filter((r) => !r.ok && !r.skipped).length;

    console.log('');
    console.log(`[${stage}] ${okCount} processed, ${skipCount} skipped, ${failCount} failed.`);
    console.log('');

    if (failCount > 0) {
        console.log('Failures:');
        for (const r of results) {
            if (r.ok || r.skipped) continue;
            const name = r.folder ? path.basename(r.folder) : '(unknown)';
            console.log(`  - ${name}  —  ${r.error.split('\n')[0]}`);
        }
        console.log('');
    }

    return failCount === 0 ? 0 : 1;
}

// Set exit code instead of calling process.exit() so stdout flushes on Windows.
function setExit(code) {
    if (code) process.exitCode = code;
}

// =====================================================================
// lyrics — create N new songs (plan + lyrics only)
// =====================================================================

program
    .command('lyrics')
    .description('Generate N new songs (plan.json + song.md only)')
    .option('-n, --n <count>', 'number of songs to create', parseInt, 1)
    .option('-t, --theme <text>', 'theme seed (single-song mode only)')
    .option('-g, --genre <text>', 'genre seed reused across all songs')
    .option('-m, --mood <text>', 'mood seed reused across all songs')
    .action(async (opts) => {
        const config = loadConfig();
        const n = opts.n;

        if (!Number.isInteger(n) || n < 1) {
            console.error(`--n must be a positive integer`);
            setExit(1);
            return;
        }
        if (n > 1 && opts.theme) {
            console.error(`--theme can only be used with --n 1 (got --n ${n})`);
            setExit(1);
            return;
        }

        console.log('');
        console.log(`Creating ${n} new song${n === 1 ? '' : 's'}`);
        if (opts.theme) console.log(`  theme: ${opts.theme}`);
        if (opts.genre) console.log(`  genre: ${opts.genre}`);
        if (opts.mood) console.log(`  mood:  ${opts.mood}`);
        console.log('');

        const results = await stageLyrics(config, {
            n,
            theme: opts.theme,
            genre: opts.genre,
            mood: opts.mood,
            onProgress: makeProgress(),
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

// =====================================================================
// score — one song or all songs
// =====================================================================

program
    .command('score [songFolder]')
    .description('Generate score.abc (song.md → score.abc via YuE2)')
    .option('--force', 'regenerate even if score.abc already exists')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const single = Boolean(songFolderArg);

        if (single) {
            const folder = resolveSongFolder(config, songFolderArg);
            const results = await stageScore(config, {
                folder, force: Boolean(opts.force),
            });
            setExit(printStageSummary(results, { stage: 'score', single: true }));
            return;
        }

        console.log('');
        console.log('Scoring songs (YuE2)');
        if (opts.force) console.log('  mode: force');
        console.log('');

        const results = await stageScore(config, {
            force: Boolean(opts.force),
            onProgress: makeProgress(),
        });
        setExit(printStageSummary(results, { stage: 'score' }));
    });

// =====================================================================
// midi — one song or all songs
// =====================================================================

program
    .command('midi [songFolder]')
    .description('Convert score.abc → score.mid via abcjs')
    .option('--force', 'regenerate even if score.mid already exists')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const single = Boolean(songFolderArg);

        if (single) {
            const folder = resolveSongFolder(config, songFolderArg);
            const results = await stageMidi(config, {
                folder,
                force: Boolean(opts.force),
            });
            setExit(printStageSummary(results, { stage: 'midi', single: true }));
            return;
        }

        console.log('');
        console.log('Rendering MIDI');
        if (opts.force) console.log('  mode: force');
        console.log('');

        const results = await stageMidi(config, {
            force: Boolean(opts.force),
            onProgress: makeProgress(),
        });
        setExit(printStageSummary(results, { stage: 'midi' }));
    });

// =====================================================================
// render — one song or all songs
// =====================================================================

program
    .command('render [songFolder]')
    .description('Render score.mid → song.wav')
    .option('--force', 'regenerate even if song.wav already exists')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const single = Boolean(songFolderArg);

        if (single) {
            const folder = resolveSongFolder(config, songFolderArg);
            const results = await stageRender(config, {
                folder, force: Boolean(opts.force),
            });
            setExit(printStageSummary(results, { stage: 'render', single: true }));
            return;
        }

        console.log('');
        console.log('Rendering audio');
        if (opts.force) console.log('  mode: force');
        console.log('');

        const results = await stageRender(config, {
            force: Boolean(opts.force),
            onProgress: makeProgress(),
        });
        setExit(printStageSummary(results, { stage: 'render' }));
    });

// =====================================================================
// all — score + midi + render
// =====================================================================

program
    .command('all [songFolder]')
    .description('Run score → midi → render (one song or all songs)')
    .option('--force', 'regenerate all intermediate outputs')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const single = Boolean(songFolderArg);
        const folder = single ? resolveSongFolder(config, songFolderArg) : null;

        console.log('');
        console.log(single ? `Running pipeline for ${path.basename(folder)}` : 'Running pipeline for all songs');
        if (opts.force) console.log('  mode: force');
        console.log('');

        const results = await stageAll(config, {
            folder,
            force: Boolean(opts.force),
            onProgress: single ? null : makeProgress(),
        });

        setExit(printStageSummary(results, { stage: 'all', single }));
    });

// =====================================================================
// plan — dev tool
// =====================================================================

program
    .command('plan')
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

// =====================================================================
// write — dev tool
// =====================================================================

program
    .command('write <planJson>')
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

// =====================================================================
// list
// =====================================================================

program
    .command('list')
    .description('List all songs and which stages have been completed')
    .action(async () => {
        const config = loadConfig();
        const folders = findSongFolders(config.paths.songsDir);

        if (folders.length === 0) {
            console.log('No songs yet. Run `resonate lyrics` to create some.');
            return;
        }

        const OK = `${GREEN}${OK_TAG}${RESET}`;
        const MISS = `${DIM}${SKIP_TAG}${RESET}`;

        const table = new Table({
            head: ['plan', 'lyrics', 'score', 'midi', 'wav', 'song'],
            colAligns: ['middle', 'middle', 'middle', 'middle', 'middle', 'left'],
            style: { head: [], border: [] },
        });

        for (const folder of folders) {
            const has = (f) => fs.existsSync(path.join(folder, f));
            table.push([
                has('plan.json') ? OK : MISS,
                has('song.md') ? OK : MISS,
                has('score.abc') ? OK : MISS,
                has('score.mid') ? OK : MISS,
                has('song.wav') ? OK : MISS,
                path.basename(folder),
            ]);
        }

        console.log('');
        console.log(table.toString());
        console.log('');
    });

await program.parseAsync(process.argv);