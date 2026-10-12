# resonate

Generate songs end-to-end.

```
theme → lyrics → ABC → MIDI → WAV
```

---

## Install

Requires Node 22+, `pnpm`, `ffmpeg`, Python with `pedalboard` and `mido`,
and a running YuE2 server on `http://127.0.0.1:8080` for the score stage.

```powershell
pnpm install
Copy-Item .env.example .env             # set AI_API=<your key>
pip install pedalboard mido numpy       # for VST3 rendering
```

---

## Quick start

```powershell
# 1. Write a new song (plan + lyrics)
resonate lyrics --theme "rainy Tokyo at night"

# 2. Generate the score, MIDI, and audio
resonate all

# 3. See what you got
resonate show
```

Every stage skips work that's already done. Ctrl+C any time; run the same
command again to resume.

Song folders are named `<slug>-<date>` (e.g.
`neon-on-the-window-2026-10-05`), so a directory listing sorts by title
with same-title songs in chronological order.

---

## Commands

### Creating songs

```powershell
resonate lyrics --theme "rainy Tokyo at night"
resonate lyrics --n 10 --genre "indie pop"
resonate lyrics --n 5 --genre "indie pop" --mood "melancholy"
```

Creates a new song folder with a plan and lyrics. `--theme` only works
with `--n 1`; `--genre` and `--mood` apply to every song in the batch.

### Generating a score from an existing recording

```powershell
resonate transcribe songs\ekta-chele-2023-10-06
resonate transcribe --force
```

Drop the recording into the song folder as `og_song.wav`, `.mp3`,
`.m4a`, `.flac`, or `.ogg`. The pipeline re-encodes it and sends it to
SheetSage2, which writes `score.abc`. It takes about 3 minutes per
3-minute track on CPU.

### Running the pipeline

```powershell
resonate score              # song.md → score.abc
resonate midi               # score.abc → score.mid + score.human.mid
resonate render             # score.mid → song.wav
resonate all                # score → midi → render

resonate score  songs\neon-on-the-window-2026-10-05    # one song only
resonate all    --force                                # redo everything
```

### Video

```powershell
resonate video                                  # songs that have a thumbnail
resonate video songs\neon-on-the-window-2026-10-05
resonate video --force
```

Drop a `thumbnail.png` (or `.jpg` / `.jpeg` / `.webp`) next to `song.wav`.
Songs without one are skipped — the video is just the still image over
the audio, so there's nothing sensible to guess.

`video` is not part of `resonate all` — most songs won't have artwork,
and a batch of warnings on every run is noise.

### Checking status

```powershell
resonate list                                       # table of all songs
resonate show                                       # detailed status
resonate show songs\neon-on-the-window-2026-10-05
resonate show --loudness                            # measure each song.wav (slow)
resonate meta songs\neon-on-the-window-2026-10-05   # generation info
```

### Recreating a song

```powershell
resonate recreate songs\neon-on-the-window-2026-10-05 --force
```

Re-issues the saved YuE2 request with the same seed, producing the same
score.

---

## Song folder

Each song lives in `songs/<slug>-<date>/`:

```
plan.json         creative plan       (source)
song.md           lyrics + style      (source)
og_song.mp3       source recording    (source, optional — for transcribe)
score.abc         ABC notation        (source)
thumbnail.png     cover art           (source, optional — for video)
score.mid         MIDI                (regenerable)
song.wav          final audio         (regenerable)
song.mp4          upload-ready video  (regenerable)
```

---

## Configuring instruments (VST3)

Songs render through VST3 plugins, chosen by **ABC voice name**. Open
`config.yaml` and edit `render.voices`:

```yaml
render:
  backend: vst3

  voices:
    Vocal:         "C:/Program Files/Common Files/VST3/AGML.vst3/Contents/x86_64-win/AGML.vst3"
    Ins:           "C:/Program Files/Common Files/VST3/AGML.vst3/Contents/x86_64-win/AGML.vst3"
    accompaniment: "C:/Program Files/Common Files/VST3/Audiolatry/Grand Piano.vst3"

  gains:
    Vocal:         0.9
    Ins:           0.9
    accompaniment: 3.0
```

- **`V: Vocal`** in the score → key is `"Vocal"`.
- **`V: Ins`** → key is `"Ins"`.
- **The auto-generated chord track** (from `"C"`, `"G7"`, `"Fmaj7"` symbols)
  → key is `"accompaniment"`.

Any song that declares `V: Vocal` uses whatever `Vocal` points at. Add
`V: Shamisen` to a song's `score.abc` and add one line to `config.yaml`
— now every song with a Shamisen voice uses that plugin.

