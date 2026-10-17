#!/usr/bin/env python3
"""Cut the portal walkthrough into a trailer timed to the music: story cards, persona overlays on sped-up footage,
the knowledge graph as the opening and closing shot, a rapid-fire montage, cuts on the music's hits and bars.
usage: assemble.py walkthrough.mp4 music.mp3 cards_dir out.mp4"""
import os
import subprocess
import sys
import tempfile

demo, music, cards, out = sys.argv[1:5]
FPS = 30
KG = ("910:512:617:540", 0.5)       # the knowledge graph's dark canvas, cropped to 16:9 (crop, vertical anchor)
ANSWER = ("1060:596:690:200", 0.3)  # the RevOps answer with its citations in the Foundry playground


def clip(a, b, **opt):
    return {"clip": (a, b), **opt}


def card(name):
    return {"card": name}


BAR = 1.7872  # one bar of the drums (4 beats at ~134 bpm)
CLIMAX = 156.1
RAPID_WIDE = [(234.0, 237.5, KG), (217.0, 220.5, None), (144.0, 147.5, None), (158.5, 162.0, None), (197.5, 201.0, None), (313.0, 316.5, None)]
RAPID_FAST = [(175.0, 177.0), (189.0, 191.0), (45.5, 47.5), (73.0, 75.0), (266.0, 268.0), (279.0, 281.0),
              (290.0, 292.0), (247.5, 249.5), (258.0, 260.0), (304.0, 306.0), (253.0, 255.0), (128.0, 130.0)]

# Music: "Heroic Motif" (207.96 s). A quiet intro to 60.4 s, drums 60.4 to 84.1 and 91.4 to 118.2, a calm melodic
# stretch with hits at 127.75, 133.5, 137, 140.3, 146.7 and 152.65, the climax 156.1 to 179.4, a build from 183.2,
# the last peak at 196.65 and a fade from 203. Each entry starts at its time; it lasts until the next one.
TIMELINE = [
    (0.00, card("IDENT")),                                                   # Microsoft × MongoDB
    (7.05, clip(228.3, 236.0, zoom=(KG, 1.00, 1.10), fadein=1.2, overlay="OPEN")),  # the graph: every company already has a brain
    (17.45, card("SCATTER")),                                                # scattered across six systems
    (22.50, clip(173.0, 177.5)),                                             # Era by Eon services
    (23.80, clip(187.5, 192.0)),                                             # Slack messages
    (25.10, clip(197.0, 201.5)),                                             # Zendesk users, PII
    (26.45, card("Q1")),                                                     # what if we could build a real company brain at hyperscale,
    (31.30, card("Q2")),                                                     # on data that behaves like a real enterprise?
    (36.15, card("Q3")),                                                     # one that could remember, reason, and prove every answer
    (41.70, clip(17.7, 49.5, blur=True, overlay="P1")),                      # persona: Support Lead
    (46.40, clip(52.1, 77.5, blur=True, overlay="P2")),                      # persona: Account Manager
    (51.10, clip(80.3, 104.5, blur=True, overlay="P3")),                     # persona: RevOps Analyst
    (55.75, clip(107.0, 131.5, blur=True, overlay="P4")),                    # persona: Product Lead
    (60.40, card("ONEMEM")),                                                 # drums: four personas, one memory
    (60.40 + BAR, card("TRACE")),
    (60.40 + 2 * BAR, clip(138.8, 170.0)),                                   # the trace: steps, remember, graph (4 bars)
    (60.40 + 6 * BAR, card("MEMGOV")),
    (60.40 + 7 * BAR, clip(262.5, 271.0)),                                   # Context Center memories
    (60.40 + 8 * BAR, clip(274.0, 283.0)),                                   # one memory, linked to its agents
    (60.40 + 9 * BAR, clip(286.0, 298.0)),                                   # memory lineage (2 bars)
    (60.40 + 11 * BAR, card("COLUMN")),
    (60.40 + 12 * BAR, clip(212.0, 225.0)),                                  # column-level lineage, slow through the break
    (91.40, card("METRIC")),                                                 # drums again
    (91.40 + BAR, clip(244.5, 251.5)),                                       # governed metric and its code
    (91.40 + 3 * BAR, card("PRODUCT")),
    (91.40 + 4 * BAR, clip(252.5, 261.5)),                                   # data marketplace
    (91.40 + 6 * BAR, card("PII")),
    (91.40 + 7 * BAR, clip(196.5, 204.0)),                                   # Zendesk users: PII per column
    (91.40 + 9 * BAR, card("VOCAB")),
    (91.40 + 10 * BAR, clip(299.5, 311.0)),                                  # the term an agent proposed, In Review
    (91.40 + 12 * BAR, clip(312.0, 326.0)),                                  # the ontology explorer (3 bars)
    (118.21, card("RECEIPTS")),                                              # calm: every answer cites its sources
    (122.00, clip(97.5, 103.8, zoom=(ANSWER, 1.00, 1.10))),                  # the RevOps answer, readable, with its citations
    (127.75, card("S1")), (133.50, card("S2")), (137.00, card("S3")), (140.30, card("S4")), (146.70, card("S5")),  # the stack
    (152.65, card("RECAP")),                                                 # six systems, four agents, one memory
    *[(CLIMAX + i * BAR, clip(a, b, flash=0.15, **({"zoom": (z, 1.0, 1.08)} if z else {}))) for i, (a, b, z) in enumerate(RAPID_WIDE)],
    *[(CLIMAX + 6 * BAR + i * BAR / 2, clip(a, b, flash=0.12)) for i, (a, b) in enumerate(RAPID_FAST)],
    (CLIMAX + 12 * BAR, clip(320.0, 323.0)),                                 # last climax shot: the ontology, searched
    (179.40, clip(231.5, 236.0, zoom=(KG, 1.12, 1.25), overlay="BUTTON")),  # break: back to the graph, ask your company anything
    (189.95, card("ONEBRAIN")),                                              # the build: one brain, every system, every agent, every answer
    (196.65, card("TITLE")),                                                 # the last peak: title drop
    (203.00, card("DATE")),                                                  # the fade: 18 October 2026
]
END = 207.96


