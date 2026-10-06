// src/video/generator.mjs
// Turn a rendered WAV plus a still image into an MP4 for upload.
//
// The image is the whole visual — this is the "static artwork" music video
// format, not an animated visualiser.

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

/** Filename written into each song folder. */
export const VIDEO_FILENAME = 'song.mp4';

/** Thumbnail filenames looked for, in priority order. */
export const THUMBNAIL_NAMES = [
    'thumbnail.png',
    'thumbnail.jpg',
    'thumbnail.jpeg',
    'thumbnail.webp',
];

/** How the still is fitted to the output frame. */
export const FIT_MODES = ['blur', 'pad', 'crop'];

/**
 * Find a thumbnail next to the song, or null.
 * @param {string} songFolder
 * @returns {string|null}
 */
export function findThumbnail(songFolder) {
    for (const name of THUMBNAIL_NAMES) {
        const candidate = path.join(songFolder, name);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Build the video filter graph for a fit mode.
 *
 *   blur  scaled-and-blurred copy fills the frame behind the artwork
 *   pad   artwork centred on a black frame, nothing cropped
 *   crop  artwork scaled to cover, overhang trimmed
 */
function videoFilter(mode, width, height) {
    const cover = `scale=${width}:${height}:force_original_aspect_ratio=increase`;
    const contain = `scale=${width}:${height}:force_original_aspect_ratio=decrease`;

    if (mode === 'crop') {
        return `[0:v]${cover},crop=${width}:${height},setsar=1,format=yuv420p[v]`;
    }
    if (mode === 'pad') {
        return `[0:v]${contain},pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,`
            + 'setsar=1,format=yuv420p[v]';
    }
    // blur (default)
    return `[0:v]${cover},crop=${width}:${height},gblur=sigma=24[bg];`
        + `[0:v]${contain}[fg];`
        + '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,format=yuv420p[v]';
}

/**
 * @param {Object} opts
 * @param {string} opts.wavPath
 * @param {string} opts.imagePath
 * @param {string} opts.outPath
 * @param {number} [opts.width=1920]
 * @param {number} [opts.height=1080]
 * @param {number} [opts.fps=30]
 * @param {'blur'|'pad'|'crop'} [opts.fit='blur']
 * @param {number} [opts.crf=18]          lower is better quality / bigger file
 * @param {string} [opts.preset='medium'] x264 speed/size tradeoff
 * @param {string} [opts.audioBitrate='192k']
 * @param {boolean} [opts.silent=false]
 * @returns {Promise<{outPath:string, width:number, height:number, fps:number, fit:string}>}
 */
export async function generateVideo({
    wavPath,
    imagePath,
    outPath,
    width = 1920,
    height = 1080,
    fps = 30,
    fit = 'blur',
    crf = 18,
    preset = 'medium',
    audioBitrate = '192k',
    silent = false,
}) {
    if (!fs.existsSync(wavPath)) {
        throw new Error(`Audio not found: ${wavPath}`);
    }
    if (!fs.existsSync(imagePath)) {
        throw new Error(`Image not found: ${imagePath}`);
    }
    if (!FIT_MODES.includes(fit)) {
        throw new Error(
            `Unknown video.fit "${fit}". Expected one of: ${FIT_MODES.join(', ')}.`
        );
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const args = [
        '-y', '-hide_banner', '-loglevel', 'error',
        // Loop the still for the whole track.
        '-loop', '1', '-framerate', String(fps), '-i', imagePath,
        '-i', wavPath,
        '-filter_complex', videoFilter(fit, width, height),
        '-map', '[v]', '-map', '1:a',
        '-c:v', 'libx264',
        '-preset', String(preset),
        '-crf', String(crf),
        // Tells x264 the content is static, which compresses much better.
        '-tune', 'stillimage',
        '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        '-c:a', 'aac', '-b:a', String(audioBitrate),
        // Video is infinite (looped still), so stop when the audio ends.
        '-shortest',
        // YouTube can start serving before the whole file is fetched.
        '-movflags', '+faststart',
        outPath,
    ];

    try {
        await execa('ffmpeg', args, {
            stdio: silent ? 'ignore' : ['ignore', 'inherit', 'inherit'],
        });
    } catch (err) {
        const detail = (err.stderr || err.stdout || '').trim();
        throw new Error(
            `ffmpeg failed (exit ${err.exitCode ?? '?'})`
            + (detail ? `\n${detail.split('\n').slice(-6).join('\n')}` : '')
        );
    }

    if (!fs.existsSync(outPath)) {
        throw new Error(`ffmpeg did not produce ${outPath}`);
    }

    return { outPath, width, height, fps, fit };
}
