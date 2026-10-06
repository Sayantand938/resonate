# tools/

Development and forensics helpers. **Nothing in here is part of the
pipeline** — `resonate` never calls these. They exist to answer "why does
this MIDI sound wrong?" and they all operate on files you already have.

Run them with `node tools/<name>.mjs ...` from the repo root.

| Tool | Answers |
|------|---------|
| `inspect-midi.mjs` | What is actually inside this MIDI file? Header, tracks, channels, note counts, tempo. |
| `inspect-humanization.mjs` | Did the humanizer do what I asked? Per-channel timing and velocity distributions. |
| `show-collisions.mjs` | Why does this sound doubled? Finds the same pitch playing on two tracks at the same tick. |
| `abcjs-debug.mjs` | What did abcjs produce from this ABC, before our remap/program post-processing? |

## Examples

```powershell
# Structure and contents of a rendered MIDI
node tools/inspect-midi.mjs songs\2026-10-05-the-blue-sock-problem\score.mid

# Compare the mechanical and humanized versions
node tools/inspect-humanization.mjs songs\2026-10-05-the-blue-sock-problem\score.mid
node tools/inspect-humanization.mjs songs\2026-10-05-the-blue-sock-problem\score.human.mid

# Is the melody doubling the accompaniment?
node tools/show-collisions.mjs songs\2026-10-05-the-blue-sock-problem\score.mid

# Raw abcjs output, bypassing src/midi/{meta,remap}.mjs
node tools/abcjs-debug.mjs songs\2026-10-05-the-blue-sock-problem\score.abc .\raw.mid
```

`abcjs-debug.mjs` is the escape hatch when you suspect our own post-processing
(channel remap, program injection, title metadata) rather than abcjs itself:
it renders the ABC and writes the MIDI with none of that applied.
