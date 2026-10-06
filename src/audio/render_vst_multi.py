#!/usr/bin/env python3
# src/audio/render_vst_multi.py — render MIDI to WAV through multiple VST3
# instruments, one per channel group, mixed into a single stereo WAV.
#
# Usage:
#   python src/audio/render_vst_multi.py <in.mid> <out.wav> \
#       --routes '[{"channels":[0,1],"vst3":"...","gain":1.0}, ...]' \
#       [--sr 44100] [--normalize]

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from pedalboard import load_plugin
from pedalboard.io import AudioFile
from mido import MidiFile


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("midi_path")
    p.add_argument("out_path")
    p.add_argument("--routes", required=True,
                   help="JSON array of route objects: "
                        '[{"channels":[0,1],"vst3":"/path/to.vst3","gain":1.0}, ...]')
    p.add_argument("--sr", type=int, default=44100)
    p.add_argument("--normalize", action="store_true",
                   help="normalize final mix to -1 dBFS if it clips")
    return p.parse_args()


def extract_tempo_us(mid):
    """First set_tempo in microseconds per beat. Default 500000 = 120 BPM."""
    for track in mid.tracks:
        for msg in track:
            if msg.type == "set_tempo":
                return msg.tempo
    return 500_000


def build_absolute_timeline(mid):
    """Return [(absolute_ticks, mido.Message), ...] sorted by time.
    Skips meta events; only channel messages (note, program change)."""
    events = []
    for track in mid.tracks:
        abs_tick = 0
        for msg in track:
            abs_tick += msg.time
            if msg.is_meta:
                continue
            events.append((abs_tick, msg))
    events.sort(key=lambda x: x[0])
    return events


def main():
    args = parse_args()

    if not Path(args.midi_path).exists():
        print(f"MIDI not found: {args.midi_path}", file=sys.stderr)
        sys.exit(1)

    try:
        routes = json.loads(args.routes)
    except json.JSONDecodeError as e:
        print(f"Invalid --routes JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if not routes:
        print("No routes provided.", file=sys.stderr)
        sys.exit(1)

    for i, r in enumerate(routes):
        if "channels" not in r or "vst3" not in r:
            print(f"Route {i} missing 'channels' or 'vst3'.", file=sys.stderr)
            sys.exit(1)
        if not Path(r["vst3"]).exists():
            print(f"Route {i} VST3 not found: {r['vst3']}", file=sys.stderr)
            sys.exit(1)

    mid = MidiFile(args.midi_path)
    tempo_us = extract_tempo_us(mid)
    ticks_per_beat = mid.ticks_per_beat
    seconds_per_tick = (tempo_us / 1_000_000.0) / ticks_per_beat

    timeline = build_absolute_timeline(mid)
    if not timeline:
        print("No MIDI events found.", file=sys.stderr)
        sys.exit(1)

    last_tick = timeline[-1][0]
    duration_s = last_tick * seconds_per_tick + 2.0

    total_samples = int(duration_s * args.sr)

    print(f"MIDI: {len(timeline)} events, {last_tick} ticks, "
          f"{duration_s:.2f}s at {args.sr}Hz", file=sys.stderr)

    channel_to_route = {}
    for ri, r in enumerate(routes):
        for ch in r["channels"]:
            if ch in channel_to_route:
                print(f"Warning: channel {ch} assigned to multiple routes; "
                      f"using route {ri}", file=sys.stderr)
            channel_to_route[ch] = ri

    per_route_events = [[] for _ in routes]
    for tick, msg in timeline:
        if msg.type not in ("note_on", "note_off", "program_change"):
            continue
        ch = getattr(msg, "channel", None)
        if ch is None:
            continue
        ri = channel_to_route.get(ch)
        if ri is None:
            continue
        t_sec = tick * seconds_per_tick
        per_route_events[ri].append((msg.bytes(), t_sec))

    per_route_audio = []
    for ri, r in enumerate(routes):
        events = per_route_events[ri]
        gain = float(r.get("gain", 1.0))
        print(f"Route {ri}: ch={r['channels']} "
              f"plugin={Path(r['vst3']).name} "
              f"events={len(events)} gain={gain}", file=sys.stderr)

        if not events:
            per_route_audio.append(np.zeros((2, total_samples), dtype=np.float32))
            continue

        plugin = load_plugin(r["vst3"])
        print(f"  loaded: {plugin.name}", file=sys.stderr)

        audio = plugin(events, duration=duration_s, sample_rate=args.sr)

        if audio.ndim == 1:
            audio = np.stack([audio, audio])
        elif audio.shape[0] == 1:
            audio = np.vstack([audio, audio])
        elif audio.shape[0] > 2:
            audio = audio[:2, :]

        if audio.shape[1] < total_samples:
            pad = np.zeros((audio.shape[0], total_samples - audio.shape[1]),
                           dtype=audio.dtype)
            audio = np.concatenate([audio, pad], axis=1)
        elif audio.shape[1] > total_samples:
            audio = audio[:, :total_samples]

        peak = float(np.max(np.abs(audio))) if audio.size else 0.0
        print(f"  route peak before gain: {peak:.4f}", file=sys.stderr)

        audio = audio * gain
        per_route_audio.append(audio)

    mix = np.zeros((2, total_samples), dtype=np.float32)
    for a in per_route_audio:
        mix += a.astype(np.float32)

    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    print(f"Mix peak before normalize: {peak:.4f}", file=sys.stderr)

    if args.normalize and peak > 1.0:
        target = 0.891
        mix = mix * (target / peak)
        peak = target
        print(f"Normalized to {peak:.4f}", file=sys.stderr)

    mix = np.clip(mix, -1.0, 1.0)

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with AudioFile(args.out_path, "w", args.sr, mix.shape[0]) as f:
        f.write(mix)

    print(f"Wrote {args.out_path} ({mix.shape[1] / args.sr:.2f}s, "
          f"peak={peak:.4f})", file=sys.stderr)


if __name__ == "__main__":
    main()