#!/usr/bin/env node
// bin/cli.js — the resonate CLI entry point.
//
// Kept as .js deliberately. Under "type": "module" a .js file is already ESM,
// so there is nothing to disambiguate, and this is the path every existing
// global install of `resonate` shims to — renaming it silently breaks them.
//
// Registers every command and dispatches. Each command lives in its own
// module under src/cli/commands/.

import { Command } from 'commander';
import { createRequire } from 'node:module';

const { version } = createRequire(import.meta.url)('../package.json');

import { registerLyrics } from '../src/cli/commands/lyrics.mjs';
import { registerScore } from '../src/cli/commands/score.mjs';
import { registerTranscribe } from '../src/cli/commands/transcribe.mjs';
import { registerMidi } from '../src/cli/commands/midi.mjs';
import { registerRender } from '../src/cli/commands/render.mjs';
import { registerVideo } from '../src/cli/commands/video.mjs';
import { registerAll } from '../src/cli/commands/all.mjs';
import { registerRecreate } from '../src/cli/commands/recreate.mjs';
import { registerList } from '../src/cli/commands/list.mjs';
import { registerShow } from '../src/cli/commands/show.mjs';
import { registerMeta } from '../src/cli/commands/meta.mjs';
import { registerDev } from '../src/cli/commands/dev.mjs';

const program = new Command();

program
    .name('resonate')
    .description('Song generation: theme → lyrics → ABC → MIDI → WAV')
    .version(version);

// Register every command.
registerLyrics(program);
registerScore(program);
registerTranscribe(program);
registerMidi(program);
registerRender(program);
registerVideo(program);
registerAll(program);
registerRecreate(program);
registerList(program);
registerShow(program);
registerMeta(program);
registerDev(program);

// No arguments → print help. A mistyped command should not silently succeed.
program.action((_options, command) => {
    const unknown = command.args ?? [];
    if (unknown.length > 0) {
        console.error(`Unknown command: ${unknown.join(' ')}`);
        console.error('');
        program.help({ error: true });
    }
    program.help();
});

await program.parseAsync(process.argv);