"""Audition-style destructive effects that ffmpeg has no filter for.

usage: audition_fx.py <kind> in.wav out.wav [numeric args...]   (see main() for the order)

Everything streams through the file in blocks (input is memory-mapped, output is appended),
so hour-long files stay within a few hundred MB. Audio is 32-bit float throughout.
Prints a JSON report on stdout. User errors end with a last stderr line
"KLANG_ERROR <http status> <message>" and exit code 3.
"""
import json, math, os, struct, sys
# Small matrices: many BLAS threads only fight each other (and other jobs on the box).
for _v in ('OPENBLAS_NUM_THREADS', 'OMP_NUM_THREADS', 'MKL_NUM_THREADS'):
    os.environ.setdefault(_v, '2')
import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from scipy.signal import lfilter


class UserError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


# ── float WAV I/O (memory-mapped in, streamed out) ───────────────────────
def read_wav(path):
    with open(path, 'rb') as f:
        head = f.read(12)
        if head[:4] != b'RIFF' or head[8:12] != b'WAVE':
            raise UserError('Not a WAV file', 422)
        pos, fmt, data = 12, None, None
        while True:
            f.seek(pos)
            h = f.read(8)
            if len(h) < 8:
                break
            cid, size = h[:4], struct.unpack('<I', h[4:])[0]
            if cid == b'fmt ':
                b = f.read(16)
                tag, ch, sr = struct.unpack('<HHI', b[:8])
                bits = struct.unpack('<H', b[14:16])[0]
                fmt = (tag, ch, sr, bits)
            elif cid == b'data':
                data = (pos + 8, size)
                break
            pos += 8 + size + (size & 1)
        f.seek(0, 2)
        flen = f.tell()
    if not fmt or not data:
        raise UserError('Malformed WAV', 422)
    tag, ch, sr, bits = fmt
    if bits != 32 or tag not in (3, 0xFFFE):
        raise UserError('Expected 32-bit float WAV', 422)
    frames = min(data[1], flen - data[0]) // (4 * ch)
    if frames <= 0:
        return np.zeros((0, ch), np.float32), sr
    return np.memmap(path, dtype='<f4', mode='r', offset=data[0], shape=(frames, ch)), sr


class WavWriter:
    def __init__(self, path, ch, sr):
        self.f = open(path, 'wb')
        self.ch, self.sr, self.frames = ch, sr, 0
        self._header()

    def _header(self):
        n = self.frames * self.ch * 4
        self.f.write(b'RIFF' + struct.pack('<I', 36 + n) + b'WAVE' + b'fmt ' +
                     struct.pack('<IHHIIHH', 16, 3, self.ch, self.sr, self.sr * self.ch * 4, self.ch * 4, 32) +
                     b'data' + struct.pack('<I', n))

    def write(self, block):  # block: (frames, ch)
        if len(block):
            self.f.write(np.ascontiguousarray(block, dtype='<f4').tobytes())
            self.frames += len(block)

    def close(self):
        self.f.seek(0)
        self._header()
        self.f.close()


def block(x, a, b):
    """x[a:b] with zeros outside the file, as float32 (frames, ch)."""
    n, ch = x.shape
    out = np.zeros((b - a, ch), np.float32)
    s, e = max(a, 0), min(b, n)
    if e > s:
        out[s - a:e - a] = x[s:e]
    return out


