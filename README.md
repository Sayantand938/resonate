# resonate

Generate songs end-to-end.

```
theme → lyrics → ABC → MIDI → WAV
```

- [Install](#install)
- [Use](#use)
- [Layout](#layout)
  - [Repository](#repository)
  - [Song folder](#song-folder)
  - [Architecture](#architecture)
- [Configuration](#configuration)
- [Transcription](#transcription)
- [MIDI engine](#midi-engine)
  - [Humanization](#humanization)
  - [Loudness](#loudness)
- [Video](#video)
- [Troubleshooting](#troubleshooting)

## Install

Requires Node 22+, `pnpm`, `fluidsynth`, `ffmpeg`, and a running YuE2
server on `http://127.0.0.1:8080` for the score stage.

```powershell
pnpm install
Copy-Item .env.example .env             # set AI_API=<your key>
pnpm run install-soundfont              # one-time ~31 MB download
```

> **Note:** `config.yaml` defaults `api.base_url` to a third-party
> OpenAI-compatible proxy (`api.aicredits.in`). If you'd rather talk to
> OpenAI directly, set `api.base_url: https://api.openai.com/v1` in
> `config.local.yaml`.

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
bin/cli.js            CLI entry point
config.yaml           portable defaults            (tracked)
config.local.yaml     machine-specific overrides    (gitignored)

src/
  cli/                command registration, progress, result summaries
    commands/         one module per `resonate` subcommand
  song/               pipeline orchestration
    lyrics/           planner, writer, parser, prompts/
    score/            YuE2 client, ABC generator, SheetSage2 transcriber
  abc/engine.mjs      ABC → MIDI via abcjs
  abc/track-map.mjs   abcjs track layout → per-voice MIDI channel
  midi/               byte-level MIDI transforms
    events.mjs        MIDI → absolute-tick event lists (the one *JS* parser;
                      render_vst_multi.py has its own via mido, VST3 only)
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

### Architecture

Three rules hold the codebase together, and the refactor makes each of them
structural rather than aspirational:

**1. One implementation per step.** The MIDI event parser lives in
[midi/events.mjs](src/midi/events.mjs) and nowhere else — the humanizer, the
velocity normalizer, the program injector, and every tool under `tools/` all
go through it. Same for the ABC → MIDI renderer
([abc/engine.mjs](src/abc/engine.mjs)) and the loudness step
([audio/loudness.mjs](src/audio/loudness.mjs)). When a second implementation
appears, it is a bug.

**2. Stage shape is defined once.** Every pipeline stage — `score`,
`transcribe`, `midi`, `render`, `video` — follows the same shape: check the
input is present, check the output is not (unless `--force`), run, catch,
tag the result with the stage name. That loop lives in
[pipeline.mjs](src/song/pipeline.mjs)'s `runStage` helper. Stages declare
their input check, output check, and work function; they never
re-implement the loop. Adding a new stage cannot forget the "skip when input
missing" check, because there is nowhere to forget it.

**3. Loudness is not a backend concern.** Render backends turn MIDI into
WAV. That is all they do. Loudness normalization is applied by the registry
after the backend returns, so a new backend cannot skip it by accident.
This is not a stylistic preference: the FluidSynth and VST3 paths once
produced the same song ~11 dB apart because one backend normalized and the
other did not. The registry exists so that specific class of bug cannot
recur.

The pieces that still require reasoning about a specific tool's output
convention — abcjs's track layout is the main one — live in their own small
modules ([abc/track-map.mjs](src/abc/track-map.mjs)) with their own
warnings, rather than being tangled into the rendering path.

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

That remap is the one place in the project that has to reason about
abcjs's output convention — "track 0 is conductor, tracks 1..N are voices,
track N+1 is the auto-accompaniment if the ABC had chord symbols." It lives
in [abc/track-map.mjs](src/abc/track-map.mjs), counts voices from the ABC
source itself rather than trusting the MIDI, and warns on stderr when the
convention looks violated (track 0 contains notes; two tracks end up on
the same channel) rather than silently remapping wrong.

Voice programs are configured under `render.voice_programs` in
`config.yaml`. Change them to taste; see the General MIDI spec for the
full list of program numbers.

### Humanization

When `render.humanize.enabled` is true, `midi` writes a second file,
`score.human.mid` — the abcjs output with timing drift, velocity variation
and chord roll applied — and `render` prefers it over `score.mid`.

The defaults are deliberately small, because the point is a touch of life
rather than an audible performance:

| Setting | Default | Meaning |
|---------|---------|---------|
| `timing_ms` | 4 | how far the timing drift wanders either way |
| `velocity` | 4 | max velocity variation per note |
| `chord_roll_ms` | 4 | stagger between notes of a same-tick chord |
| `roll_order` | `up` | `up` strums low→high, `down` the reverse |

Two details worth knowing:

* **Timing drifts, it does not jitter.** The part is moved by a bounded
  random walk, so it pushes and pulls as a phrase. Independent random jitter
  on every note is what makes a part sound like an unsteady beginner.
* **Milliseconds are tempo-aware.** They are converted using the song's own
  tempo, so `4` means 4 ms at 70 BPM and at 140 BPM alike. Earlier versions
  assumed 120 BPM, which made a "15 ms" setting deliver 25 ms on a slow song.

A third detail matters more than it sounds:

* **A note never runs into the next one of the same pitch.** The clean abcjs
  output is exactly legato, so drift would otherwise manufacture overlaps —
  and a sampled guitar cannot sound one pitch twice on one string, so it
  chokes the earlier note and you hear it as muted. Releases are clamped to
  the next same-pitch onset, preserving the original gap, so detached notes
  and the accompaniment's deliberately overlapping chords keep their
  articulation. Only notes that would have been choked are touched, by a
  tick or two.

Set `humanize.seed` to a non-zero value for reproducible renders; `0` picks a
fresh random seed each run.

⚠️ Changing these settings does **not** rewrite `score.human.mid`; that file
is written by the `midi` stage. Re-run `resonate midi --force` afterwards,
or `render` will keep using the old file.

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

## Troubleshooting

**`resonate: command not found` after install.**
Check that `bin/cli.js` exists in the repo root and is executable. `package.json`
declares the binary as `./bin/cli.js`; if that file is missing, `pnpm install -g`
installs a broken shim. Re-clone or restore the file, then re-run `pnpm link`.

**The score stage returns HTTP 500 with `encoder backend buffer allocation failed`.**
The audio.cpp server is running with a global Vulkan backend. SheetSage2 needs
its own process with `"backend": "cpu"` — see the note under [Transcription](#transcription).
Check that `transcribe.base_url` is on 8081 and `score.base_url` is on 8080.

**`song.wav` plays back much quieter than expected, and `resonate show --loudness`
reports a large gap to the target.**
The mix is too dynamic for `loudnorm` to reach `target_lufs` without clipping.
Raise `render.loudness.target_lufs` toward `-18` for a more open master, or
disable normalization entirely and let the streaming service do the work.
See [Loudness](#loudness).

**Humanization settings changed, but `song.wav` sounds the same.**
`score.human.mid` is written by the `midi` stage. After changing
`render.humanize.*`, run `resonate midi --force` before re-rendering.

**`resonate score` fails with `Could not find ABC text in YuE2 response`.**
The server returned a response the artifact walker did not recognize. The
first 50 KB of the response are written to `yue2_debug_response.json` in
the repo root for inspection.

**`resonate transcribe` fails with `SheetSage2 returned non-JSON`.**
The server is up but returned something other than the expected task JSON.
Usually a version mismatch between the client and the running server; check
the server's console output.

**A voice's instrument sounds wrong, or two voices share an instrument.**
The track → channel remap in [abc/track-map.mjs](src/abc/track-map.mjs)
found something it did not expect — check stderr for `[warn] abc-engine:`
lines. The most common cause is an ABC file whose voices are declared only
inline (`[V:...]` mid-line) rather than as `V:` headers; both forms are
counted, but a custom abcjs output layout will still trip the sanity check.
The remap is deliberately not applied when the input looks structurally
broken, so the render succeeds with the original channels rather than
producing a wrong-but-plausible result.