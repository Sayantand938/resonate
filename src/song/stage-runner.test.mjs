// src/song/stage-runner.test.mjs
// Tests for the shared per-folder loop.
//
// This is the one piece of the pipeline with non-trivial branching, and the
// one where a bug silently affects every stage. Every test below feeds
// `runStage` fake hasInput/hasOutput/run functions and asserts on the
// result shape and on the progress events emitted. Nothing touches the
// filesystem.
//
//   node --test src/song/stage-runner.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    runStage,
    runSequential,
    hasHardFailure,
    resultOk,
    resultSkip,
    resultFail,
    listTargetFolders,
} from './stage-runner.mjs';

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

/** Make a temp songs dir containing one folder per given name. */
function makeSongsDir(names) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resonate-test-'));
    for (const n of names) fs.mkdirSync(path.join(dir, n));
    return dir;
}

function rmSongsDir(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

/** Collect every progress event a runStage call emits, in order. */
function collectProgress() {
    const events = [];
    return {
        events,
        onProgress: (e) => events.push(e),
    };
}

// ---------------------------------------------------------------------
// result constructors
// ---------------------------------------------------------------------

test('resultOk: ok true, folder present, extras merged', () => {
    const r = resultOk('/x/song', { title: 'T' });
    assert.deepEqual(r, { ok: true, folder: '/x/song', title: 'T' });
});

test('resultSkip: ok true, skipped true, reason and stage set', () => {
    const r = resultSkip('/x/song', 'no input', 'midi');
    assert.equal(r.ok, true);
    assert.equal(r.skipped, true);
    assert.equal(r.reason, 'no input');
    assert.equal(r.stage, 'midi');
});

test('resultFail: ok false, error and stage set, no skipped flag', () => {
    const r = resultFail('/x/song', 'boom', 'render');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'boom');
    assert.equal(r.stage, 'render');
    assert.equal(r.skipped, undefined);
});

// ---------------------------------------------------------------------
// hasHardFailure
// ---------------------------------------------------------------------

test('hasHardFailure: true only when a result is !ok and not skipped', () => {
    assert.equal(hasHardFailure([]), false);
    assert.equal(hasHardFailure([resultOk('/x')]), false);
    assert.equal(hasHardFailure([resultSkip('/x', 'r', 's')]), false);
    assert.equal(hasHardFailure([resultFail('/x', 'e', 's')]), true);
    assert.equal(
        hasHardFailure([resultOk('/x'), resultSkip('/y', 'r', 's'), resultFail('/z', 'e', 's')]),
        true
    );
});

// ---------------------------------------------------------------------
// listTargetFolders
// ---------------------------------------------------------------------

test('listTargetFolders: one folder when given, sorted list otherwise', () => {
    const dir = makeSongsDir(['b', 'a', 'c']);
    try {
        assert.deepEqual(listTargetFolders(dir, '/one/song'), ['/one/song']);
        const all = listTargetFolders(dir, null).map((p) => path.basename(p));
        assert.deepEqual(all, ['a', 'b', 'c']);
    } finally {
        rmSongsDir(dir);
    }
});

// ---------------------------------------------------------------------
// the loop — one test per branch
// ---------------------------------------------------------------------

/** The baseline stage declaration every test below modifies. */
function baseStage(overrides = {}) {
    return {
        stage: 'test',
        songsDir: null,  // filled in by the test
        folder: null,
        force: false,
        inputLabel: 'in',
        outputLabel: 'out',
        hasInput: () => true,
        hasOutput: () => false,
        run: async () => ({}),
        ...overrides,
    };
}

