#!/usr/bin/env node
// bin/cli.js — the resonate CLI.
// One binary. Subcommands: plan, write, score, midi, render, song, list.

import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import Table from 'cli-table3';

import { loadConfig } from '../src/song/config.mjs';
import { runPlan, runWrite, runScore, runMidi, runRender, runSong }
    from '../src/song/stages.mjs';
import { resolveSongFolder, findSongFolders } from '../src/song/paths.mjs';

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
const MISS_TAG = '[--]';

async function step(label, fn) {
    process.stderr.write(`${label} ... `);
    try {
        const result = await fn();
        process.stderr.write(`${OK_TAG}\n`);
        return result;
    } catch (err) {
        process.stderr.write(`${FAIL_TAG}\n`);
        throw err;
    }
}

function printSongSummary(result, { showPlan = false } = {}) {
    console.log('');
    console.log(`  ${result.title}`);
    console.log(`  ${result.folder}`);
    if (showPlan && result.planPath) console.log(`  plan  → ${path.basename(result.planPath)}`);
    if (result.abcPath) console.log(`  abc   → ${path.basename(result.abcPath)}`);
    if (result.midiPath) console.log(`  midi  → ${path.basename(result.midiPath)}`);
    if (result.wavPath) console.log(`  wav   → ${path.basename(result.wavPath)}`);
}

// =====================================================================
// song
// =====================================================================

program
    .command('song')
    .description('Full pipeline: plan → write → score → midi → render')
    .option('-t, --theme <text>', 'theme seed')
    .option('-g, --genre <text>', 'genre seed')
    .option('-m, --mood <text>', 'mood seed')
    .option('--dry-score', 'skip YuE2; use a placeholder score (offline)')
    .option('--keep', 'keep intermediate files')
    .action(async (opts) => {
        const config = loadConfig();

        const result = await step('Composing the song', () =>
            runSong(config, {
                theme: opts.theme,
                genre: opts.genre,
                mood: opts.mood,
                dryScore: Boolean(opts.dryScore),
                keep: Boolean(opts.keep),
            })
        );

        printSongSummary(result, { showPlan: true });
        console.log('');
    });

// =====================================================================
// plan
// =====================================================================

program
    .command('plan')
    .description('Generate a song plan from a seed')
    .option('-t, --theme <text>')
    .option('-g, --genre <text>')
    .option('-m, --mood <text>')
    .option('-o, --output <file>', 'write plan to this file instead of stdout')
    .action(async (opts) => {
        const config = loadConfig();
        const plan = await step('Planning the song', () =>
            runPlan(config, {
                theme: opts.theme,
                genre: opts.genre,
                mood: opts.mood,
            })
        );

        const json = JSON.stringify(plan, null, 2) + '\n';
        if (opts.output) {
            fs.writeFileSync(opts.output, json, 'utf8');
            console.log(`\n  ${opts.output}\n`);
        } else {
            process.stdout.write(json);
        }
    });

// =====================================================================
// write
// =====================================================================

program
    .command('write <planJson>')
    .description('Write lyrics from plan.json (creates a song folder)')
    .action(async (planJson) => {
        const config = loadConfig();
        const plan = JSON.parse(fs.readFileSync(planJson, 'utf8'));

        const result = await step('Writing the lyrics', () =>
            runWrite(config, plan)
        );

        console.log('');
        console.log(`  ${result.title}`);
        console.log(`  ${result.folder}`);
        console.log('');
    });

// =====================================================================
// score
// =====================================================================

program
    .command('score <songFolder>')
    .description('Generate score.abc from song.md using YuE2')
    .option('--dry-run', 'write a placeholder ABC without calling YuE2')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const folder = resolveSongFolder(config, songFolderArg);
        const label = opts.dryRun ? 'Scoring (placeholder)' : 'Scoring with YuE2';

        const result = await step(label, () =>
            runScore(config, folder, { dryRun: Boolean(opts.dryRun) })
        );

        console.log(`\n  ${result.abcPath}\n`);
    });

// =====================================================================
// midi
// =====================================================================

program
    .command('midi <songFolder>')
    .description('Convert score.abc → score.mid via abcjs')
    .option('-p, --program <n>', 'override GM program (0-127)', parseInt)
    .option('-t, --tempo <bpm>', 'override tempo (BPM)', parseInt)
    .option('--title <text>', 'score title (default: from song.md)')
    .option('--composer <text>', 'composer (default: from config.yaml)')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const folder = resolveSongFolder(config, songFolderArg);

        const result = await step('Rendering MIDI', () =>
            runMidi(config, folder, {
                program: opts.program,
                tempo: opts.tempo,
                title: opts.title,
                composer: opts.composer,
            })
        );

        console.log(`\n  ${result.midiPath}\n`);
    });

// =====================================================================
// render
// =====================================================================

program
    .command('render <songFolder>')
    .description('Render score.mid → song.wav via FluidSynth + ffmpeg')
    .option('--sf <path>', 'SoundFont path (default: GeneralUser-GS)')
    .option('--gain <n>', 'FluidSynth master gain', parseFloat)
    .option('--lufs <n>', 'target loudness in LUFS', parseFloat)
    .option('--keep', 'keep intermediate files')
    .action(async (songFolderArg, opts) => {
        const config = loadConfig();
        const folder = resolveSongFolder(config, songFolderArg);

        const result = await step('Rendering audio', () =>
            runRender(config, folder, {
                soundfont: opts.sf,
                gain: opts.gain,
                lufs: opts.lufs,
                keep: Boolean(opts.keep),
            })
        );

        console.log(`\n  ${result.wavPath}\n`);
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
            console.log('No songs yet. Run `resonate song` to create one.');
            return;
        }

        const OK = `${GREEN}${OK_TAG}${RESET}`;
        const MISS = `${DIM}${MISS_TAG}${RESET}`;

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