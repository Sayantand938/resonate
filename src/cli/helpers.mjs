// src/cli/helpers.mjs
// Shared helpers used across CLI commands.

import fs from 'node:fs';
import path from 'node:path';
import { resolveSongFolder, findSongFolders } from '../song/paths.mjs';
import { makeProgress } from './progress.mjs';
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

const nameOf = (folder) => path.basename(folder);

// Wide enough for the longest song folder in a batch, so the stage column
// lines up. Capped so one absurd folder name cannot push every line across
// the terminal.
const ID_WIDTH_CAP = 42;

function idWidthFor(folders) {
    let max = 0;
    for (const f of folders) max = Math.max(max, nameOf(f).length);
    return Math.min(max, ID_WIDTH_CAP);
}

/**
 * Run a stage command (score, transcribe, midi, render, video, all) in
 * single or batch mode. Handles progress printing, the end-of-run summary,
 * and the exit code.
 *
 * @param {Object} opts
 * @param {string} opts.stageName       'score' | 'transcribe' | 'midi' | ...
 * @param {Function} opts.stageFn       stageScore | stageMidi | stageRender | ...
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
    const folders = targetFolders(config, songFolderArg);

    // A single-song run produces one line, so a skip is worth printing. A
    // batch run does not -- see the note in progress.mjs.
    const progress = makeProgress({
        showSkips: single,
        idWidth: idWidthFor(folders),
    });

    try {
        if (single) {
            const results = await stageFn(config, {
                folder: folders[0],
                force: Boolean(cmdOpts.force),
                onProgress: progress.onProgress,
            });
            const code = printStageSummary(results, { stage: stageName, single: true });
            if (code) process.exitCode = code;
            return;
        }

        console.log('');
        console.log(description);
        if (cmdOpts.force) console.log('  mode: force');
        console.log('');

        const results = await stageFn(config, {
            force: Boolean(cmdOpts.force),
            onProgress: progress.onProgress,
        });

        const code = printStageSummary(results, { stage: stageName });
        if (code) process.exitCode = code;
    } finally {
        // A ticker must not outlive its stage.
        progress.stop();
    }
}
