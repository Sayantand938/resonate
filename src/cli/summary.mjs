// src/cli/summary.mjs
// Per-stage result summaries and process exit code handling.

import path from 'node:path';
import chalk from 'chalk';

const STAGE_LABELS = {
    lyrics: 'songs written',
    score: 'songs scored',
    transcribe: 'songs transcribed',
    midi: 'songs rendered to MIDI',
    render: 'songs rendered to WAV',
    video: 'songs rendered to video',
    all: 'stage operations',
};

export function setExit(code) {
    if (code) process.exitCode = code;
}

export function printStageSummary(results, { stage, single = false }) {
    if (single) {
        const r = results[0];
        if (!r) return 0;
        if (r.skipped) {
            const line = `\n  ${r.reason ?? 'skipped'}\n`;
            console.log(r.warn ? chalk.yellow(line) : line);
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

    const label = STAGE_LABELS[stage] ?? 'operations';
    const parts = [
        `${okCount} ${label}`,
        `${skipCount} skipped`,
        `${failCount} failed`,
    ];
    const line = `[${stage}] ${parts.join(', ')}.`;

    if (failCount > 0) {
        console.log(chalk.yellow(line));
    } else {
        console.log(line);
    }
    console.log('');

    if (failCount > 0) {
        console.log('Failures:');
        for (const r of results) {
            if (r.ok || r.skipped) continue;
            const name = r.folder ? path.basename(r.folder) : '(unknown)';
            console.log(`  - ${chalk.red(name)}  —  ${r.error.split('\n')[0]}`);
        }
        console.log('');
    }

    // Skipped for an actionable reason — not a failure, but not silently fine
    // either. A missing thumbnail is the motivating case: the song simply
    // cannot be rendered to video until one is supplied.
    const warned = results.filter((r) => r.warn);
    if (warned.length > 0) {
        console.log('Warnings:');
        for (const r of warned) {
            const name = r.folder ? path.basename(r.folder) : '(unknown)';
            console.log(`  - ${chalk.yellow(name)}  —  ${r.reason}`);
        }
        console.log('');
    }

    return failCount === 0 ? 0 : 1;
}
