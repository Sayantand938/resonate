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
Copy-Item .env.example .env             # set AI_API=<your key>
pnpm run install-soundfont              # one-time ~31 MB download
```

Optional, for the VST3 render backend:

```powershell
Copy-Item config.local.yaml.example config.local.yaml   # then edit the paths
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
resonate video              # all songs that have a thumbnail
resonate all                # score → midi → render

# Or transcribe an existing recording instead of generating a score
resonate transcribe songs\2023-10-06-ekta-chele

# One song only
resonate score  songs\2026-10-05-neon-on-the-window
resonate all    songs\2026-10-05-neon-on-the-window

# Redo existing outputs
resonate score --force
resonate all   --force

# See status
resonate list
resonate show songs\2026-10-05-neon-on-the-window
resonate show --loudness          # also measure each song.wav (slower)
```

Every stage skips songs whose output already exists. Ctrl+C any time;
resume by running the same command again.

## Layout

### Repository

```
bin/cli.mjs           CLI entry point
config.yaml           portable defaults            (tracked)
config.local.yaml     machine-specific overrides    (gitignored)

src/
  cli/                command registration, progress, result summaries
    commands/         one module per `resonate` subcommand
  song/               pipeline orchestration
    lyrics/           planner, writer, parser, prompts/
    score/            YuE2 client, ABC generator, SheetSage2 transcriber
  abc/engine.mjs      ABC → MIDI via abcjs
  midi/               byte-level MIDI transforms
    events.mjs        MIDI → absolute-tick event lists (the one parser)
    chunks.mjs        MThd/MTrk structure helpers
    varlen.mjs        variable-length quantities
    meta.mjs          title/composer + program injection
    remap.mjs         one channel per voice
    humanize.mjs      timing + velocity jitter, chord roll
    normalize.mjs     velocity range normalization
  audio/              MIDI → WAV backends
    backends.mjs      backend registry + the shared loudness step
    loudness.mjs      LUFS measurement and normalization
    prepare.mjs       any audio → clean PCM WAV (for transcription)
    fluidsynth.mjs    FluidSynth + ffmpeg (portable default)
    vst3.mjs          VST3 instruments (Python + Pedalboard)
    render_vst_multi.py
  video/generator.mjs song.wav + thumbnail → song.mp4

scripts/              standalone CLIs for each stage, plus install-soundfont.ps1
tools/                dev forensics — see tools/README.md
```

The layering rule: **`src/` holds the logic, `scripts/` holds argument parsing
and file reporting, and `tools/` is imported by neither.** Each script under
`scripts/` is a thin wrapper over a `src/` module, and the stage functions in
[stages.mjs](src/song/stages.mjs) call those same modules directly — so every
step has exactly one implementation, whether you drive it from `resonate` or
from `node scripts/midi2wav.mjs`.

Render backends are entries in [backends.mjs](src/audio/backends.mjs) selected
by `render.backend`. Each is a pure renderer: loudness normalization is applied
by the registry afterwards, so a backend cannot skip it.

### Song folder

```
songs/<date>-<slug>/
├── plan.json     creative plan       (source)
├── song.md       lyrics + style      (source)
├── og_song.mp3   source recording    (source, optional — for transcribe)
├── score.abc     ABC notation        (source)
├── thumbnail.png cover art           (source, optional — needed for video)
├── score.mid     MIDI                (regenerable)
├── song.wav      final audio         (regenerable)
└── song.mp4      upload-ready video  (regenerable)
```

## Configuration

`config.yaml` is tracked and contains portable defaults only.
Machine-specific settings — absolute VST3 paths, the render backend, a pinned
humanize seed — belong in `config.local.yaml`, which is gitignored and
deep-merged over the tracked file:

```yaml
# config.local.yaml
render:
  backend: vst3
  vst3_routing:
    - channels: [0, 1]
      vst3: "C:/Program Files/Common Files/VST3/AGML.vst3/Contents/x86_64-win/AGML.vst3"
      gain: 0.9
```

Plain objects merge key by key; arrays and scalars replace wholesale, so
redefining `vst3_routing` takes effect as a whole rather than appending.

## Transcription

`resonate transcribe` produces `score.abc` from an existing recording instead
of generating one from lyrics. It is the mirror of the score stage — same
output artifact, so `midi`, `render` and `video` are unchanged:

```powershell
resonate transcribe songs\2023-10-06-ekta-chele
resonate transcribe --force          # overwrite an existing score.abc
```

Drop the recording into the song folder as `og_song.wav`, `.mp3`, `.m4a`,
`.flac` or `.ogg`. It is re-encoded through ffmpeg before being sent, which
handles compressed sources and also repairs downloaded WAVs whose RIFF sizes
are the `0xFFFFFFFF` "unknown/streamed" placeholder — those read fine in
ffmpeg and ffprobe but make stricter parsers try to read 4 GB.

SheetSage2 writes a **lead sheet**: melody, counter-melody, and chord
symbols. That is exactly the input shape this pipeline already consumes, so
abcjs generates the accompaniment from the transcribed chords, and song
structure comes through as `% intro` / `% verse` / `% chorus` comments.

⚠️ **SheetSage2 must run in its own server process with `backend: cpu`.**
audio.cpp ignores the per-model `backend` key, so a server with a global
Vulkan backend fails with `encoder backend buffer allocation failed` on AMD
hardware. Because of that it cannot share a process with YuE2, and
`transcribe.base_url` therefore defaults to `http://127.0.0.1:8081` while
`score.base_url` stays on `8080`. The launcher's **Run all** starts both.

