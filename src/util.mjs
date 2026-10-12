// Small shared helpers.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the project root (the folder containing package.json).
 *
 * util.mjs lives at <root>/src/util.mjs, so one `..` climbs to <root>.
 */
export function projectRoot() {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..');
}

export function slugify(text, maxLength = 80) {
    let s = String(text ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')   // strip accents
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
    if (!s) s = 'untitled';
    return s.slice(0, maxLength).replace(/-+$/, '');
}

/**
 * Folder name for a song. The date goes last so a directory listing
 * sorted alphabetically groups songs by title, with same-title songs
 * ordered chronologically.
 *
 *   songFolderName('neon-on-the-window')  →  'neon-on-the-window-2026-10-05'
 *   songFolderName('neon-on-the-window', { includeDate: false })
 *     →  'neon-on-the-window'
 */
export function songFolderName(slug, { includeDate = true } = {}) {
    if (!includeDate) return slug;
    const d = new Date();
    const iso = d.toISOString().slice(0, 10);
    return `${slug}-${iso}`;
}

export function log(msg) { console.error(msg); }
export function info(msg) { console.error(`[info] ${msg}`); }
export function warn(msg) { console.error(`[warn] ${msg}`); }