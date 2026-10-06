import { loadConfig } from '../../song/config.mjs';
import { stageScore } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerScore(program) {
    program
        .command('score [songFolder]')
        .description('Generate score.abc + score.meta.json via YuE2')
        .option('--force', 'regenerate even if score.abc already exists')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'score',
                stageFn: stageScore,
                description: 'Scoring songs (YuE2)',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}