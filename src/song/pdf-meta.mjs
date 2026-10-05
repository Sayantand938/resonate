// src/song/pdf-meta.mjs
// Patch title and composer into a MuseScore .mscz file.
//
// IMPORTANT: MuseScore's Title Frame (the visual title at top of page 1) is
// NOT linked to the <work-title> metadata field after score creation.
// To make the title appear visually, we must inject a <VBox> with styled
// <Text> elements — this is what the New Score Wizard creates.
//
// We do BOTH:
//   1. Set <work-title> / <creator> metadata (for headers/footers/PDF props)
//   2. Create a <VBox> with visual title/composer text at the top of page 1

import fs from 'node:fs';
import JSZip from 'jszip';

export async function patchMscz(msczPath, { title, composer } = {}) {
    if (!fs.existsSync(msczPath)) {
        throw new Error(`MSCZ not found: ${msczPath}`);
    }

    const buf = fs.readFileSync(msczPath);
    const zip = await JSZip.loadAsync(buf);

    const mscxName = Object.keys(zip.files).find((n) => n.endsWith('.mscx'));
    if (!mscxName) {
        throw new Error(`No .mscx found inside ${msczPath}`);
    }

    let xml = await zip.file(mscxName).async('string');

    // --- 1. Set metadata fields (for header/footer + PDF properties) ---
    xml = patchWorkTitle(xml, title);
    xml = patchComposer(xml, composer);

    // --- 2. Inject visual Title Frame at the top of the first page ---
    xml = patchTitleFrame(xml, { title, composer });

    zip.file(mscxName, xml);

    const out = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
    fs.writeFileSync(msczPath, out);

    return msczPath;
}

// ---------------------------------------------------------------------
// Metadata patches (same as before)
// ---------------------------------------------------------------------

function xmlEscape(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function patchWorkTitle(xml, title) {
    if (!title) return xml;
    const safe = xmlEscape(title);

    if (/<work-title>[\s\S]*?<\/work-title>/.test(xml)) {
        return xml.replace(
            /<work-title>[\s\S]*?<\/work-title>/,
            `<work-title>${safe}</work-title>`
        );
    }

    if (/<Work>[\s\S]*?<\/Work>/.test(xml)) {
        return xml.replace(
            /<Work>([\s\S]*?)<\/Work>/,
            `<Work><work-title>${safe}</work-title>$1</Work>`
        );
    }

    const opening = xml.match(/<museScore\b[^>]*>/);
    if (!opening) return xml;
    const insertAt = opening.index + opening[0].length;
    return (
        xml.slice(0, insertAt) +
        `<Work><work-title>${safe}</work-title></Work>` +
        xml.slice(insertAt)
    );
}

function patchComposer(xml, composer) {
    if (!composer) return xml;
    const safe = xmlEscape(composer);

    if (/<creator\s+type="composer">[\s\S]*?<\/creator>/.test(xml)) {
        return xml.replace(
            /<creator\s+type="composer">[\s\S]*?<\/creator>/,
            `<creator type="composer">${safe}</creator>`
        );
    }

    if (/<Identification>[\s\S]*?<\/Identification>/.test(xml)) {
        return xml.replace(
            /<Identification>([\s\S]*?)<\/Identification>/,
            `<Identification><creator type="composer">${safe}</creator>$1</Identification>`
        );
    }

    const workMatch = xml.match(/<Work>[\s\S]*?<\/Work>/);
    const insertAfter = workMatch
        ? workMatch.index + workMatch[0].length
        : (() => {
            const m = xml.match(/<museScore\b[^>]*>/);
            return m ? m.index + m[0].length : -1;
        })();

    if (insertAfter < 0) return xml;
    return (
        xml.slice(0, insertAfter) +
        `<Identification><creator type="composer">${safe}</creator></Identification>` +
        xml.slice(insertAfter)
    );
}

// ---------------------------------------------------------------------
// Title Frame injection — creates a visual <VBox> with Title + Composer
// ---------------------------------------------------------------------

/**
 * MuseScore's Title Frame is a <VBox> at the start of the score that
 * contains <Text> elements with specific <style> values:
 *   - <style>Title</style>     → top-center, large
 *   - <style>Composer</style>  → bottom-right, normal
 *
 * We find the first <VBox> (or create one) and set/replace those Text
 * elements. This makes the title appear visually on page 1.
 */
function patchTitleFrame(xml, { title, composer }) {
    if (!title && !composer) return xml;

    const titleText = title ? `
      <Text>
        <style>Title</style>
        <text><html><head></head><body><font size="14">${xmlEscape(title)}</font></body></html></text>
        </Text>` : '';

    const composerText = composer ? `
      <Text>
        <style>Composer</style>
        <text><html><head></head><body><font size="12">${xmlEscape(composer)}</font></body></html></text>
        </Text>` : '';

    // Find the first <VBox>...</VBox> (the Title Frame)
    const vboxMatch = xml.match(/<VBox>([\s\S]*?)<\/VBox>/);

    if (vboxMatch) {
        // VBox exists — inject our Text elements at the start of its content
        const inner = vboxMatch[1];
        const newInner = titleText + composerText + inner;
        return xml.replace(
            vboxMatch[0],
            `<VBox>${newInner}</VBox>`
        );
    }

    // No VBox — create one right after the <Staff> element (or after <Score>)
    // MuseScore expects frames to precede the first Measure.
    const staffMatch = xml.match(/<Staff\s+id="1">/);
    const scoreMatch = xml.match(/<Score>/);

    const insertAfter = staffMatch
        ? staffMatch.index + staffMatch[0].length
        : (scoreMatch ? scoreMatch.index + scoreMatch[0].length : -1);

    if (insertAfter < 0) return xml;

    const vbox = `<VBox>${titleText}${composerText}
      </VBox>`;

    return xml.slice(0, insertAfter) + vbox + xml.slice(insertAfter);
}