# ── streaming STFT with weighted overlap-add ─────────────────────────────
def stft_stream(x, N, H, proc, write, batch=256):
    """Calls proc(spec (ch, B, F) complex, k0) for consecutive frame batches; writes the
    resynthesised signal (exactly len(x) frames). sqrt-Hann analysis and synthesis windows."""
    n, C = x.shape
    R = N // H
    win = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)).astype(np.float32)
    scale = np.float32(2.0 * H / N)
    K = (n - 1 + N - H) // H + 1
    carry = np.zeros((C, N - H), np.float32)
    written = 0
    for k0 in range(0, K, batch):
        k1 = min(K, k0 + batch)
        B = k1 - k0
        a = k0 * H - (N - H)
        L = B * H + N - H
        blk = block(x, a, a + L)
        frames = sliding_window_view(blk, N, axis=0)[::H][:B]  # (B, C, N)
        spec = np.fft.rfft(np.transpose(frames, (1, 0, 2)) * win, axis=-1)
        spec = proc(spec, k0)
        y = (np.fft.irfft(spec, n=N, axis=-1) * (win * scale)).astype(np.float32)  # (C, B, N)
        acc = np.zeros((C, L), np.float32)
        acc[:, :N - H] += carry
        y = y.reshape(C, B, R, H)
        for r in range(R):
            acc[:, r * H:r * H + B * H] += y[:, :, r, :].reshape(C, B * H)
        s, e = max(a, 0), min(a + B * H, n)
        if e > s:
            write(acc[:, s - a:e - a].T)
            written += e - s
        carry = acc[:, B * H:].copy()
    a = K * H - (N - H)
    s, e = max(a, written), n
    if e > s:
        write(carry[:, s - a:e - a].T)
        written += e - s
    assert written == n, (written, n)


# ── variable-rate windowed-sinc resampler ────────────────────────────────
KAISER_BETA = 8.0
_KT = np.i0(KAISER_BETA * np.sqrt(np.clip(1 - np.linspace(0, 1, 4097) ** 2, 0, None))) / np.i0(KAISER_BETA)


_TABLES = {}


def _sinc_table(fc, half, phases=512):
    """Kaiser-windowed sinc taps for every fractional phase: tab[q, j] = h(q/phases - (j - half + 1))."""
    key = (round(fc, 4), half)
    if key not in _TABLES:
        if len(_TABLES) > 64:
            _TABLES.clear()
        frac = np.arange(phases + 1)[:, None] / phases
        t = frac - np.arange(-half + 1, half + 1)[None, :]
        u = np.abs(t) / half
        w = np.interp(u, np.linspace(0, 1, 4097), _KT) * (u < 1)
        _TABLES[key] = (fc * np.sinc(fc * t) * w).astype(np.float32)
    return _TABLES[key]


def vresample(x, positions_fn, nout, write, gain_fn=None, chunk=8192, zeros=16):
    """out[k] = x(positions_fn(k)) read with a band-limited windowed sinc whose cutoff follows the
    local read rate (anti-aliased when reading faster than real time). Polyphase table per chunk."""
    n, C = x.shape
    phases = 512
    for k0 in range(0, nout, chunk):
        k = np.arange(k0, min(nout, k0 + chunk), dtype=np.float64)
        p = positions_fn(k)
        rate = float(np.abs(np.gradient(p)).max()) if len(p) > 1 else 1.0
        fc = min(1.0, 1.0 / max(rate, 1e-6))
        fc = math.floor(fc * 500) / 500 if fc < 1 else 1.0  # quantised so tables get reused
        half = int(math.ceil(zeros / max(fc, 0.05)))
        tab = _sinc_table(fc, half, phases)
        base = np.floor(p).astype(np.int64)
        fq = (p - base) * phases
        q = np.minimum(fq.astype(np.int64), phases - 1)
        r = (fq - q).astype(np.float32)[:, None]
        h = tab[q] * (1 - r) + tab[q + 1] * r  # (B, T)
        lo, hi = int(base.min()) - half + 1, int(base.max()) + half + 1
        src = block(x, lo, hi)  # (len, C)
        idx = (base - base.min())[:, None] + np.arange(2 * half)[None, :]
        y = np.stack([(h * src[:, c][idx]).sum(axis=1) for c in range(C)], axis=1)
        if gain_fn is not None:
            y *= gain_fn(k)[:, None].astype(np.float32)
        write(y)


def mono_energy_blocks(x, size):
    """Mean-square of the channel mix per block of `size` frames (streamed)."""
    n = len(x)
    out = []
    step = size * 256
    for a in range(0, n, step):
        b = min(n, a + step)
        m = np.asarray(x[a:b], np.float32).mean(axis=1)
        nb = (b - a) // size
        if nb:
            out.append((m[:nb * size].reshape(nb, size) ** 2).mean(axis=1))
        if (b - a) % size:
            out.append([float((m[nb * size:] ** 2).mean())])
    return np.concatenate(out) if out else np.zeros(0)


def bin_range(F, N, sr, lo_hz, hi_hz):
    f = np.arange(F) * sr / N
    return (f >= lo_hz) & (f <= hi_hz)


