#!/usr/bin/env node
// scripts/rename-song-folders.mjs
// Migrate song folders from <date>-<slug> to <slug>-<date>.
//
// Usage:
//   node scripts/rename-song-folders.mjs              # preview (dry run)
//   node scripts/rename-song-folders.mjs --apply      # do it
//   node scripts/rename-song-folders.mjs --apply --no-git
//
// Uses `git mv` so the rename is recorded as a rename in history, not as
// a delete + add. Falls back to a plain filesystem rename when git is
// not available or --no-git is passed.
//
// Idempotent: a folder already in <slug>-<date> form is left alone.

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { parseArgs, die } from '../src/cli/args.mjs';
import { loadConfig } from '../src/song/config.mjs';
import { findSongFolders } from '../src/song/paths.mjs';

const USAGE = 'node scripts/rename-song-folders.mjs [--apply] [--no-git]';

const args = parseArgs(process.argv.slice(2), {
    '--apply': { key: 'apply', kind: 'flag' },
    '--no-git': { key: 'noGit', kind: 'flag' },
});

const config = loadConfig();
const songsDir = config.paths.songsDir;

if (!fs.existsSync(songsDir)) {
    die(`Songs directory not found: ${songsDir}`);
}

const folders = findSongFolders(songsDir);
if (folders.length === 0) {
    console.log('No song folders found.');
    process.exit(0);
}

// A folder name is <date>-<slug> if it starts with YYYY-MM-DD-.
// A folder already in <slug>-<date> form ends with -YYYY-MM-DD,
// optionally followed by a -<n> collision suffix.
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const DATE_SUFFIX_RE = /-(\d{4}-\d{2}-\d{2})(-\d+)?$/;

const planned = [];
const skipped = [];
const unknown = [];

for (const folder of folders) {
    const name = path.basename(folder);

    if (DATE_SUFFIX_RE.test(name)) {
        skipped.push({ from: name, reason: 'already <slug>-<date>' });
        continue;
    }

    const m = name.match(DATE_PREFIX_RE);
    if (!m) {
        unknown.push({ from: name, reason: 'no recognisable date' });
        continue;
    }

    const [, date, slug] = m;
    let target = `${slug}-${date}`;

    // Collision handling: <slug>-<date>-2, -3, ...
    let n = 2;
    while (fs.existsSync(path.join(songsDir, target))) {
        target = `${slug}-${date}-${n}`;
        n++;
    }

    planned.push({ from: name, to: target, folder });
}

// ---- report ---------------------------------------------------------

if (planned.length === 0 && skipped.length === 0 && unknown.length === 0) {
    console.log('Nothing to do.');
    process.exit(0);
}

if (planned.length > 0) {
    console.log(`\n${args.apply ? 'Renaming' : 'Would rename'} ${planned.length} folder(s):\n`);
    for (const p of planned) {
        console.log(`  ${p.from}  →  ${p.to}`);
    }
}

if (skipped.length > 0) {
    console.log(`\nAlready correct (${skipped.length}):`);
    for (const s of skipped) console.log(`  ${s.from}`);
}

if (unknown.length > 0) {
    console.log(`\nSkipped — no recognisable date (${unknown.length}):`);
    for (const u of unknown) console.log(`  ${u.from}`);
}

// ---- apply ----------------------------------------------------------

if (!args.apply) {
    console.log('\nDry run. Pass --apply to actually rename.\n');
    process.exit(0);
}

if (planned.length === 0) {
    console.log('\nNo renames to perform.\n');
    process.exit(0);
}

console.log('\nRenaming...\n');

let ok = 0;
let failed = 0;

for (const p of planned) {
    const fromRel = path.relative(process.cwd(), p.folder);
    const toRel = path.join(path.dirname(fromRel), p.to);

    try {
        if (args.noGit) {
            fs.renameSync(p.folder, path.join(songsDir, p.to));
        } else {
            await execa('git', ['mv', fromRel, toRel], { stdio: 'inherit' });
        }
        console.log(`  [OK]  ${p.from}  →  ${p.to}`);
        ok++;
    } catch (err) {
        console.error(`  [!!]  ${p.from}  →  ${p.to}  (${err.shortMessage ?? err.message})`);
        failed++;
    }
}

console.log(`\n${ok} renamed, ${failed} failed.\n`);
if (failed > 0) process.exit(1);