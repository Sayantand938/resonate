// src/abc/voices.test.mjs
// Tests for voiceNamesByChannel, exercised against real abcjs output.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceNamesByChannel, ACCOMPANIMENT_KEY } from './voices.mjs';
import { abcjsMidiHtml, midiFromAbcjsHtml } from './engine.mjs';

async function renderAbcToMidi(abcSource) {
    const html = await abcjsMidiHtml(abcSource, {});
    return midiFromAbcjsHtml(html[0]);
}

test('voiceNamesByChannel: two voices plus chords', async () => {
    const abc = [
        'X:1',
        'T:Test',
        'M:4/4',
        'L:1/4',
        'Q:1/4=120',
        'V: Vocal',
        'V: Ins',
        'K:C',
        'V: Vocal',
        '"C"c4|"G"d4|',
        'V: Ins',
        'E4|F4|',
    ].join('\n');

    const midi = await renderAbcToMidi(abc);
    const map = voiceNamesByChannel(abc, midi);

    // abcjs numbers tracks as: 0 conductor, 1 Vocal, 2 Ins, 3 accompaniment
    // (the accompaniment track exists because the ABC has chord symbols).
    assert.deepEqual(map, {
        0: 'Vocal',
        1: 'Ins',
        2: ACCOMPANIMENT_KEY,
    });
});

test('voiceNamesByChannel: three voices, no chord symbols', async () => {
    const abc = [
        'X:1',
        'T:Test',
        'M:4/4',
        'L:1/4',
        'Q:1/4=120',
        'V: Vocal',
        'V: Ins',
        'V: Drone',
        'K:C',
        'V: Vocal',
        'c4|d4|',
        'V: Ins',
        'E4|F4|',
        'V: Drone',
        'C,4|C,4|',
    ].join('\n');

    const midi = await renderAbcToMidi(abc);
    const map = voiceNamesByChannel(abc, midi);

    // No chord symbols means no accompaniment track.
    assert.deepEqual(map, {
        0: 'Vocal',
        1: 'Ins',
        2: 'Drone',
    });
});

test('voiceNamesByChannel: voice declared inline', async () => {
    const abc = [
        'X:1',
        'T:Test',
        'M:4/4',
        'L:1/4',
        'Q:1/4=120',
        'K:C',
        '[V: Lead]c4|d4|',
        '[V: Bass]C,4|C,4|',
    ].join('\n');

    const midi = await renderAbcToMidi(abc);
    const map = voiceNamesByChannel(abc, midi);

    assert.deepEqual(map, {
        0: 'Lead',
        1: 'Bass',
    });
});

test('voiceNamesByChannel: empty or unparseable input returns {}', () => {
    assert.deepEqual(voiceNamesByChannel('', Buffer.alloc(0)), {});
    assert.deepEqual(voiceNamesByChannel('not midi', Buffer.alloc(0)), {});
});