test('runStage: input missing → one skip per folder, run never called', async () => {
    const dir = makeSongsDir(['a', 'b']);
    try {
        let ran = 0;
        const { events, onProgress } = collectProgress();
        const results = await runStage(baseStage({
            songsDir: dir,
            hasInput: () => false,
            run: async () => { ran++; return {}; },
            onProgress,
        }));

        assert.equal(results.length, 2);
        for (const r of results) {
            assert.equal(r.ok, true);
            assert.equal(r.skipped, true);
            assert.equal(r.reason, 'no in');
            assert.equal(r.stage, 'test');
        }
        assert.equal(ran, 0);
        assert.deepEqual(events.map((e) => e.phase), ['skip', 'skip']);
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: output exists and not force → skip, run never called', async () => {
    const dir = makeSongsDir(['a']);
    try {
        let ran = 0;
        const { events, onProgress } = collectProgress();
        const results = await runStage(baseStage({
            songsDir: dir,
            hasOutput: () => true,
            force: false,
            run: async () => { ran++; return {}; },
            onProgress,
        }));

        assert.equal(results.length, 1);
        assert.equal(results[0].skipped, true);
        assert.equal(results[0].reason, 'out exists');
        assert.equal(ran, 0);
        assert.deepEqual(events.map((e) => e.phase), ['skip']);
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: output exists and force → run is called anyway', async () => {
    const dir = makeSongsDir(['a']);
    try {
        let ran = 0;
        const results = await runStage(baseStage({
            songsDir: dir,
            hasOutput: () => true,
            force: true,
            run: async () => { ran++; return { title: 'T' }; },
        }));

        assert.equal(ran, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0].ok, true);
        assert.equal(results[0].skipped, undefined);
        assert.equal(results[0].title, 'T');
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: extraSkipReason fires before run, warns when asked', async () => {
    const dir = makeSongsDir(['a', 'b']);
    try {
        let ran = 0;
        const results = await runStage(baseStage({
            songsDir: dir,
            // Only skip "a"; run "b" normally.
            extraSkipReason: (f) => (path.basename(f) === 'a' ? 'no thumb' : null),
            extraSkipWarn: true,
            run: async () => { ran++; return {}; },
        }));

        assert.equal(ran, 1);
        assert.equal(results.length, 2);

        const skipped = results.find((r) => r.skipped);
        const ran1 = results.find((r) => !r.skipped);
        assert.equal(skipped.reason, 'no thumb');
        assert.equal(skipped.warn, true);
        assert.equal(ran1.ok, true);
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: run succeeds → OK result, done event with merged extras', async () => {
    const dir = makeSongsDir(['a']);
    try {
        const { events, onProgress } = collectProgress();
        const results = await runStage(baseStage({
            songsDir: dir,
            run: async () => ({ outputPath: '/out/x', title: 'Hello' }),
            onProgress,
        }));

        assert.equal(results.length, 1);
        assert.deepEqual(results[0], {
            ok: true,
            folder: path.join(dir, 'a'),
            stage: 'test',
            outputPath: '/out/x',
            title: 'Hello',
        });

        assert.deepEqual(events.map((e) => e.phase), ['start', 'done']);
        assert.equal(events[0].label, 'a');
        assert.equal(events[0].stage, 'test');
        assert.equal(events[1].result, results[0]);
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: run throws → fail result, fail event, loop continues', async () => {
    const dir = makeSongsDir(['a', 'b']);
    try {
        const results = await runStage(baseStage({
            songsDir: dir,
            run: async (f) => {
                if (path.basename(f) === 'a') throw new Error('boom');
                return {};
            },
        }));

        assert.equal(results.length, 2);
        assert.equal(results[0].ok, false);
        assert.equal(results[0].error, 'boom');
        assert.equal(results[0].stage, 'test');
        assert.equal(results[1].ok, true);
        assert.equal(results[1].skipped, undefined);
    } finally {
        rmSongsDir(dir);
    }
});

test('runStage: single-folder mode bypasses the songs dir scan', async () => {
    // Pass a songsDir that does not exist — if runStage tried to scan it,
    // listTargetFolders would return [] and this test would see no results.
    const oneFolder = '/not/a/real/path/but/we/skip/the/scan';
    const results = await runStage(baseStage({
        songsDir: '/does/not/exist',
        folder: oneFolder,
        run: async () => ({ title: 'X' }),
    }));

    assert.equal(results.length, 1);
    assert.equal(results[0].folder, oneFolder);
    assert.equal(results[0].title, 'X');
});

// ---------------------------------------------------------------------
// runSequential — the `all` stage's loop
// ---------------------------------------------------------------------

/** A fake stage that returns a fixed result set and records being called. */
function fakeStage(name, results) {
    const calls = [];
    const fn = async (_config, _opts) => {
        calls.push(name);
        return results;
    };
    fn.calls = calls;
    return fn;
}

test('runSequential: batch mode runs every stage, concatenates results', async () => {
    const s1 = fakeStage('one', [resultOk('/a', { stage: 's1' })]);
    const s2 = fakeStage('two', [resultFail('/a', 'e', 's2')]);
    const s3 = fakeStage('three', [resultOk('/a', { stage: 's3' })]);

    const results = await runSequential([s1, s2, s3], {
        config: {},
        folder: null,
        force: false,
        onProgress: null,
        shortCircuit: false,
    });

    assert.deepEqual(s1.calls, ['one']);
    assert.deepEqual(s2.calls, ['two']);
    assert.deepEqual(s3.calls, ['three']);
    assert.equal(results.length, 3);
});

test('runSequential: shortCircuit stops at the first hard failure', async () => {
    const s1 = fakeStage('one', [resultOk('/a', { stage: 's1' })]);
    const s2 = fakeStage('two', [resultFail('/a', 'e', 's2')]);
    const s3 = fakeStage('three', [resultOk('/a', { stage: 's3' })]);

    const results = await runSequential([s1, s2, s3], {
        config: {},
        folder: '/a',
        force: false,
        onProgress: null,
        shortCircuit: true,
    });

    assert.deepEqual(s1.calls, ['one']);
    assert.deepEqual(s2.calls, ['two']);
    assert.deepEqual(s3.calls, []);     // never ran
    assert.equal(results.length, 2);
});

test('runSequential: shortCircuit does not stop on skips', async () => {
    const s1 = fakeStage('one', [resultSkip('/a', 'r', 's1')]);
    const s2 = fakeStage('two', [resultOk('/a', { stage: 's2' })]);

    await runSequential([s1, s2], {
        config: {},
        folder: '/a',
        force: false,
        onProgress: null,
        shortCircuit: true,
    });

    assert.deepEqual(s2.calls, ['two']);
});