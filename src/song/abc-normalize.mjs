// src/song/abc-normalize.mjs
// Normalize an ABC file so it works with both abcjs and abc2midi.
//
// The core change: abc2midi requires numeric voice identifiers ("V:1"),
// while abcjs accepts both names ("V: Vocal") and numbers. We rewrite
// named voices to numbers, which is valid for both engines.
//
// We also inject "%%MIDI program N <prog>" directives at the top. abcjs
// ignores them; abc2midi uses them to assign GM programs.

/**
 * @param {string} abcText
 * @param {Object<string, number>} [programsByVoiceName]
 *   Optional map of voice name → GM program. Example: { Vocal: 24, Ins: 24 }
 * @returns {{ abc: string, voiceMap: Map<string, number> }}
 */
export function normalizeAbcForEngines(abcText, programsByVoiceName = {}) {
    const lines = String(abcText).split(/\r?\n/);

    // Pass 1 — discover voice names in order of appearance.
    const voiceMap = new Map();
    let nextNumber = 1;

    for (const line of lines) {
        const m = line.match(/^V:\s*([^\s]+)/);
        if (!m) continue;
        const name = m[1];
        if (/^\d+$/.test(name)) {
            if (!voiceMap.has(name)) {
                voiceMap.set(name, Number(name));
                nextNumber = Math.max(nextNumber, Number(name) + 1);
            }
            continue;
        }
        if (!voiceMap.has(name)) voiceMap.set(name, nextNumber++);
    }

    // Pass 2 — rewrite V: lines, inject %%MIDI directives before first V:.
    const outLines = [];
    let injected = false;

    for (const line of lines) {
        const m = line.match(/^V:\s*([^\s]+)(.*)$/);

        if (!m) {
            outLines.push(line);
            continue;
        }

        if (!injected) {
            for (const [name, num] of voiceMap.entries()) {
                const prog = programsByVoiceName[name];
                if (Number.isInteger(prog)) {
                    outLines.push(`%%MIDI program ${num} ${prog}`);
                }
            }
            injected = true;
        }

        const name = m[1];
        const attrs = m[2];
        const number = voiceMap.get(name) ?? name;
        outLines.push(`V:${number}${attrs}`);
    }

    return { abc: outLines.join('\n'), voiceMap };
}