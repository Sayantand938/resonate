// Parse the writer's markdown into TITLE / STYLE / LYRICS sections.

const SECTION_RE = /^#\s+(TITLE|STYLE|LYRICS)\s*$/gim;

export function parseSongMarkdown(text) {
    const matches = [...String(text).matchAll(SECTION_RE)];
    const sections = {};

    for (let i = 0; i < matches.length; i++) {
        const m = matches[i];
        const name = m[1].toUpperCase();
        const start = m.index + m[0].length;
        const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
        sections[name] = text.slice(start, end).trim();
    }

    const title = (sections.TITLE ?? '').trim();
    const style = (sections.STYLE ?? '').trim();
    const lyrics = (sections.LYRICS ?? '').trim();

    return {
        title,
        style,
        lyrics,
        is_valid: Boolean(title && lyrics),
    };
}