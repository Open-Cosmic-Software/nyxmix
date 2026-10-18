"""VST3 hosting helper for NyxMix (pedalboard/JUCE). One plugin file per process, so a
crashing plugin only takes this process down.

  vst3.py names <bundle.vst3>                      -> JSON list of plugin names in the file
  vst3.py scan <bundle.vst3> <name>                -> JSON description, or exit 1 with the reason
  vst3.py run <bundle> <name> <params.json> <in.wav> <out.wav>
"""
import json, sys
import numpy as np
import pedalboard
from pedalboard.io import AudioFile

HOST_PARAMS = {'buffer_size_frames', 'sample_rate_frames', 'current_program', 'bypass'}


def process(p, x, sr):
    """Stereo x through p: natively if the plugin takes stereo, else dual mono."""
    try:
        return p(x, sr), 2
    except ValueError:
        p.reset()
        return np.vstack([p(x[c:c + 1], sr, reset=True) for c in range(x.shape[0])]), 1


def latency(p, sr):
    """Delay the plugin adds with these settings (look-ahead, linear phase), measured with
    a quiet impulse, since many plugins do not report it (or report it wrongly)."""
    at, n = int(sr * 0.1), int(sr * 1.2)
    imp = np.zeros((2, n), dtype=np.float32)
    imp[:, at] = 0.05
    y, _ = process(p, imp, sr)
    p.reset()
    a = np.abs(y).max(axis=0)
    if not a.max() > 1e-7:
        return 0
    i = int(np.argmax(a >= 0.5 * a.max()))
    return max(0, min(int(sr * 0.9), i - at))


def describe(p):
    params = []
    for key, v in p.parameters.items():
        if key in HOST_PARAMS:
            continue
        d = {'symbol': key, 'name': v.name, 'unit': (v.label or '').strip() or None}
        if v.type is float:
            if v.min_value is None or v.max_value is None:
                continue
            fin = lambda z: max(-1e9, min(1e9, float(z)))
            d.update(min=fin(v.min_value), max=fin(v.max_value), default=fin(getattr(p, key)))
        elif v.type is bool:
            d.update(toggle=True, min=0, max=1, default=int(bool(getattr(p, key))))
        else:
            vals = [str(x) for x in (v.valid_values or [])]
            if not vals:
                continue
            d.update(enum=vals, default=str(getattr(p, key)))
        params.append(d)
    return params


def names(path):
    print(json.dumps(pedalboard.VST3Plugin.get_plugin_names_for_file(path)))


def scan(path, name):
    p = pedalboard.load_plugin(path, plugin_name=name)
    if not p.is_effect:
        raise SystemExit('not an effect')
    # Test-run: stereo tone + noise must come back finite and not silent.
    t = np.arange(24000) / 48000
    x = np.stack([0.25 * np.sin(2 * np.pi * 440 * t), 0.25 * np.sin(2 * np.pi * 660 * t)]).astype(np.float32)
    x += (np.random.default_rng(1).random(x.shape, dtype=np.float32) - 0.5) * 0.1
    y, ch = process(p, x, 48000)
    if not np.all(np.isfinite(y)):
        raise SystemExit('non-finite output')
    if np.sqrt(np.mean(y ** 2)) < 1e-5:
        raise SystemExit('silent with default settings')
    print(json.dumps({'name': name, 'params': describe(p), 'channels': ch, 'latency': int(getattr(p, 'reported_latency_samples', 0) or 0)}))


def run(path, name, params_file, src, dest):
    p = pedalboard.load_plugin(path, plugin_name=name)
    with open(params_file) as f:
        for k, v in json.load(f).items():
            setattr(p, k, v)
    with AudioFile(src) as f:
        sr, x = f.samplerate, f.read(f.frames)
    mono = x.shape[0] == 1
    x2 = np.vstack([x, x]) if mono else x
    lat = latency(p, sr)
    if lat:
        x2 = np.hstack([x2, np.zeros((x2.shape[0], lat), dtype=x2.dtype)])
    y, _ = process(p, x2, sr)
    y = y[:, lat:]
    if mono:
        y = y.mean(axis=0, keepdims=True)
    if not np.all(np.isfinite(y)):
        raise SystemExit('plugin produced invalid (NaN/infinite) samples with these settings')
    y = y[:, :x.shape[1]]
    with AudioFile(dest, 'w', sr, y.shape[0], bit_depth=32) as f:
        f.write(y.astype(np.float32))


if __name__ == '__main__':
    if sys.argv[1] == 'names':
        names(sys.argv[2])
    elif sys.argv[1] == 'scan':
        scan(sys.argv[2], sys.argv[3])
    else:
        run(*sys.argv[2:7])
