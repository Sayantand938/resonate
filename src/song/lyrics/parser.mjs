// Parse the writer's markdown into TITLE / STYLE / LYRICS sections.
//
// The file is simultaneously a rendered document and a data record. Only the
// three headings act as delimiters, so a stray '#' inside a lyric cannot split
// a section.

const SECTION_RE = /^#\s+(TITLE|STYLE|LYRICS)\s*$/gim;

/**
 * Markdown encodes a hard line break as two trailing spaces. That exists so
 * the file renders as intended, but it is document syntax rather than data,
 * so it is stripped before the text reaches the music model.
 */
function cleanSection(raw) {
    return String(raw ?? '')
        .replace(/[ \t]+$/gm, '')
        .trim();
}

export function parseSongMarkdown(text) {
    const source = String(text);
    const matches = [...source.matchAll(SECTION_RE)];
    const sections = {};

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const name = m[1].toUpperCase();
        const start = m.index + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
        sections[name] = cleanSection(source.slice(start, end));
    }

    const title = sections.TITLE ?? '';
    const style = sections.STYLE ?? '';
    const lyrics = sections.LYRICS ?? '';

    return {
        title,
        style,
        lyrics,
        is_valid: Boolean(title && lyrics),
    };
}
