#!/usr/bin/env python3
"""Speed up the waits in the raw recording (agents thinking) and encode an H.264 MP4.
usage: speedup.py raw.webm segments.json out.mp4 [factor]"""
import json
import subprocess
import sys

raw, seg_file, out = sys.argv[1:4]
factor = float(sys.argv[4]) if len(sys.argv) > 4 else 8.0
seg = json.load(open(seg_file))
total = seg["total"] / 1000
marks = sorted((m["start"] / 1000, m["end"] / 1000) for m in seg["marks"] if m["end"] > m["start"])

parts, t = [], 0.0
for start, end in marks:
    if start > t:
        parts.append((t, start, 1.0))
    parts.append((start, end, factor))
    t = end
if t < total:
    parts.append((t, total, 1.0))

filters, labels = [], []
for i, (a, b, f) in enumerate(parts):
    filters.append(f"[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{f}[v{i}]")
    labels.append(f"[v{i}]")
filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0,format=yuv420p[out]")
cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-filter_complex", ";".join(filters), "-map", "[out]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-r", "30", "-movflags", "+faststart", out]
subprocess.run(cmd, check=True)
kept = sum((b - a) / f for a, b, f in parts)
print(f"{total:.0f} s raw → {kept:.0f} s ({len(marks)} waits at {factor:g}x)")
