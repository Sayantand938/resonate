// src/cli/helpers.mjs
// Shared helpers used across CLI commands.

import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import { resolveSongFolder, findSongFolders } from '../song/paths.mjs';
import { makeProgress, printGroupedProgress } from './progress.mjs';
import { printStageSummary } from './summary.mjs';

/**
 * Read score.meta.json for a song folder. Returns null if missing or
 * unparseable.
 */
export function readMeta(folder) {
    const metaPath = path.join(folder, 'score.meta.json');
    if (!fs.existsSync(metaPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Resolve the set of target folders for a command. If songFolderArg is
 * given, resolve it to a single folder. Otherwise, list all folders.
 */
export function targetFolders(config, songFolderArg) {
    if (songFolderArg) {
        return [resolveSongFolder(config, songFolderArg)];
    }
    return findSongFolders(config.paths.songsDir);
}

/**
 * Run a stage command (score, midi, render, all) in single or batch
 * mode. Handles progress printing, grouped summary, and exit code.
 *
 * @param {Object} opts
 * @param {string} opts.stageName       'score' | 'midi' | 'render' | 'all'
 * @param {Function} opts.stageFn       stageScore | stageMidi | stageRender | stageAll
 * @param {string} opts.description     printed at the top of batch runs
 * @param {string} [opts.songFolderArg] optional positional from commander
 * @param {Object} opts.cmdOpts         the commander options object
 * @param {Object} opts.config          loaded config
 */
export async function runStageCommand({
    stageName,
    stageFn,
    description,
    songFolderArg,
    cmdOpts,
    config,
}) {
    const single = Boolean(songFolderArg);

    if (single) {
        const folder = resolveSongFolder(config, songFolderArg);
        const results = await stageFn(config, {
            folder,
            force: Boolean(cmdOpts.force),
        });
        const code = printStageSummary(results, { stage: stageName, single: true });
        if (code) process.exitCode = code;
        return;
    }

    console.log('');
    console.log(description);
    if (cmdOpts.force) console.log('  mode: force');
    console.log('');

    const progress = makeProgress();
    const results = await stageFn(config, {
        force: Boolean(cmdOpts.force),
        onProgress: progress.onProgress,
    });

    printGroupedProgress(progress.getEvents());
    const code = printStageSummary(results, { stage: stageName });
    if (code) process.exitCode = code;
}