# ── 1. Center Channel Extractor ──────────────────────────────────────────
def center_extract(x, sr, write, mode, lo_hz, hi_hz, strength):
    if x.shape[1] != 2:
        raise UserError('centerExtract needs a stereo asset (this one is mono)')
    if hi_hz <= lo_hz:
        raise UserError('centerExtract needs highHz > lowHz')
    N, H = 4096, 1024
    F = N // 2 + 1
    band = bin_range(F, N, sr, lo_hz, hi_hz)

    def proc(spec, k0):
        L, R = spec[0], spec[1]
        pl, pr = (L.real ** 2 + L.imag ** 2), (R.real ** 2 + R.imag ** 2)
        # Per-bin similarity of magnitude AND phase: 2·Re(L·R*)/(|L|²+|R|²) is 1 for an identical
        # (centred) component, 0 when one side is silent (hard-panned), negative when out of phase.
        c = np.clip(2 * (L * np.conj(R)).real / (pl + pr + 1e-20), 0, 1)
        # Light smoothing across neighbouring bins against musical noise, then sharpen.
        c = (np.roll(c, 1, axis=-1) + 2 * c + np.roll(c, -1, axis=-1)) / 4
        m = c ** 2
        g = (1 - strength) + strength * m if mode == 0 else 1 - strength * m
        g = np.where(band[None, :], g, 1.0).astype(np.float32)
        return spec * g[None]

    stft_stream(x, N, H, proc, write)
    return {}


# ── 2. DeReverb (late-reverb spectral suppression, Lebart/Habets) ────────
def estimate_rt60(x, sr):
    """Fastest free decays in the file: Schroeder-integrated T20 fits after energy peaks."""
    hop = max(1, int(sr * 0.01))
    e = mono_energy_blocks(x, hop)
    if len(e) < 30:
        return None, 0
    db = 10 * np.log10(np.convolve(e, np.ones(5) / 5, mode='same') + 1e-12)
    floor = max(np.percentile(db, 10), -100.0)
    cands = []
    i = 1
    while i < len(db) - 10:
        if db[i] >= db[max(0, i - 5):i + 6].max() and db[i] > floor + 25:
            j, low = i + 1, db[i]
            while j < len(db) and db[j] < low + 5 and db[j] > floor + 3:
                low = min(low, db[j]); j += 1
            seg = e[i:j]
            if len(seg) >= 10 and db[i] - low >= 20:
                sch = np.cumsum(seg[::-1])[::-1]
                sdb = 10 * np.log10(sch / sch[0] + 1e-20)
                sel = (sdb <= -5) & (sdb >= -25)
                if sel.sum() >= 5:
                    t = np.arange(len(seg))[sel] * hop / sr
                    slope, icpt = np.polyfit(t, sdb[sel], 1)
                    fit = slope * t + icpt
                    r2 = 1 - ((sdb[sel] - fit) ** 2).sum() / (((sdb[sel] - sdb[sel].mean()) ** 2).sum() + 1e-12)
                    if slope < -1 and r2 > 0.9:
                        cands.append(-60.0 / slope)
            i = max(j, i + 1)
        else:
            i += 1
    if not cands:
        return None, 0
    # Real decays can only be as fast as the room allows: favour the fastest ones.
    return float(np.clip(np.percentile(cands, 25), 0.1, 10.0)), len(cands)


