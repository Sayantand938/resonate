#!/usr/bin/env node
// bin/cli.js — `resonate` entry point.

import { Command } from 'commander';
import { loadConfig } from '../src/song/config.mjs';
import { registerLyrics } from '../src/cli/commands/lyrics.mjs';
import { registerScore } from '../src/cli/commands/score.mjs';
import { registerTranscribe } from '../src/cli/commands/transcribe.mjs';
import { registerMidi } from '../src/cli/commands/midi.mjs';
import { registerRender } from '../src/cli/commands/render.mjs';
import { registerVideo } from '../src/cli/commands/video.mjs';
import { registerAll } from '../src/cli/commands/all.mjs';
import { registerList } from '../src/cli/commands/list.mjs';
import { registerShow } from '../src/cli/commands/show.mjs';
import { registerMeta } from '../src/cli/commands/meta.mjs';
import { registerRecreate } from '../src/cli/commands/recreate.mjs';
import { registerDev } from '../src/cli/commands/dev.mjs';

const program = new Command();

program
    .name('resonate')
    .description('Generate songs end-to-end: theme → lyrics → ABC → MIDI → WAV')
    .version('0.2.0');

// Load config once, eagerly, so a missing config.yaml fails before any
// subcommand tries to run and produces a confusing partial error.
try {
    loadConfig();
} catch (err) {
    console.error(err.message);
    process.exit(1);
}

registerLyrics(program);
registerScore(program);
registerTranscribe(program);
registerMidi(program);
registerRender(program);
registerVideo(program);
registerAll(program);
registerList(program);
registerShow(program);
registerMeta(program);
registerRecreate(program);
registerDev(program);

program.parseAsync(process.argv).catch((err) => {
    console.error(err.message);
    process.exit(1);
});