import fs from 'node:fs';
import path from 'node:path';

export function findSongFolders(songsDir) {
    if (!fs.existsSync(songsDir)) return [];
    return fs
        .readdirSync(songsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(songsDir, d.name))
        .sort();
}

export function resolveSongFolder(config, nameOrPath) {
    // Accept either an absolute/relative path, or a folder name inside songs/.
    const asPath = path.resolve(nameOrPath);
    if (fs.existsSync(asPath) && fs.statSync(asPath).isDirectory()) {
        return asPath;
    }
    const inside = path.join(config.paths.songsDir, nameOrPath);
    if (fs.existsSync(inside)) return inside;
    throw new Error(
        `Song folder not found: tried "${asPath}" and "${inside}"`
    );
}