A voice in the score with no entry in `render.voices` causes a render
error naming the voice.

The `vst3:` path is the **inner `.vst3` file**, not the outer folder.
On Windows it's usually `<Name>.vst3/Contents/x86_64-win/<Name>.vst3`.
To find installed plugins:

```powershell
Get-ChildItem -Path 'C:\Program Files\Common Files\VST3' -Recurse `
  -Filter *.vst3 |
  Where-Object { $_.FullName -match 'x86_64-win' } |
  Select-Object -ExpandProperty FullName
```

`gains` is optional — voices not listed default to `1.0`. Use it to
balance plugins that output at very different levels.

---

## Configuration

Everything lives in `config.yaml`.

| Section | What it controls |
|---------|------------------|
| `paths.songs_dir` | where song folders live (default: `songs/`) |
| `api.base_url` | the OpenAI-compatible endpoint for the lyrics stage |
| `score` | YuE2 server settings (URL, model, seed, timeout) |
| `transcribe` | SheetSage2 server settings |
| `render` | VST3 routing, humanization, loudness target |
| `video` | frame size, fit mode, x264 quality |

### Folder naming

`lyrics.date_in_folder` (default `true`) controls how new song folders
are named:

| Value | Format | Example |
|-------|--------|---------|
| `true` | `<slug>-<date>` | `neon-on-the-window-2026-10-05` |
| `false` | `<slug>` | `neon-on-the-window` |

With `false`, name collisions get a `-2`, `-3`, ... suffix.

To migrate existing folders from the old `<date>-<slug>` scheme:

```powershell
pnpm rename-folders               # preview
pnpm rename-folders -- --apply    # do it
```

The script uses `git mv`, so renames are recorded as renames in history,
not delete + add. It's idempotent — folders already in the new format
are skipped.

### Loudness

Every render is normalized to a streaming target:

```yaml
render:
  loudness:
    enabled: true
    target_lufs: -14    # Spotify / YouTube
    true_peak_db: -1
```

This is the one place the pipeline decides output level. If a very
dynamic mix can't reach the target without clipping, `loudnorm` reduces
gain instead of clipping. Raise `target_lufs` toward `-18` for a more
open master, or set `enabled: false` to keep the raw backend level and
let the streaming service handle it.

Check what a rendered song measures:

```powershell
resonate show songs\neon-on-the-window-2026-10-05 --loudness
#   loudness      -14.1 LUFS   -1.0 dBFS peak   on target
```

### Humanization

Adds subtle timing drift, velocity variation, and chord roll so the
rendered MIDI sounds played rather than programmed.

```yaml
render:
  humanize:
    enabled: true
    timing_ms: 4
    velocity: 4
    chord_roll_ms: 4
    roll_order: up
    seed: 0     # 0 = random each run; non-zero = reproducible
```

After changing these, run `resonate midi --force` — `score.human.mid` is
written by the midi stage, and `render` will keep using the old file
until you regenerate it.

### Video fit

When the thumbnail isn't 16:9, `video.fit` decides what happens:

| Value | Result |
|-------|--------|
| `blur` (default) | blurred copy fills the frame behind the art |
| `pad` | art centered on a black frame, nothing cropped |
| `crop` | art scaled to cover, overhang trimmed |

---

## Troubleshooting

**`resonate: command not found`.**
Check that `bin/cli.js` exists in the repo root. Then `pnpm link`.

**`ModuleNotFoundError: No module named 'pedalboard'`.**
```powershell
pip install pedalboard mido numpy
```

**`No instrument configured for ABC voice "X"`.**
A voice in the score has no entry under `render.voices`. Add it to
`config.yaml` and re-render.

**`VST3 not found: ...`.**
One of the paths in `render.voices` doesn't point at a real file. Use the
`Get-ChildItem` command above to find the correct inner path.

**`Could not find ABC text in YuE2 response`.**
The server returned an unrecognized response. The first 50 KB are written
to `yue2_debug_response.json` in the repo root.

**`SheetSage2 returned non-JSON`.**
Server is up but returned something unexpected. Usually a version mismatch
— check the server's console.

**`encoder backend buffer allocation failed` (HTTP 500 on score/transcribe).**
The audio.cpp server is on a Vulkan backend. SheetSage2 needs its own
process with `"backend": "cpu"` on port 8081; YuE2 stays on 8080.

**`song.wav` is much quieter than expected.**
The mix is too dynamic for `loudnorm` to hit the target without clipping.
Raise `render.loudness.target_lufs` toward `-18`, or set
`enabled: false`.

**Humanization changes don't take effect.**
Run `resonate midi --force` first, then re-render.