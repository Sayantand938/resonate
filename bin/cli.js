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
import { runPlan, runWrite, runScore } from '../src/song/stages.mjs';
import {
    findSongFolders, resolveSongFolder,
} from '../src/song/paths.mjs';
import {
    stageLyrics, stageScore, stageMidi, stageRender, stageAll,
} from '../src/song/pipeline.mjs';

const program = new Command();

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

function setExit(code) {
    if (code) process.exitCode = code;
}

// Shared metadata reader. Returns null if score.meta.json is missing or
// unparseable. Used by list, show, meta, and recreate.
function readMeta(folder) {
    const metaPath = path.join(folder, 'score.meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
        return null;
    }
}

// Shared stage-command handler. Handles both single-folder and batch
// modes, wires up progress output, and prints the summary.
async function runStageCommand({
    stageName,
    stageFn,
    description,
    songFolderArg,
    opts,
    config,
    extraArgs = {},
}) {
    const single = Boolean(songFolderArg);

    if (single) {
        const folder = resolveSongFolder(config, songFolderArg);
        const results = await stageFn(config, {
            folder,
            force: Boolean(opts.force),
            ...extraArgs,
        });
        setExit(printStageSummary(results, { stage: stageName, single: true }));
        return;
    }

    console.log('');
    console.log(description);
    if (opts.force) console.log('  mode: force');
    console.log('');

    const results = await stageFn(config, {
        force: Boolean(opts.force),
        onProgress: makeProgress(),
        ...extraArgs,
    });
    setExit(printStageSummary(results, { stage: stageName }));
}

// =====================================================================
// program setup
// =====================================================================

program
    .name('resonate')
    .description('Song generation: theme → lyrics → ABC → MIDI → WAV')
    .version('0.1.0');

program.configureHelp({
    subcommandTerm: (cmd) => cmd.name() + (cmd.usage() ? ' ' + cmd.usage() : ''),
});

// =====================================================================
// lyrics — create N new songs (plan + lyrics only)
// =====================================================================

program
    .command('lyrics')
    .description('Create N new songs (plan.json + song.md)')
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
    .description('Generate score.abc + score.meta.json via YuE2')
    .option('--force', 'regenerate even if score.abc already exists')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        await runStageCommand({
            stageName: 'score',
            stageFn: stageScore,
            description: 'Scoring songs (YuE2)',
            songFolderArg,
            opts,
            config,
        });
    });

// =====================================================================
// midi — one song or all songs
// =====================================================================

program
    .command('midi [songFolder]')
    .description('Render score.abc → score.mid via abcjs (and humanize)')
    .option('--force', 'regenerate even if score.mid already exists')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        await runStageCommand({
            stageName: 'midi',
            stageFn: stageMidi,
            description: 'Rendering MIDI',
            songFolderArg,
            opts,
            config,
        });
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
        await runStageCommand({
            stageName: 'render',
            stageFn: stageRender,
            description: 'Rendering audio',
            songFolderArg,
            opts,
            config,
        });
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
        await runStageCommand({
            stageName: 'all',
            stageFn: stageAll,
            description: songFolderArg
                ? `Running pipeline for ${path.basename(songFolderArg)}`
                : 'Running pipeline for all songs',
            songFolderArg,
            opts,
            config,
            // In batch mode, stageAll concatenates results across stages.
            // The summary below treats them uniformly.
        });
    });

// =====================================================================
// recreate — re-issue the exact same YuE2 call
// =====================================================================

program
    .command('recreate [songFolder]')
    .description('Regenerate score.abc from score.meta.json (uses the saved seed)')
    .action(async (songFolderArg) => {
        const config = loadConfig();

        let folders;
        if (songFolderArg) {
            folders = [resolveSongFolder(config, songFolderArg)];
        } else {
            folders = findSongFolders(config.paths.songsDir);
        }

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
                console.log(`${DIM}${name} ... ${SKIP_TAG} (no score.meta.json)${RESET}`);
                skipCount++;
                continue;
            }

            if (meta.seed == null) {
                console.error(`${FAIL_TAG} ${name}: score.meta.json has no seed`);
                failCount++;
                failures.push({ name, error: 'no seed in metadata' });
                continue;
            }

            // Build a temporary config with a fixed seed matching the
            // saved one, so the score stage issues the exact same request.
            const recreateConfig = JSON.parse(JSON.stringify(config));
            recreateConfig.score.seedMode = 'fixed';
            recreateConfig.score.seed = meta.seed;

            process.stderr.write(`${name} ... `);

            try {
                const out = await runScore(recreateConfig, folder);
                const extra = out.title ? `  ${out.title}` : '';
                process.stderr.write(`${OK_TAG}  seed=${meta.seed}${extra}\n`);
                okCount++;
            } catch (err) {
                process.stderr.write(`${FAIL_TAG}  ${err.message.split('\n')[0]}\n`);
                failCount++;
                failures.push({ name, error: err.message });
            }
        }

        console.log('');
        console.log(`[recreate] ${okCount} processed, ${skipCount} skipped, ${failCount} failed.`);
        console.log('');

        if (failCount > 0) {
            console.log('Failures:');
            for (const f of failures) {
                console.log(`  - ${f.name}  —  ${f.error.split('\n')[0]}`);
            }
            console.log('');
            setExit(1);
        }
    });

