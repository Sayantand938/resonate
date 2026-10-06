import { loadConfig } from '../../song/config.mjs';
import { stageRender } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerRender(program) {
    program
        .command('render [songFolder]')
        .description('Render score.mid → song.wav')
        .option('--force', 'regenerate even if song.wav already exists')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'render',
                stageFn: stageRender,
                description: 'Rendering audio',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}