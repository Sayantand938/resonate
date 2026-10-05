# resonate

Generate songs end-to-end.

```
theme → lyrics → ABC → MIDI → WAV
```

## Install

Requires Node 22+, `pnpm`, `fluidsynth`, `ffmpeg`, and a running YuE2
server on `http://127.0.0.1:8080` for the score stage.

```powershell
pnpm install
Copy-Item .env.example .env     # set AI_API=<your key>
pnpm run install-soundfont      # one-time ~31 MB download
```

## Use

```powershell
# Create new songs (plan + lyrics only)
resonate lyrics --n 10 --genre "indie pop"
resonate lyrics --theme "rainy Tokyo at night"

# Generate the rest of the pipeline
resonate score              # all songs that need it
resonate midi               # all songs that need it
resonate render             # all songs that need it
resonate all                # score → midi → render

# One song only
resonate score  songs\2026-10-05-neon-on-the-window
resonate all    songs\2026-10-05-neon-on-the-window

# Redo existing outputs
resonate score --force
resonate all   --force

# Pick a MIDI engine
resonate midi --engine abc2midi
resonate all  --engine abcjs

# See status
resonate list
```

Every stage skips songs whose output already exists. Ctrl+C any time;
resume by running the same command again.

## Layout

```
songs/<date>-<slug>/
├── plan.json    creative plan        (source)
├── song.md      lyrics + style       (source)
├── score.abc    ABC notation         (source)
├── score.mid    MIDI                 (regenerable)
└── song.wav     final audio          (regenerable)
```
