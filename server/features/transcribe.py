#!/usr/bin/env python3
"""Word-level transcription for NyxMix (faster-whisper, CPU).

Usage: transcribe.py <audio-path> [--model small] [--language de] [--threads N]
stdout: one JSON document {language, languageProbability, duration, model, segments:[{start,end,text,words:[{start,end,word,probability}]}]}
stderr: progress lines, each a JSON object prefixed with "@@" (stage: loading|transcribing, progress 0..1).
"""
import argparse
import json
import os
import sys
import time


def progress(**kw):
    sys.stderr.write("@@" + json.dumps(kw) + "\n")
    sys.stderr.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default=os.environ.get("KLANG_WHISPER_MODEL", "small"))
    ap.add_argument("--language", default=None)
    ap.add_argument("--threads", type=int, default=0)
    args = ap.parse_args()

    progress(stage="loading", model=args.model)
    from faster_whisper import WhisperModel

    threads = args.threads or max(1, (os.cpu_count() or 4) - 1)
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=threads)

    progress(stage="transcribing", progress=0)
    segments, info = model.transcribe(
        args.audio,
        language=args.language or None,
        vad_filter=True,
        word_timestamps=True,
        beam_size=5,
        # Keep disfluencies ("um", "uh") instead of letting the model tidy them away.
        initial_prompt="Um, uh, so, like, you know, I mean... Ähm, also, äh.",
        condition_on_previous_text=False,
    )
    total = info.duration or 0
    out = []
    last = 0.0
    for s in segments:
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word, "probability": round(w.probability, 3)}
            for w in (s.words or [])
        ]
        out.append({"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip(), "words": words})
        now = time.monotonic()
        if total and now - last > 0.5:
            last = now
            progress(stage="transcribing", progress=round(min(1.0, s.end / total), 3))

    json.dump({
        "language": info.language,
        "languageProbability": round(info.language_probability or 0, 3),
        "duration": round(total, 3),
        "model": args.model,
        "segments": out,
    }, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