def run(*args):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", *args], check=True)


ENC = ["-an", "-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p"]
tmp = tempfile.mkdtemp(prefix="trailer-")
parts = []
for i, (t, e) in enumerate(TIMELINE):
    dur = (TIMELINE[i + 1][0] if i + 1 < len(TIMELINE) else END) - t
    n = round((t + dur) * FPS) - round(t * FPS)  # frame-exact boundaries keep every cut on the beat
    fit = f"tpad=stop_mode=clone:stop=60,trim=end_frame={n},setpts=PTS-STARTPTS"
    path = os.path.join(tmp, f"{i:02d}.mp4")
    if "card" in e:
        run("-i", os.path.join(cards, f"card-{e['card']}.mp4"), "-vf", f"fps={FPS},{fit}", "-frames:v", str(n), *ENC, path)
        label = f"card {e['card']}"
    elif "black" in e:  # (kept for cut lists that want a black beat)
        run("-f", "lavfi", "-i", f"color=c=black:s=1920x1080:r={FPS}", "-frames:v", str(n), *ENC, path)
        label = "black"
    else:
        a, b = e["clip"]
        k = (b - a) / dur
        vf = [f"setpts=(PTS-STARTPTS)/{k:.4f}", f"fps={FPS}"]
        if "zoom" in e:  # crop, upscale, slow push-in anchored at a height
            (crop, ay), z0, z1 = e["zoom"]
            vf += [f"crop={crop}", "scale=3840:2160:flags=lanczos",
                   f"zoompan=z='{z0}+({z1}-{z0})*on/{n}':x='iw/2-(iw/zoom/2)':y='ih*{ay}-(ih/zoom*{ay})':d=1:s=1920x1080:fps={FPS}"]
        if e.get("blur"):
            vf += ["gblur=sigma=2.5", "eq=brightness=-0.04"]
        vf.append(fit)
        if e.get("fadein"):
            vf.append(f"fade=t=in:st=0:d={e['fadein']}")
        if e.get("fadeout"):
            vf.append(f"fade=t=out:st={dur - e['fadeout']:.3f}:d={e['fadeout']}")
        if e.get("flash"):
            vf.append(f"fade=t=in:st=0:d={e['flash']}:color=white")
        inputs = ["-ss", f"{a:.3f}", "-t", f"{b - a + 0.5:.3f}", "-i", demo]
        if "overlay" in e:
            inputs += ["-i", os.path.join(cards, f"card-{e['overlay']}.mov")]
            graph = f"[0:v]{','.join(vf)}[bg];[1:v]fps={FPS},{fit}[fg];[bg][fg]overlay=0:0:format=auto,format=yuv420p"
            run(*inputs, "-filter_complex", graph, "-frames:v", str(n), *ENC, path)
        else:
            run(*inputs, "-vf", ",".join(vf), "-frames:v", str(n), *ENC, path)
        label = f"clip {a:.1f}-{b:.1f}s at {k:.2f}x" + (f" + {e['overlay']}" if "overlay" in e else "")
    print(f"{t:7.2f}s  {n:4d} frames  {label}")
    parts.append(path)
t = END

lst = os.path.join(tmp, "list.txt")
with open(lst, "w") as f:
    f.writelines(f"file '{p}'\n" for p in parts)
run("-f", "concat", "-safe", "0", "-i", lst, "-i", music, "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS),
    "-af", f"loudnorm=I=-15:TP=-1.2:LRA=12,afade=t=out:st={t - 1.5:.2f}:d=1.5",
    "-c:a", "aac", "-b:a", "192k", "-t", f"{t:.3f}", "-movflags", "+faststart", out)
print(f"trailer: {t:.2f}s → {out}")
