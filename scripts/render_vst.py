#!/usr/bin/env python3
# scripts/render_vst.py — render MIDI to WAV via a VST3 instrument using Pedalboard.
#
# Usage:
#   python scripts/render_vst.py <in.mid> <out.wav> --vst <path.vst3> [--sr 44100]

import argparse
import sys
from pathlib import Path

from pedalboard import load_plugin
from pedalboard.io import AudioFile
from mido import MidiFile, Message

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("midi_path")
    p.add_argument("out_path")
    p.add_argument("--vst", required=True)
    p.add_argument("--sr", type=int, default=44100)
    return p.parse_args()

def main():
    args = parse_args()

    mid = MidiFile(args.midi_path)
    messages = []
    for track in mid.tracks:
        for msg in track:
            if msg.type in ("note_on", "note_off"):
                messages.append(msg)

    # Duration: last message time + tail
    last_tick = max((msg.time for msg in messages), default=0)  # not right for absolute
    # Better: use mid.length from MidiFile
    duration = mid.length + 2.0

    # Sort by absolute time
    abs_time = 0
    sorted_msgs = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            if msg.type in ("note_on", "note_off"):
                sorted_msgs.append((t, msg))
    sorted_msgs.sort(key=lambda x: x[0])

    # Convert ticks to seconds
    # mido MidiFile gives ticks_per_beat; tempo changes complicate this
    # For now assume constant tempo from the first set_tempo meta
    tempo = 500000  # default 120 BPM
    for track in mid.tracks:
        for msg in track:
            if msg.type == "set_tempo":
                tempo = msg.tempo
                break

    ticks_per_beat = mid.ticks_per_beat
    seconds_per_tick = (tempo / 1_000_000) / ticks_per_beat

    pedalboard_messages = []
    for tick, msg in sorted_msgs:
        t_sec = tick * seconds_per_tick
        # mido Message doesn't have a `time` we can set directly in the
        # tuple form Pedalboard expects. Construct (bytes, time) tuples.
        if msg.type == "note_on":
            pedalboard_messages.append((msg.bytes(), t_sec))
        elif msg.type == "note_off":
            pedalboard_messages.append((msg.bytes(), t_sec))

    instrument = load_plugin(args.vst)
    print(f"Loaded: {instrument.name}", file=sys.stderr)

    audio = instrument(
        pedalboard_messages,
        duration=duration,
        sample_rate=args.sr,
    )

    Path(args.out_path).parent.mkdir(parents=True, exist_ok=True)
    with AudioFile(args.out_path, "w", args.sr, audio.shape[0]) as f:
        f.write(audio)

    print(f"Wrote {args.out_path} ({audio.shape[1] / args.sr:.2f}s)", file=sys.stderr)

if __name__ == "__main__":
    main()