// src/cli/progress.js
// Progress printer for stage commands.
//
// Streams events live to stderr as they happen, and collects them so a
// grouped summary can be printed at the end of a batch run.

import path from 'node:path';
import chalk from 'chalk';

const OK_TAG = '[OK]';
const FAIL_TAG = '[!!]';
const SKIP_TAG = '[--]';
const STAGE_WIDTH = 6;

export function makeProgress() {
    const collected = [];

    const onProgress = ({ phase, stage, label, folder, result }) => {
        collected.push({ phase, stage, label, folder, result });

        const id = label || (folder ? path.basename(folder) : '?');
        const tag = stage
            ? chalk.dim(stage.padEnd(STAGE_WIDTH))
            : ''.padEnd(STAGE_WIDTH);

        if (phase === 'start') {
            // The prefix is printed here, once, at the start of the line.
            process.stderr.write(`${id}  ${tag}  ... `);
            return;
        }

        // For all other phases, only the tail is written — the prefix
        // is already on the current line from the start event.
        if (phase === 'done') {
            const parts = [];
            if (result?.title) parts.push(result.title);
            if (result?.seed != null) parts.push(`seed=${result.seed}`);
            const extra = parts.length ? `  ${parts.join('  ')}` : '';
            process.stderr.write(`${chalk.green(OK_TAG)}${extra}\n`);
        } else if (phase === 'skip') {
            const reason = result?.reason ?? 'skipped';
            process.stderr.write(`${chalk.dim(SKIP_TAG)} (${reason})\n`);
        } else if (phase === 'fail') {
            const firstLine = result?.error
                ? result.error.split('\n')[0]
                : 'failed';
            process.stderr.write(`${chalk.red(FAIL_TAG)}  ${firstLine}\n`);
        }
    };

    return {
        onProgress,
        getEvents: () => collected,
    };
}

/**
 * Print a grouped summary of collected events: one header per song,
 * stages indented underneath. Only used for batch runs.
 */
export function printGroupedProgress(events) {
    if (events.length === 0) return;

    const groups = new Map();
    for (const e of events) {
        const key = e.folder
            ? path.basename(e.folder)
            : (e.label ?? '(unknown)');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
    }

    console.log('');
    console.log(chalk.dim('Grouped summary'));
    console.log('');

    for (const [songName, songEvents] of groups.entries()) {
        console.log(chalk.bold(songName));
        for (const e of songEvents) {
            const tag = e.stage
                ? chalk.dim(e.stage.padEnd(STAGE_WIDTH))
                : ''.padEnd(STAGE_WIDTH);
            const indent = '  ';

            if (e.phase === 'done') {
                const parts = [];
                if (e.result?.title) parts.push(e.result.title);
                if (e.result?.seed != null) parts.push(`seed=${e.result.seed}`);
                const extra = parts.length ? `  ${parts.join('  ')}` : '';
                console.log(`${indent}${tag}  ${chalk.green(OK_TAG)}${extra}`);
            } else if (e.phase === 'skip') {
                const reason = e.result?.reason ?? 'skipped';
                console.log(`${indent}${tag}  ${chalk.dim(SKIP_TAG)} (${reason})`);
            } else if (e.phase === 'fail') {
                const firstLine = e.result?.error
                    ? e.result.error.split('\n')[0]
                    : 'failed';
                console.log(`${indent}${tag}  ${chalk.red(FAIL_TAG)}  ${firstLine}`);
            }
            // 'start' events are skipped: they'd duplicate the done/skip/fail line.
        }
        console.log('');
    }
}