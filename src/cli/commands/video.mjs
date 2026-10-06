// src/cli/commands/video.mjs
// `resonate video [song]` — song.wav + thumbnail → song.mp4.

import { loadConfig } from '../../song/config.mjs';
import { stageVideo } from '../../song/pipeline.mjs';
import { runStageCommand } from '../helpers.mjs';

export function registerVideo(program) {
    program
        .command('video [songFolder]')
        .description('Render song.wav + thumbnail image → song.mp4')
        .option('--force', 'regenerate even if song.mp4 already exists')
        .action(async (songFolderArg, opts) => {
            const config = loadConfig();
            await runStageCommand({
                stageName: 'video',
                stageFn: stageVideo,
                description: 'Rendering video',
                songFolderArg,
                cmdOpts: opts,
                config,
            });
        });
}
