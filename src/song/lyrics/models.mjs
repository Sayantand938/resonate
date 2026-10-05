// Mirrors reason8's Pydantic SongPlan, in plain JS. If a field is missing
// or has the wrong shape, we throw a clear error before hitting the model.

const REQUIRED_STRINGS = [
    'title', 'genre', 'mood', 'theme', 'story', 'setting',
    'perspective', 'style_prompt',
];

const REQUIRED_ARRAYS = ['motifs', 'structure'];

const SECTION_LABEL_RE = /^\[.+\]$/;

export function normalizePlan(raw) {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Plan is not an object.');
    }
    const out = { ...raw };

    for (const k of REQUIRED_STRINGS) {
        if (typeof out[k] !== 'string' || !out[k].trim()) {
            throw new Error(`Plan field "${k}" is missing or empty.`);
        }
        out[k] = out[k].trim();
    }

    for (const k of REQUIRED_ARRAYS) {
        if (!Array.isArray(out[k])) out[k] = [];
        out[k] = out[k].map((s) => String(s).trim()).filter(Boolean);
    }

    // Soft validation: warn if structure labels don't look like [Section].
    for (const label of out.structure) {
        if (!SECTION_LABEL_RE.test(label)) {
            console.error(
                `[warn] plan.structure entry "${label}" does not look like a ` +
                `Suno-style section label (e.g. "[Verse 1]"). Continuing anyway.`
            );
            break;
        }
    }

    return out;
}

export function planToPromptBlock(plan) {
    const lines = [
        `Title: ${plan.title}`,
        `Genre: ${plan.genre}`,
        `Mood: ${plan.mood}`,
        `Theme: ${plan.theme}`,
        `Story: ${plan.story}`,
        `Setting: ${plan.setting}`,
        `Perspective: ${plan.perspective}`,
        `Motifs: ${plan.motifs.length ? plan.motifs.join(', ') : '—'}`,
        `Structure: ${plan.structure.length ? plan.structure.join(' → ') : '—'}`,
        `Style brief (seed for the STYLE section): ${plan.style_prompt}`,
    ];
    return lines.join('\n');
}