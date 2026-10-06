// src/cli/progress.mjs
// Live progress for stage commands.
//
// Streams events to stderr as they happen, so a stage that takes minutes
// never looks hung, and collects nothing the caller cannot already get from
// the stage results.
//
// Two deliberate choices:
//
//   * Skips are silent unless asked for. They are instant, so streaming them
//     adds no sense of progress -- and a no-op run across a whole library
//     would otherwise scroll dozens of lines saying nothing happened. The
//     end-of-run summary counts them by reason instead.
//
//   * Long operations tick. When stderr is a terminal, the in-progress line
//     is rewritten every second with elapsed time, so "is it stuck?" has an
//     answer. When output is redirected the line stays a single append, so
//     logs and pipes get no carriage-return noise.

import path from 'node:path';
import chalk from 'chalk';

const OK_TAG = '[OK]';
const FAIL_TAG = '[!!]';
const SKIP_TAG = '[--]';

// Widest stage name is "transcribe" (10). Hardcoded, but this is the one
// place it lives; if a longer stage appears the column just goes ragged
// rather than the output breaking.
const STAGE_WIDTH = 10;

const TICK_MS = 1000;

/** Compact duration: "840ms", "14.2s", "2m52s", "1h04m". */
export function formatDuration(ms) {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.round(ms / 1000);
    if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * @param {Object} [opts]
 * @param {boolean} [opts.showSkips=false] print a line per skip (single-song runs)
 * @param {number} [opts.idWidth=0] pad song names to this width so the stage
 *   column lines up; 0 leaves them ragged. Batch runs know the folder set
 *   up front, so they can pass the longest name.
 */
export function makeProgress({ showSkips = false, idWidth = 0 } = {}) {
    const startedAt = new Map();
    let ticker = null;
    let linePrefix = '';

    const stopTicker = () => {
        if (ticker) {
            clearInterval(ticker);
            ticker = null;
        }
    };

    const tty = Boolean(process.stderr.isTTY);

    /** Finish the line a `start` opened. */
    const finishLine = (id, tag, text) => {
        if (tty) {
            // The ticker may have overwritten the line, so rewrite it whole
            // and pad in case the ticker text was longer.
            process.stderr.write(`\r  ${id}  ${chalk.dim(tag)}  ${text}        \n`);
        } else {
            process.stderr.write(`${text}\n`);
        }
    };

    const onProgress = ({ phase, stage, label, folder, result }) => {
        const rawId = label || (folder ? path.basename(folder) : '?');
        const id = idWidth > 0 ? rawId.padEnd(idWidth) : rawId;
        const tag = (stage ?? '').padEnd(STAGE_WIDTH);
        const key = `${stage ?? ''}:${folder ?? label ?? '?'}`;

        if (phase === 'start') {
            stopTicker(); // defensive: never let two tickers share a line
            startedAt.set(key, Date.now());
            linePrefix = `  ${id}  ${chalk.dim(tag)}  `;
            process.stderr.write(`${linePrefix}... `);

            if (tty) {
                ticker = setInterval(() => {
                    const elapsed = formatDuration(Date.now() - startedAt.get(key));
                    process.stderr.write(`\r${linePrefix}${chalk.dim(elapsed)}`);
                }, TICK_MS);
            }
            return;
        }

        if (phase === 'skip') {
            // No `start` preceded this, so it needs its own prefix.
            if (showSkips) {
                process.stderr.write(
                    `  ${id}  ${chalk.dim(tag)}  ${chalk.dim(SKIP_TAG)} `
                    + `${result?.reason ?? 'skipped'}\n`
                );
            }
            return;
        }

        if (phase === 'done') {
            stopTicker();
            const ms = Date.now() - (startedAt.get(key) ?? Date.now());
            const parts = [];
            if (result?.title) parts.push(result.title);
            if (result?.seed != null) parts.push(`seed=${result.seed}`);
            const extra = parts.length ? `  ${parts.join('  ')}` : '';
            finishLine(id, tag, `${chalk.green(OK_TAG)}  ${formatDuration(ms)}${extra}`);
            return;
        }

        if (phase === 'fail') {
            stopTicker();
            const firstLine = (result?.error ?? 'failed').split('\n')[0];
            finishLine(id, tag, `${chalk.red(FAIL_TAG)}  ${firstLine}`);
        }
    };

    return {
        onProgress,
        /** Call once when the stage finishes, so a ticker cannot outlive it. */
        stop: stopTicker,
    };
}
