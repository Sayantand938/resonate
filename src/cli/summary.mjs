// src/cli/summary.mjs
// End-of-run summaries and process exit code handling.

import path from 'node:path';
import chalk from 'chalk';

// [singular, plural] -- counts of 1 should not read "1 songs".
const STAGE_LABELS = {
    lyrics: ['song written', 'songs written'],
    score: ['song scored', 'songs scored'],
    transcribe: ['song transcribed', 'songs transcribed'],
    midi: ['song rendered to MIDI', 'songs rendered to MIDI'],
    render: ['song rendered to WAV', 'songs rendered to WAV'],
    video: ['song rendered to video', 'songs rendered to video'],
    all: ['operation', 'operations'],
};

export function setExit(code) {
    if (code) process.exitCode = code;
}

const nameOf = (r) => (r.folder ? path.basename(r.folder) : '(unknown)');

/**
 * Skips grouped by reason, most common first.
 *
 * A run where everything is already up to date is the normal case in daily
 * use, and listing eight songs skipped for the same reason says nothing the
 * count does not. Names are only worth printing while the list is short.
 *
 * A group containing any warned skip is coloured, so an actionable reason
 * like a missing thumbnail still stands out without needing one line per
 * song.
 */
function printSkips(skipped) {
    const byReason = new Map();
    for (const r of skipped) {
        const reason = r.reason ?? 'skipped';
        if (!byReason.has(reason)) byReason.set(reason, { names: [], warn: false });
        const group = byReason.get(reason);
        group.names.push(nameOf(r));
        if (r.warn) group.warn = true;
    }

    const rows = [...byReason.entries()]
        .sort((a, b) => b[1].names.length - a[1].names.length || a[0].localeCompare(b[0]));

    for (const [reason, group] of rows) {
        const count = String(group.names.length).padStart(3);
        const detail = group.names.length <= 3 ? `  (${group.names.join(', ')})` : '';
        if (group.warn) {
            console.log(chalk.yellow(`  ${count}  ${reason}${detail}`));
        } else {
            console.log(`  ${chalk.dim(count)}  ${reason}${chalk.dim(detail)}`);
        }
    }
}

export function printStageSummary(results, { stage, single = false }) {
    if (single) {
        const r = results[0];
        if (!r) return 0;
        // Live progress already reported OK/skip/fail, so only the artifact
        // path is worth repeating.
        if (r.ok && !r.skipped && r.outputPath) {
            console.log(`\n  ${r.outputPath}\n`);
        }
        return r.ok || r.skipped ? 0 : 1;
    }

    const done = results.filter((r) => r.ok && !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    const failed = results.filter((r) => !r.ok && !r.skipped);
    const warned = skipped.filter((r) => r.warn);
    const plainSkips = skipped.filter((r) => !r.warn);

    // Nothing needed doing -- one line plus the reason breakdown, instead of
    // replaying the whole library.
    if (done.length === 0 && failed.length === 0) {
        console.log(`[${stage}] nothing to do — ${skipped.length} skipped`);
        printSkips(skipped);
        console.log('');
        return 0;
    }

    const labels = STAGE_LABELS[stage] ?? ['operation', 'operations'];
    const line = `[${stage}] ${done.length} ${labels[done.length === 1 ? 0 : 1]}, `
        + `${skipped.length} skipped, ${failed.length} failed.`;
    // Breathing room between the streamed progress lines and the summary.
    console.log('');
    console.log(failed.length > 0 ? chalk.yellow(line) : line);
    console.log('');

    if (failed.length > 0) {
        console.log('Failures:');
        for (const r of failed) {
            console.log(`  - ${chalk.red(nameOf(r))}  —  ${r.error.split('\n')[0]}`);
        }
        console.log('');
    }

    // Warned skips are listed individually because they need acting on; the
    // routine ones below are only counted.
    if (warned.length > 0) {
        console.log('Warnings:');
        for (const r of warned) {
            console.log(`  - ${chalk.yellow(nameOf(r))}  —  ${r.reason}`);
        }
        console.log('');
    }

    if (plainSkips.length > 0) {
        console.log('Skipped:');
        printSkips(plainSkips);
        console.log('');
    }

    return failed.length === 0 ? 0 : 1;
}
