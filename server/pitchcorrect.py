"""Automatic pitch correction with the WORLD vocoder.

usage: pitchcorrect.py in.wav out.wav key scale strength speed_ms max_semitones
key: -1 = chromatic, 0..11 = C..B; scale: 0 major, 1 minor.
Prints a JSON report on stdout.
"""
import json, sys
import numpy as np
import pyworld as pw
from scipy.io import wavfile

# Manual mode: pitchcorrect.py in.wav out.wav --curve curve.json  (points [[seconds, cents], ...],
# linear in between, 0 outside) shifts the voice by a hand-drawn curve instead of snapping to notes.
CURVE = None
if len(sys.argv) >= 5 and sys.argv[3] == '--curve':
    src, dst = sys.argv[1], sys.argv[2]
    CURVE = json.load(open(sys.argv[4]))
    key, scale, strength, speed_ms, max_st = -1, 0, 1.0, 0.0, 24.0
else:
    src, dst, key, scale, strength, speed_ms, max_st = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7])
sr, x = wavfile.read(src)
x = x.astype(np.float64)
if x.ndim == 1:
    x = x[:, None]
FP = 5.0  # frame period ms
mono = x.mean(axis=1)
f0, t = pw.dio(mono, sr, frame_period=FP, f0_floor=60, f0_ceil=1100)
f0 = pw.stonemask(mono, f0, t, sr)

if key < 0:
    allowed = np.arange(12)
else:
    steps = [0, 2, 4, 5, 7, 9, 11] if scale == 0 else [0, 2, 3, 5, 7, 8, 10]
    allowed = (np.array(steps) + key) % 12

voiced = f0 > 0
midi = np.zeros_like(f0)
midi[voiced] = 69 + 12 * np.log2(f0[voiced] / 440.0)
# Nearest allowed note for each voiced frame.
target = midi.copy()
for i in np.where(voiced)[0]:
    base = np.floor(midi[i])
    cands = np.array([base + d for d in range(-12, 13) if (int(base + d) % 12) in allowed])
    target[i] = cands[np.argmin(np.abs(cands - midi[i]))]
dev = np.where(voiced, target - midi, 0.0)
dev = np.clip(dev, -max_st, max_st)
# Retune speed: one-pole smoothing of the correction (0 ms = instant, robotic).
a = 0.0 if speed_ms <= 0 else np.exp(-FP / speed_ms)
corr = np.zeros_like(dev)
acc = 0.0
for i in range(len(dev)):
    if not voiced[i]:
        acc = 0.0
        continue
    acc = a * acc + (1 - a) * dev[i]
    corr[i] = acc
if CURVE is not None:
    pts = np.array(CURVE, dtype=float).reshape(-1, 2)
    cents = np.interp(t, pts[:, 0], pts[:, 1], left=0.0, right=0.0) if len(pts) else np.zeros_like(t)
    corr = cents / 100.0
    strength = 1.0
new_f0 = np.where(voiced, 440.0 * 2 ** ((midi + strength * corr - 69) / 12), 0.0)

out = np.zeros_like(x)
for c in range(x.shape[1]):
    ch = np.ascontiguousarray(x[:, c])
    sp = pw.cheaptrick(ch, f0, t, sr)
    ap = pw.d4c(ch, f0, t, sr)
    y = pw.synthesize(new_f0, sp, ap, sr, frame_period=FP)
    n = min(len(y), len(ch))
    out[:n, c] = y[:n]
# Unvoiced stretches (breaths, consonants, silence) keep the original samples exactly.
hop = int(sr * FP / 1000)
mask = np.repeat(voiced.astype(np.float64), hop)[: len(mono)]
mask = np.pad(mask, (0, max(0, len(mono) - len(mask))))
k = np.hanning(int(sr * 0.02) | 1); k /= k.sum()
mask = np.convolve(mask, k, mode='same')[:, None]
res = mask * out + (1 - mask) * x
wavfile.write(dst, sr, res.astype(np.float32))
cents = np.abs(dev[voiced]) * 100 if voiced.any() else np.array([0.0])
print(json.dumps({"voicedFraction": float(voiced.mean()), "meanOffCentsBefore": float(cents.mean()), "maxOffCentsBefore": float(cents.max())}))
