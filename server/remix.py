"""Music remix: find beat-aligned jump points so a piece fits a target length.

usage: remix.py in.wav start end target_seconds
Prints JSON {segments: [[srcStart, srcEnd], ...], achieved, tempo, jumps} in source seconds.
Segments play back to back; consecutive segments are joined at musically similar beats.
"""
import json, sys
import numpy as np
import librosa

path, s0, s1, target = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4])
y, sr = librosa.load(path, sr=22050, mono=True, offset=s0, duration=s1 - s0)
dur = len(y) / sr
if abs(dur - target) < 0.05:
    print(json.dumps({"segments": [[s0, s1]], "achieved": dur, "jumps": 0, "tempo": None})); sys.exit(0)

tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units='frames', trim=False)
times = librosa.frames_to_time(beats, sr=sr)
if len(times) < 8:
    raise SystemExit(json.dumps({"error": "Not enough rhythmic structure to remix (fewer than 8 beats found)"}))
chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13)
sync = lambda f: librosa.util.sync(f, beats, aggregate=np.median)
C, M = sync(chroma), sync(mfcc)
# Feature per beat: harmony + timbre, compared over a 4-beat context so a jump lands in
# a matching bar, not just a matching instant.
F = np.vstack([C / (np.linalg.norm(C, axis=0, keepdims=True) + 1e-9), 0.5 * M / (np.linalg.norm(M, axis=0, keepdims=True) + 1e-9)])
n = F.shape[1]
ctx = 4
def ctxvec(i):
    sl = F[:, max(0, i - ctx):i + 1]
    v = sl.mean(axis=1)
    return v / (np.linalg.norm(v) + 1e-9)
V = np.stack([ctxvec(i) for i in range(n)])
S = V @ V.T  # beat-to-beat similarity

bt = np.append(times[: n], dur)  # beat start times (seconds, relative); bt[i] .. bt[i+1]
intro_min, outro_min = min(8.0, dur * 0.15), min(8.0, dur * 0.15)
best = None
# One jump from beat i to beat j: play [0, bt[i]) then [bt[j], dur).
for i in range(ctx, n):
    if bt[i] < intro_min:
        continue
    for j in range(ctx, n):
        if j == i or dur - bt[j] < outro_min:
            continue
        length = bt[i] + (dur - bt[j])
        err = abs(length - target)
        if err > max(1.0, 60.0 / max(float(np.atleast_1d(tempo)[0]), 1)):
            continue
        score = S[i, j] - err * 0.05
        if best is None or score > best[0]:
            best = (score, i, j, length)
segments = None
if best is not None and best[0] > 0.6:
    _, i, j, length = best
    segments = [[0.0, bt[i]], [bt[j], dur]]
else:
    # Bigger changes: repeat or drop a whole similar section with two jumps.
    if target > dur:
        # Loop back: play to beat a, jump back to b (< a), play to end.
        cands = [(S[a, b], a, b) for a in range(ctx, n) for b in range(ctx, a - ctx) if abs((bt[a] - bt[b]) - (target - dur)) < 2.0]
    else:
        cands = [(S[a, b], a, b) for a in range(ctx, n) for b in range(a + ctx, n) if abs((bt[b] - bt[a]) - (dur - target)) < 2.0 and bt[a] > intro_min and dur - bt[b] > outro_min]
    if cands:
        sc, a, b = max(cands)
        segments = [[0.0, bt[a]], [bt[b], dur]]
if segments is None:
    raise SystemExit(json.dumps({"error": "No musically good jump found for that length; try a length closer to the original or stretch instead"}))
achieved = sum(e - s for s, e in segments)
print(json.dumps({"segments": [[s0 + s, s0 + e] for s, e in segments], "achieved": achieved, "jumps": len(segments) - 1, "tempo": float(np.atleast_1d(tempo)[0])}))