On CPU it runs at roughly 0.8x realtime — a 3:37 track takes about 3 minutes.

## MIDI engine

Songs are rendered with **abcjs**. It reads the ABC faithfully — correct
tie handling, correct pickup bars, voice names preserved — and generates a
piano accompaniment from the ABC's chord symbols.

Each voice gets its own MIDI channel and instrument:

| Track | Source | Channel | Default instrument |
|-------|--------|---------|--------------------|
| 0 | conductor (meta only) | — | — |
| 1 | `V: Vocal` (melody) | 0 | Nylon Guitar (program 24) |
| 2 | `V: Ins` (counter-melody) | 1 | Acoustic Grand Piano (program 0) |
| 3 | chord accompaniment | 2 | Acoustic Grand Piano (program 0) |

The accompaniment track is generated by abcjs from the `"Eb"`, `"Cm"`,
`"Abmaj7"`-style chord symbols in the ABC. It uses channel 2, remapped by
the pipeline so it never collides with the melody voice.

Voice programs are configured under `render.voice_programs` in
`config.yaml`. Change them to taste; see the General MIDI spec for the
full list of program numbers.

### Humanization

When `render.humanize.enabled` is true, `midi` writes a second file,
`score.human.mid` — the abcjs output with timing jitter, velocity jitter,
and chord roll applied — and `render` prefers it over `score.mid`. Set
`humanize.seed` to a non-zero value for reproducible renders; `0` picks a
fresh random seed each run.

### Loudness

Every render is normalized to a streaming target, set in `render.loudness`:

```yaml
render:
  loudness:
    enabled: true
    target_lufs: -14    # Spotify / YouTube integrated target
    true_peak_db: -1    # Spotify's maximum true peak
```

This is the one place in the project that decides output level, and both
backends go through it — previously FluidSynth normalized to -14 LUFS while
VST3 applied no normalization at all, so the same song could land ~11 dB
apart depending on which backend rendered it.

A quiet mix cannot reach the target for free. When the gain needed to hit
`target_lufs` would push peaks past `true_peak_db`, `loudnorm` reduces gain
instead of clipping, so dynamic material gets some transient limiting. Raise
`target_lufs` toward `-18` for a more open master, or set `enabled: false`
to keep the raw backend level and let the streaming service normalize.

Spotify also caps how far it will lift a quiet track, to leave headroom for
lossy encoding. As their docs put it: *"If a track loudness level is -20 dB
LUFS, and its True Peak maximum is -5 dB FS, we only lift the track up to
-16 dB LUFS."* A master that sits low with unused peak headroom therefore
plays back quieter than its neighbours — it does not get rescued.

To check what a rendered song actually measures, against the configured
target:

```powershell
resonate show songs\2026-10-05-neon-on-the-window --loudness
#   loudness      -14.1 LUFS   -1.0 dBFS peak   on target
```

The flag is opt-in because it costs a full ffmpeg pass per song.

## Video

`resonate video` pairs the rendered audio with a still image and writes
`song.mp4`, ready to upload:

```powershell
resonate video                                  # every song that has a thumbnail
resonate video songs\2026-10-05-neon-on-the-window
resonate video --force                          # rebuild existing videos
```

Drop one of these next to `song.wav`:

```
songs/<date>-<slug>/thumbnail.png     ← or .jpg / .jpeg / .webp
```

**The thumbnail is required.** A song without one is skipped with a warning
rather than rendered with a placeholder — the video is nothing but that
image, so there is nothing sensible to guess:

```
2026-10-05-the-blue-sock-problem
  video   [--] (thumbnail file not present)

[video] 0 songs rendered to video, 8 skipped, 0 failed.

Warnings:
  - 2026-10-05-the-blue-sock-problem  —  thumbnail file not present
```

A thumbnail is a *source*: it is tracked in git, unlike the video. `song.mp4`
is regenerable and gitignored.

Video settings live under `video:` in `config.yaml`. The one worth knowing
about is `fit`, which decides what happens when the artwork is not already
16:9:

| `fit` | Result |
|-------|--------|
| `blur` (default) | A blurred copy of the artwork fills the frame behind it |
| `pad` | Artwork centred on black bars, nothing cropped |
| `crop` | Artwork scaled to cover, overhang trimmed |

Output is H.264 (yuv420p) + AAC with `+faststart`, so it plays everywhere and
YouTube can begin serving before the whole file is fetched. As a rough guide,
a 4:20 track takes about 45 seconds to encode and lands around 10 MB.

`video` is deliberately **not** part of `resonate all`: most songs will not
have artwork yet, and a batch of warnings on every run would be noise.