def dereverb(x, sr, write, amount, rt60):
    report = {}
    if rt60 <= 0:
        est, count = estimate_rt60(x, sr)
        report['decaysFound'] = count
        rt60 = est if est else 0.8
        report['rt60Estimated' if est else 'rt60Assumed'] = round(rt60, 3)
    report['rt60'] = round(rt60, 3)
    N, H = 1024, 256
    F = N // 2 + 1
    delta = 3 * math.log(10) / rt60            # amplitude decay rate (1/s)
    Nl = max(1, int(round(0.05 * sr / H)))     # late reverb starts ~50 ms after the direct sound
    decay = math.exp(-2 * delta * Nl * H / sr)
    alpha = math.exp(-H / (0.012 * sr))        # PSD smoothing (~12 ms)
    k = 1.0 + 3.0 * amount                     # over-subtraction: the tail PSD fluctuates per bin
    gmin = 10 ** (-amount * 30 / 20)
    state = {'zi': np.zeros((1, F)), 'hist': np.zeros((Nl, F)), 'g': np.ones(F)}

    def proc(spec, k0):
        P = (spec.real ** 2 + spec.imag ** 2).mean(axis=0)  # (B, F)
        Ps, state['zi'] = lfilter([1 - alpha], [1, -alpha], P, axis=0, zi=state['zi'] * 1.0)
        allp = np.concatenate([state['hist'], Ps], axis=0)
        lam = decay * allp[:len(Ps)]                         # Ps(m - Nl)
        state['hist'] = allp[-Nl:]
        g = np.maximum(1 - k * lam / (Ps + 1e-20), gmin)
        # Fast attack, slower release of the suppression → fewer chirps in the tail.
        out = np.empty_like(g)
        prev = state['g']
        for b in range(len(g)):
            prev = np.where(g[b] > prev, g[b], 0.6 * prev + 0.4 * g[b])
            out[b] = prev
        state['g'] = prev
        return spec * out[None].astype(np.float32)

    stft_stream(x, N, H, proc, write)
    return report


# ── 3. Sound Remover (semi-supervised NMF) ───────────────────────────────
def mag_frames(x, a, b, N, H):
    seg = block(x, a, b)
    if len(seg) < N:
        seg = np.concatenate([seg, np.zeros((N - len(seg), seg.shape[1]), np.float32)])
    win = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N) / N)).astype(np.float32)
    fr = sliding_window_view(seg, N, axis=0)[::H]  # (T, C, N)
    return np.abs(np.fft.rfft(fr * win, axis=-1)).mean(axis=1).T  # (F, T)


def kl_nmf(V, W, Hm, iters, n_fixed, wcol=None):
    """KL-divergence NMF. The first n_fixed columns of W stay fixed; the free ones are updated
    with per-frame weights wcol (frames that look like the unwanted sound don't teach them)."""
    eps = 1e-12
    for _ in range(iters):
        WH = W @ Hm + eps
        Hm *= (W.T @ (V / WH)) / (W.sum(axis=0)[:, None] + eps)
        if n_fixed < W.shape[1]:
            WH = W @ Hm + eps
            Hf = Hm[n_fixed:] if wcol is None else Hm[n_fixed:] * wcol[None, :]
            Wf = W[:, n_fixed:]
            Wf *= ((V / WH) @ Hf.T) / (Hf.sum(axis=1)[None, :] + eps)
            s = Wf.sum(axis=0) + eps
            Wf /= s
            Hm[n_fixed:] *= s[:, None]
    return W, Hm