// =====================================================================
// list — table view of every song
// =====================================================================

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

        const OK = `${GREEN}${OK_TAG}${RESET}`;
        const MISS = `${DIM}${SKIP_TAG}${RESET}`;

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

// =====================================================================
// show — detailed status for one song (or all)
// =====================================================================

program
    .command('show [songFolder]')
    .description('Detailed status for one song (or all songs)')
    .action(async (songFolderArg) => {
        const config = loadConfig();

        let folders;
        if (songFolderArg) {
            folders = [resolveSongFolder(config, songFolderArg)];
        } else {
            folders = findSongFolders(config.paths.songsDir);
        }

        if (folders.length === 0) {
            console.log('No songs found.');
            return;
        }

        for (let i = 0; i < folders.length; i++) {
            const folder = folders[i];
            const name = path.basename(folder);

            if (folders.length > 1) {
                if (i > 0) console.log('');
                console.log(`=== ${name} ===`);
            } else {
                console.log(name);
            }

            // Title from song.md
            const songPath = path.join(folder, 'song.md');
            if (fs.existsSync(songPath)) {
                const content = fs.readFileSync(songPath, 'utf8');
                const m = content.match(/^#\s+TITLE\s*\n+([^\n#]+)/m);
                if (m) console.log(`  title         ${m[1].trim()}`);
            }

            // plan.json
            const planPath = path.join(folder, 'plan.json');
            if (fs.existsSync(planPath)) {
                console.log(`  plan.json     [OK]  ${fs.statSync(planPath).size} bytes`);
            } else {
                console.log(`  plan.json     [--]`);
            }

            // song.md
            if (fs.existsSync(songPath)) {
                console.log(`  song.md       [OK]  ${fs.statSync(songPath).size} bytes`);
            } else {
                console.log(`  song.md       [--]`);
            }

            // score.abc
            const abcPath = path.join(folder, 'score.abc');
            if (fs.existsSync(abcPath)) {
                console.log(`  score.abc     [OK]  ${fs.statSync(abcPath).size} bytes`);
            } else {
                console.log(`  score.abc     [--]`);
            }

            // score.meta.json
            const meta = readMeta(folder);
            if (meta) {
                const requested = meta.requested_at
                    ? new Date(meta.requested_at).toLocaleString()
                    : '?';
                console.log(`  score.meta    [OK]  seed=${meta.seed}`);
                console.log(`                       model=${meta.model ?? '?'}`);
                console.log(`                       elapsed=${(meta.elapsed_ms / 1000).toFixed(1)}s  requested=${requested}`);
            } else {
                console.log(`  score.meta    [--]`);
            }

            // score.mid
            const midiPath = path.join(folder, 'score.mid');
            if (fs.existsSync(midiPath)) {
                console.log(`  score.mid     [OK]  ${fs.statSync(midiPath).size} bytes`);
            } else {
                console.log(`  score.mid     [--]`);
            }

            // score.human.mid
            const humanPath = path.join(folder, 'score.human.mid');
            if (fs.existsSync(humanPath)) {
                const h = config.render.humanize;
                const detail = h && h.enabled
                    ? `  (timing ±${h.timingMs}ms, vel ±${h.velocity}, roll ${h.rollMs}ms)`
                    : '';
                console.log(`  score.human   [OK]  ${fs.statSync(humanPath).size} bytes${detail}`);
            } else {
                console.log(`  score.human   [--]`);
            }

            // song.wav
            const wavPath = path.join(folder, 'song.wav');
            if (fs.existsSync(wavPath)) {
                const sizeMb = (fs.statSync(wavPath).size / 1024 / 1024).toFixed(1);
                console.log(`  song.wav      [OK]  ${sizeMb} MB`);
            } else {
                console.log(`  song.wav      [--]`);
            }
        }

        if (folders.length === 1) {
            console.log('');
        }
    });

// =====================================================================
// meta — YuE2 generation info
// =====================================================================

program
    .command('meta [songFolder]')
    .description('Show the saved YuE2 generation info for a song (or all songs)')
    .option('--json', 'print the raw JSON instead of a summary')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();

        let folders;
        if (songFolderArg) {
            folders = [resolveSongFolder(config, songFolderArg)];
        } else {
            folders = findSongFolders(config.paths.songsDir);
        }

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
                console.log(`${name}: [--] no score.meta.json`);
                continue;
            }

            if (opts.json) {
                if (folders.length > 1) {
                    console.log(`=== ${name} ===`);
                }
                console.log(JSON.stringify(meta, null, 2));
                if (i < folders.length - 1) console.log('');
                continue;
            }

            // Summary view
            if (folders.length > 1) {
                if (i > 0) console.log('');
                console.log(`=== ${name} ===`);
            } else {
                console.log(name);
            }

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
            if (folders.length === 1 && meta.recreate_hint) {
                console.log('');
                console.log(`  recreate      resonate recreate ${name}`);
            }
        }

        console.log('');
    });

// =====================================================================
// plan — dev tool (hidden from help)
// =====================================================================

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

// =====================================================================
// write — dev tool (hidden from help)
// =====================================================================

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

// =====================================================================
// default action: no arguments prints the help text
// =====================================================================

program.action(() => {
    program.help();
});

await program.parseAsync(process.argv);