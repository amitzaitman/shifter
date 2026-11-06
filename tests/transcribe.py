"""Transcribe the driver's narration in a recording (Hebrew) with Whisper, on the recording clock.

    python3 tests/transcribe.py data/drive-20261105-0815.json [--model large-v3] [--lang he] [--from S --to S] [--no-prompt]

Writes data/drive-…narration.json next to the recording:
    {"model": …, "segments": [{"t0": s, "t1": s, "text": "…", "ok": bool, "words": [[t0, "word", t1], …]}, …]}
and prints the transcript with times (m:ss on the recording clock). Reading it, write the labels next to the
recording as data/drive-….labels.json = [[t, 'smooth'|'ok'|'harsh'|'none', 'up'|'down'|'launch', 'what was said'], …].
evaluate.js and dataset.js pick up both files by themselves: the spoken segments are masked from the rpm (the voice
sits in the same band as the engine), and the labels count as truth (said right after a change, like a passenger tap).

--no-prompt: transcribe without the domain prompt. The prompt helps, but can also put its own words in ('קפץ', 'חלק')
where the speech is unclear; check doubtful moments both ways (with --from/--to).

Needs: pip install faster-whisper, and ffmpeg. The model downloads on first use (large-v3 is ~3 GB; small ~0.5 GB).
"""
import base64, json, os, subprocess, sys, tempfile
import numpy as np

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

def NOISE_LINE(text):
    t = ''.join(ch for ch in text if ch.isalnum() or ch == ' ').strip()
    return t in ('תודה רבה', 'תודה', 'תודה רבה לכם') or 'כתוביות' in t

def main():
    files = [a for a in sys.argv[1:] if a.endswith('.json') and not a.endswith('.narration.json')]
    if not files:
        print(__doc__); sys.exit(1)
    model_name, lang = arg('--model', 'large-v3'), arg('--lang', 'he')
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device='cpu', compute_type='int8')
    for path in files:
        rec = json.load(open(path, encoding='utf-8'))
        segs = rec['audio'].get('segments') or [{'t0': 0, 'base64': rec['audio']['base64']}]
        out = []
        with tempfile.TemporaryDirectory() as d:
            for i, sg in enumerate(segs):
                src = os.path.join(d, f'seg{i}.m4a')
                open(src, 'wb').write(base64.b64decode(sg['base64']))
                # decode with ffmpeg ourselves (faster-whisper's own decoder breaks with some PyAV versions)
                raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', src, '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], check=True, capture_output=True).stdout
                audio = np.frombuffer(raw, dtype=np.float32)
                # optional slice (seconds on the recording clock), for quick tests
                t0s = sg.get('t0') or 0
                a0 = max(0.0, float(arg('--from', 0)) - t0s); a1 = float(arg('--to', 1e9)) - t0s
                if a1 <= 0 or a0 * 16000 >= len(audio): continue
                audio = audio[int(a0 * 16000):int(min(a1 * 16000, len(audio)))]
                # voice activity filter on: long stretches of engine noise produce no text. Short silences split the
                # speech (the default 2 s merged remarks a minute apart into one segment, with word times smeared
                # across the gap), and each piece is transcribed on its own (no carry-over of the previous text).
                pieces, _ = model.transcribe(audio, language=lang, vad_filter=True, word_timestamps=True,
                                             vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=200, max_speech_duration_s=12),
                                             condition_on_previous_text=False,
                                             initial_prompt=None if '--no-prompt' in sys.argv else 'העברתי הילוך. הורדתי לשני. היה חלק. קפץ. טלטלה. יוצא מהרמזור.')
                for p in pieces:
                    t0 = t0s + a0
                    # Whisper's own confidence; used to drop hallucinations (repeated lines, 'speech' over engine noise)
                    # (no length rule: VAD-joined remarks a minute apart make long, sparse segments that are real speech;
                    #  the rpm mask works on the words, so a wrong long segment costs little)
                    ok = p.no_speech_prob < 0.6 and p.avg_logprob > -1.0 and p.compression_ratio < 2.4
                    # what Whisper writes over engine noise in Hebrew (6.11 drive, no speech at all: 'תודה רבה' ×12, 'כתוביות')
                    if NOISE_LINE(p.text): ok = False
                    out.append({'t0': round(t0 + p.start, 2), 't1': round(t0 + p.end, 2), 'text': p.text.strip(), 'ok': bool(ok),
                                'logprob': round(p.avg_logprob, 2), 'noSpeech': round(p.no_speech_prob, 2), 'cr': round(p.compression_ratio, 2),
                                'words': [[round(t0 + w.start, 2), w.word.strip(), round(t0 + w.end, 2)] for w in (p.words or [])]})
        # Whisper's other hallucination: the same short line repeated; keep the first, drop the repeats
        norm = lambda t: ''.join(ch for ch in t if ch.isalnum())
        for i in range(1, len(out)):
            if norm(out[i]['text']) and norm(out[i]['text']) == norm(out[i - 1]['text']): out[i]['ok'] = False
        dst = path[:-5] + ('.narration.json' if not arg('--from') and not arg('--to') else f'.narration-{arg("--from", 0)}-{arg("--to", "end")}.json')
        json.dump({'model': model_name, 'lang': lang, 'segments': out}, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'\n{os.path.basename(path)}  ({rec.get("mode", "drive")}, {len(out)} segments) → {os.path.basename(dst)}')
        for s in out:
            print(f'  {int(s["t0"] // 60)}:{int(s["t0"] % 60):02d}  {"  " if s["ok"] else "? "}{s["text"]}')
        print(f'  ({sum(1 for s in out if s["ok"])} of {len(out)} segments look like real speech; "?" = dropped as a likely hallucination)')

if __name__ == '__main__':
    main()
