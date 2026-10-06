# tools/

Development and forensics helpers. **Nothing in here is part of the
pipeline** — `resonate` never calls these. They exist to answer "why does
this MIDI sound wrong?" and they all operate on files you already have.

Run them with `node tools/<name>.mjs ...` from the repo root.

| Tool | Answers |
|------|---------|
| `inspect-midi.mjs` | What is inside this MIDI? Header, tempo, per-track and per-channel note/velocity stats. Add `--collisions` to find the same pitch on two tracks at the same tick — the usual cause of a part sounding doubled. |
| `diff-midi.mjs` | What changed between these two MIDIs? Per-channel timing and velocity deltas, plus how many chords the humanizer staggered. |
| `abcjs-debug.mjs` | What did abcjs produce from this ABC, before our metadata, channel remap and program injection? |

All three share the MIDI reader in `src/midi/events.mjs`, so there is only
one byte-walking implementation to trust.

## Examples

```powershell
# Structure and contents of a rendered MIDI
node tools/inspect-midi.mjs songs\2026-10-05-the-blue-sock-problem\score.mid

# Is the melody doubling the accompaniment?
node tools/inspect-midi.mjs songs\2026-10-05-the-blue-sock-problem\score.mid --collisions

# What did humanization actually do?
node tools/diff-midi.mjs songs\2026-10-05-the-blue-sock-problem\score.mid `
                        songs\2026-10-05-the-blue-sock-problem\score.human.mid

# Raw abcjs output, bypassing src/midi/{meta,remap}.mjs
node tools/abcjs-debug.mjs songs\2026-10-05-the-blue-sock-problem\score.abc .\raw.mid
```

## Reading diff-midi output

`diff-midi.mjs` matches note-ons positionally, which is valid because the
humanizer shifts notes in time but never adds, removes or reorders them. If
the two files are not a simple timing/velocity edit of each other it says so
rather than reporting nonsense.

Useful checks:

* **timing changed ≈ 100%** with a peak near `humanize.timing_ms` — the
  jitter is working.
* **chord groups** should be non-zero and mostly staggered, otherwise the
  chord roll is not firing. `score.abc` needs chord symbols for abcjs to
  generate the accompaniment that the roll acts on.
* **velocity changed** should be roughly the `humanize.velocity` setting.
