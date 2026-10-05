# resonate

Turn a one-line idea into a finished song.

You give it a theme, it plans the song, writes the lyrics, generates the score,
converts it to MIDI, and renders a mastered WAV — all in one command.

```
theme  →  lyrics  →  ABC  →  MIDI  →  WAV
```

## What you get

A folder per song under `songs/`:

```
songs/2026-10-05-exit-sign-to-somewhere/
├── plan.json    the creative plan behind the song
├── song.md      the lyrics and style
├── score.abc    the musical score
├── score.mid    the MIDI file
└── song.wav     the final audio
```

Every stage writes into the same folder. You can run the whole pipeline at
once, or stop and rerun any stage on its own.

## Install

Requires Node 22+, `pnpm`, `fluidsynth`, and `ffmpeg` on your PATH.

```powershell
pnpm install
Copy-Item .env.example .env     # then edit .env and set AI_API=<your key>
pnpm run install-soundfont      # one-time download (~31 MB)
```

## Use

### Full song

```powershell
resonate song
resonate song --theme "missing someone on a rainy Tokyo night"
resonate song --theme "..." --genre "R&B" --mood "wistful"
```

### Offline (no score server)

```powershell
resonate song --theme "..." --dry-score
```

Skips the score server and uses a placeholder score. Useful for testing the
rest of the pipeline.

### One stage at a time

```powershell
resonate plan   --theme "..." -o plan.json
resonate write  plan.json
resonate score  songs\<folder> [--dry-run]
resonate midi   songs\<folder>
resonate render songs\<folder>
```

Each stage reads from the song folder and writes back into it.

### See what you've made

```powershell
resonate list
```

Shows every song and which stages have been completed.

## That's it

If `resonate song` finishes and `songs\<folder>\song.wav` plays, everything
worked.