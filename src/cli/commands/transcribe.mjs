// src/cli/commands/transcribe.mjs
// `resonate transcribe [song]` — existing recording → score.abc via SheetSage2.

import { loadConfig } from '../../song/config.mjs';
import { stageTranscribe } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerTranscribe(program) {
    program
        .command('transcribe [songFolder]')
        .description('Transcribe og_song.wav/mp3 → score.abc via SheetSage2')
        .option('--force', 'overwrite an existing score.abc')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'transcribe',
                stageFn: stageTranscribe,
                description: 'Transcribing recordings (SheetSage2)',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}
