#!/usr/bin/env node
// bin/cli.js — the resonate CLI entry point.
//
// Registers every command and dispatches. Each command lives in its own
// module under src/cli/commands/.

import { Command } from 'commander';

import { registerLyrics } from '../src/cli/commands/lyrics.js';
import { registerScore } from '../src/cli/commands/score.js';
import { registerMidi } from '../src/cli/commands/midi.js';
import { registerRender } from '../src/cli/commands/render.js';
import { registerAll } from '../src/cli/commands/all.js';
import { registerRecreate } from '../src/cli/commands/recreate.js';
import { registerList } from '../src/cli/commands/list.js';
import { registerShow } from '../src/cli/commands/show.js';
import { registerMeta } from '../src/cli/commands/meta.js';
import { registerDev } from '../src/cli/commands/dev.js';

const program = new Command();

program
    .name('resonate')
    .description('Song generation: theme → lyrics → ABC → MIDI → WAV')
    .version('0.1.0');

// Register every command.
registerLyrics(program);
registerScore(program);
registerMidi(program);
registerRender(program);
registerAll(program);
registerRecreate(program);
registerList(program);
registerShow(program);
registerMeta(program);
registerDev(program);

// No arguments → print help.
program.action(() => {
    program.help();
});

await program.parseAsync(process.argv);