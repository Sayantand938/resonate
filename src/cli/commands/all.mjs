import path from 'node:path';
import { loadConfig } from '../../song/config.mjs';
import { stageAll } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerAll(program) {
    program
        .command('all [songFolder]')
        .description('Run score → midi → render (one song or all songs)')
        .option('--force', 'regenerate all intermediate outputs')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'all',
                stageFn: stageAll,
                description: songFolderArg
                    ? `Running pipeline for ${path.basename(songFolderArg)}`
                    : 'Running pipeline for all songs',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}