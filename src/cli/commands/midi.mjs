import { loadConfig } from '../../song/config.mjs';
import { stageMidi } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerMidi(program) {
    program
        .command('midi [songFolder]')
        .description('Render score.abc → score.mid via abcjs (and humanize)')
        .option('--force', 'regenerate even if score.mid already exists')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'midi',
                stageFn: stageMidi,
                description: 'Rendering MIDI',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}