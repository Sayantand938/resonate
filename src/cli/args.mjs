// src/cli/args.mjs
// Tiny shared argv parser for the standalone scripts in scripts/.
//
// Every flag is described once, in a spec object:
//
//   parseArgs(argv, {
//       '--gain': { key: 'gain', kind: 'number' },
//       '--keep': { key: 'keep', kind: 'flag' },
//   })
//
// `kind` is 'string' (the default), 'number', or 'flag'. Anything not in the
// spec is collected into `positional`, matching the argv conventions the
// scripts used before this helper existed.

export function parseArgs(argv, spec = {}) {
    const out = { positional: [] };

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const def = Object.prototype.hasOwnProperty.call(spec, a) ? spec[a] : null;

        if (!def) {
            out.positional.push(a);
        } else if (def.kind === 'flag') {
            out[def.key] = true;
        } else if (def.kind === 'number') {
            out[def.key] = Number(argv[++i]);
        } else {
            out[def.key] = argv[++i];
        }
    }
    return out;
}

/** Print an optional message plus usage to stderr, then exit 1. */
export function die(message, usage) {
    if (message) console.error(message);
    if (usage) console.error(`Usage: ${usage}`);
    process.exit(1);
}

/**
 * Pull the conventional `<in> <out>` pair out of positional args,
 * or exit with usage.
 */
export function requireInOut(positional, usage) {
    const [inPath, outPath] = positional;
    if (!inPath || !outPath) die(null, usage);
    return { inPath, outPath };
}