def sound_remove(x, sr, write, strength, sensitivity, learn_start, learn_end, offset):
    n = len(x)
    a, b = int(round((learn_start - offset) * sr)), int(round((learn_end - offset) * sr))
    if learn_end - learn_start < 0.1:
        raise UserError('soundRemove needs learnStart/learnEnd spanning at least 0.1 s of the unwanted sound')
    if a < 0 or b > n + int(0.01 * sr):
        raise UserError(f'The learn span {learn_start:.2f}–{learn_end:.2f} s lies outside the processed audio '
                        f'({offset:.2f}–{offset + n / sr:.2f} s); process the whole file or include the span')
    N, H = 2048, 512
    rng = np.random.default_rng(1)
    # Sound model: a few spectral bases learned from the span (pick a clean example of the sound).
    V = mag_frames(x, a, min(b, n), N, H).astype(np.float64)
    if V.sum() < 1e-6:
        raise UserError('The learn span is silent', 422)
    Ks = int(np.clip(V.shape[1] // 3, 2, 8))
    Ws = rng.random((V.shape[0], Ks)) + 0.1
    Ws /= Ws.sum(axis=0)
    Ws, _ = kl_nmf(V, Ws, rng.random((Ks, V.shape[1])) * V.mean() + 1e-9, 200, 0)
    Kb = 24
    thr = 0.55 - 0.45 * sensitivity
    state = {'Wb': None}
    stats = {'detected': 0}

    def detect(S, Bk):
        # How much of each frame the sound model explains → detection (sensitivity sets the bar).
        share = S.sum(axis=0) / (S.sum(axis=0) + Bk.sum(axis=0) + 1e-12)
        d = np.clip((share - thr) / 0.15, 0, 1)
        if len(d) > 4:
            p = np.pad(d, 2, mode='edge')
            d = np.max(np.stack([p[i:i + len(d)] for i in range(5)]), axis=0)
        return d

    def proc(spec, k0):
        Vb = np.abs(spec).mean(axis=0).T.astype(np.float64)  # (F, B)
        if state['Wb'] is None:
            Wb = rng.random((Vb.shape[0], Kb)) + 0.1
            state['Wb'] = Wb / Wb.sum(axis=0)
        W = np.concatenate([Ws, state['Wb']], axis=1)
        Hm = rng.random((W.shape[1], Vb.shape[1])) * Vb.mean() + 1e-9
        # Free "everything else" bases adapt to the programme material, but only on frames that
        # don't look like the sound — otherwise they would learn the sound too.
        Hm = kl_nmf(Vb, W, Hm, 20, W.shape[1])[1]
        for _ in range(4):
            d = detect(Ws @ Hm[:Ks], W[:, Ks:] @ Hm[Ks:])
            W, Hm = kl_nmf(Vb, W, Hm, 12, Ks, wcol=1 - d)
        state['Wb'] = W[:, Ks:].copy()
        S, Bk = Ws @ Hm[:Ks], W[:, Ks:] @ Hm[Ks:]
        d = detect(S, Bk)
        M = S ** 2 / (S ** 2 + Bk ** 2 + 1e-20)               # Wiener mask of the sound
        g = 1 - strength * M * d[None, :]
        stats['detected'] += int((d > 0.5).sum())
        return spec * g.T[None].astype(np.float32)

    stft_stream(x, N, H, proc, write, batch=192)
    return {'components': Ks, 'detectedSeconds': round(stats['detected'] * H / sr, 2)}


# ── 4. Automatic Phase Correction ────────────────────────────────────────
def phase_align(x, sr, write, max_ms, centre):
    if x.shape[1] != 2:
        raise UserError('phaseAlign needs a stereo asset (this one is mono)')
    n = len(x)
    maxlag = max(1, int(round(max_ms * sr / 1000)))
    blen = int(sr)
    e = mono_energy_blocks(x, blen)
    picks = np.argsort(e)[::-1][:40]
    nfft = 1 << int(math.ceil(math.log2(blen + maxlag + 1)))
    acc = np.zeros(nfft)
    el = er = 0.0
    for p in picks:
        seg = block(x, int(p) * blen, int(p) * blen + blen).astype(np.float64)
        Lf, Rf = np.fft.rfft(seg[:, 0], nfft), np.fft.rfft(seg[:, 1], nfft)
        acc += np.fft.irfft(np.conj(Lf) * Rf, nfft)  # acc[d] = Σ L[t]·R[t+d]
        el += (seg[:, 0] ** 2).sum(); er += (seg[:, 1] ** 2).sum()
    norm = math.sqrt(el * er) + 1e-20
    lags = np.arange(-maxlag, maxlag + 1)
    c = acc[lags % nfft] / norm
    i = int(np.argmax(c))
    d = float(lags[i])
    if 0 < i < len(c) - 1:
        y0, y1, y2 = c[i - 1], c[i], c[i + 1]
        den = y0 - 2 * y1 + y2
        if den < 0:
            d += 0.5 * (y0 - y2) / den
    before = float(acc[0] / norm)
    # R lags L by d samples → read R d samples later (or move both halfway).
    sl, srr = (-d / 2, d / 2) if centre else (0.0, d)
    stats = {'lr': 0.0, 'll': 0.0, 'rr': 0.0}
    xl, xr = x[:, :1], x[:, 1:]
    chunk = 1 << 16
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        outs = []
        for ch, sh in ((xl, sl), (xr, srr)):
            if abs(sh) < 1e-9:
                outs.append(np.asarray(ch[a:b], np.float32))
            else:
                res = []
                vresample(ch, lambda k, a=a, sh=sh: k + a + sh, b - a, res.append, chunk=b - a)
                outs.append(np.concatenate(res))
        y = np.concatenate(outs, axis=1)
        stats['lr'] += float((y[:, 0].astype(np.float64) * y[:, 1]).sum())
        stats['ll'] += float((y[:, 0].astype(np.float64) ** 2).sum())
        stats['rr'] += float((y[:, 1].astype(np.float64) ** 2).sum())
        write(y)
    after = stats['lr'] / (math.sqrt(stats['ll'] * stats['rr']) + 1e-20)
    return {'offsetMs': round(d / sr * 1000, 4), 'offsetSamples': round(d, 3), 'correlationBefore': round(before, 4),
            'correlationAfter': round(after, 4), 'aligned': 'both to the middle' if centre else 'right to left'}


# ── 5. Doppler Shifter ───────────────────────────────────────────────────
def doppler(x, sr, write, speed, distance, pass_time, volume_change):
    n = len(x)
    c = 343.0
    v = min(speed, 0.9 * c)
    d = max(distance, 0.1)
    t0 = n / sr / 2 if pass_time < 0 else pass_time

    def emit_u(k):
        T = k / sr - t0
        return (c * c * T - np.sqrt(c * c * v * v * T * T + (c * c - v * v) * d * d)) / (c * c - v * v)

    def pos(k):
        # Received at t was emitted at t0+u; shift by the closest-approach delay so the pass stays at t0.
        return (t0 + emit_u(k) + d / c) * sr

    def gain(k):
        u = emit_u(k)
        return d / np.sqrt(d * d + v * v * u * u)

    vresample(x, pos, n, write, gain if volume_change else None)
    return {'passTime': round(t0, 3), 'pitchApproachSemitones': round(12 * math.log2(c / (c - v)), 3),
            'pitchRecedeSemitones': round(12 * math.log2(c / (c + v)), 3)}


# ── 6. Pitch Bender (tape varispeed) ─────────────────────────────────────
def pitch_bend(x, sr, write, st0, st1, curve):
    n = len(x)
    if n < 2:
        raise UserError('Asset too short to bend', 422)
    G = 64
    pg = np.arange(0, n + G, G, dtype=np.float64)
    pg[-1] = n
    f = (pg[:-1] + pg[1:]) / 2 / n
    shape = f if curve == 0 else f * f if curve == 1 else 1 - (1 - f) ** 2
    rate = 2.0 ** ((st0 + (st1 - st0) * shape) / 12)
    tg = np.concatenate([[0.0], np.cumsum(np.diff(pg) / rate)])
    nout = int(math.floor(tg[-1]))
    if nout > 6 * 3600 * sr:
        raise UserError('Result would be longer than 6 hours', 422)
    vresample(x, lambda k: np.interp(k, tg, pg), nout, write)
    return {'inputSeconds': round(n / sr, 4), 'outputSeconds': round(nout / sr, 4), 'lengthRatio': round(nout / n, 5)}


def main():
    kind, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    a = [float(v) for v in sys.argv[4:]]
    x, sr = read_wav(src)
    if len(x) == 0:
        raise UserError('Asset is empty', 422)
    w = WavWriter(dst, x.shape[1], sr)
    try:
        if kind == 'centerExtract':
            r = center_extract(x, sr, w.write, int(a[0]), a[1], a[2], a[3])
        elif kind == 'dereverb':
            r = dereverb(x, sr, w.write, a[0], a[1])
        elif kind == 'soundRemove':
            r = sound_remove(x, sr, w.write, a[0], a[1], a[2], a[3], a[4] if len(a) > 4 else 0.0)
        elif kind == 'phaseAlign':
            r = phase_align(x, sr, w.write, a[0], int(a[1]))
        elif kind == 'doppler':
            r = doppler(x, sr, w.write, a[0], a[1], a[2], int(a[3]))
        elif kind == 'pitchBend':
            r = pitch_bend(x, sr, w.write, a[0], a[1], int(a[2]))
        else:
            raise UserError(f'unknown kind {kind}')
    finally:
        w.close()
    print(json.dumps(r))


if __name__ == '__main__':
    try:
        main()
    except UserError as e:
        sys.stderr.write(f'\nKLANG_ERROR {e.status} {e}\n')
        sys.exit(3)
