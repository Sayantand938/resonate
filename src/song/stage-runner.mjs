// src/song/stage-runner.mjs
// The shared per-folder loop every folder-iterating stage goes through.
//
// A stage is a set of declarations:
//   - what to check for as its input  (hasInput)
//   - what to check for as its output (hasOutput)
//   - what to actually do             (run)
//
// `runStage` walks the target folders once, applying the same shape to each:
// skip when the input is missing, skip when the output exists (unless
// forced), otherwise run and record OK or failure. Stages never re-implement
// that shape; they declare, and this walks.
//
// Progress events:
//   { phase: 'start'|'done'|'skip'|'fail', stage, folder, label?, result? }
//
// `stage` is set on every event here, so downstream consumers (the CLI) can
// prefix batch output with the stage name without each stage remembering to.

import path from 'node:path';
import { findSongFolders } from './paths.mjs';

// =====================================================================
// result constructors
//
// Every stage returns an array of these, and the CLI summary distinguishes
// them by the presence of `ok`, `skipped`, and `error`. Keeping the shape
// defined in one place is what lets `summary.mjs` group by stage and reason
// without each stage inventing its own result vocabulary.
// =====================================================================

export function resultOk(folder, extra = {}) {
    return { ok: true, folder, ...extra };
}

export function resultSkip(folder, reason, stage, extra = {}) {
    return { ok: true, folder, skipped: true, reason, stage, ...extra };
}

export function resultFail(folder, error, stage) {
    return { ok: false, folder, error, stage };
}

// =====================================================================
// progress tagging
//
// Every progress event a stage emits should carry its own stage name, so
// the CLI's progress printer can prefix it without the stage passing its
// name along on every call. Stages hand `runStage` their raw `onProgress`,
// and `runStage` wraps it once.
// =====================================================================

export function taggedProgress(onProgress, stage) {
    if (!onProgress) return undefined;
    return (event) => onProgress({ ...event, stage });
}

// =====================================================================
// folder resolution
// =====================================================================

export function listTargetFolders(songsDir, folder) {
    if (folder) return [folder];
    return findSongFolders(songsDir);
}

const nameOf = (folder) => (folder ? path.basename(folder) : '(unknown)');

// =====================================================================
// the loop
// =====================================================================

/**
 * @param {Object} opts
 * @param {string} opts.stage            stage name used in results and progress
 * @param {string} opts.songsDir         directory to scan when folder is null
 * @param {string|null} opts.folder      one folder, or null for the whole library
 * @param {boolean} opts.force
 * @param {Function} opts.onProgress
 * @param {string} opts.inputLabel       human-readable input name, for skip reasons
 * @param {string} opts.outputLabel      human-readable output name, for skip reasons
 * @param {(folder:string) => boolean} opts.hasInput
 * @param {(folder:string) => boolean} opts.hasOutput
 * @param {(folder:string) => string|null} [opts.extraSkipReason]
 *   Optional: return a non-null reason to skip a folder that passed the
 *   input/output checks. Used by video for the missing-thumbnail case.
 * @param {boolean} [opts.extraSkipWarn=false] mark that extra skip as a warning
 * @param {(folder:string) => Promise<Object>} opts.run
 *   Returns an object whose fields are merged into the OK result.
 * @returns {Promise<Array>}
 */
export async function runStage({
    stage,
    songsDir,
    folder = null,
    force = false,
    onProgress,
    inputLabel,
    outputLabel,
    hasInput,
    hasOutput,
    extraSkipReason = null,
    extraSkipWarn = false,
    run,
}) {
    const folders = listTargetFolders(songsDir, folder);
    const results = [];
    const progress = taggedProgress(onProgress, stage);

    for (const f of folders) {
        const name = nameOf(f);

        if (!hasInput(f)) {
            const r = resultSkip(f, `no ${inputLabel}`, stage);
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (hasOutput(f) && !force) {
            const r = resultSkip(f, `${outputLabel} exists`, stage);
            results.push(r);
            if (progress) progress({ phase: 'skip', folder: f, result: r });
            continue;
        }
        if (extraSkipReason) {
            const reason = extraSkipReason(f);
            if (reason) {
                const r = resultSkip(f, reason, stage, { warn: extraSkipWarn });
                results.push(r);
                if (progress) progress({ phase: 'skip', folder: f, result: r });
                continue;
            }
        }

        if (progress) progress({ phase: 'start', folder: f, label: name });
        try {
            const out = await run(f);
            const r = resultOk(f, { stage, ...out });
            results.push(r);
            if (progress) progress({ phase: 'done', folder: f, result: r });
        } catch (err) {
            const r = resultFail(f, err.message, stage);
            results.push(r);
            if (progress) progress({ phase: 'fail', folder: f, result: r });
        }
    }

    return results;
}

// =====================================================================
// multi-stage sequencing
//
// `all` chains three stages. In single-folder mode it stops at the first
// hard failure — no point running `render` over a folder whose MIDI
// generation just threw. In batch mode it runs all three regardless, so
// one broken song does not stop the other nine from reaching the renderer.
// =====================================================================

export function hasHardFailure(results) {
    return results.some((r) => !r.ok && !r.skipped);
}

/**
 * Run `stages` in sequence, concatenating their results.
 *
 * @param {Function[]} stages   each takes (config, { folder, force, onProgress })
 * @param {Object} opts
 * @param {Object} opts.config
 * @param {string|null} opts.folder
 * @param {boolean} opts.force
 * @param {Function} opts.onProgress
 * @param {boolean} opts.shortCircuit  stop after the first stage that fails hard
 * @returns {Promise<Array>}
 */
export async function runSequential(stages, {
    config,
    folder,
    force,
    onProgress,
    shortCircuit,
}) {
    const results = [];
    for (const stageFn of stages) {
        const stageResults = await stageFn(config, { folder, force, onProgress });
        results.push(...stageResults);
        if (shortCircuit && hasHardFailure(stageResults)) break;
    }
    return results;
}