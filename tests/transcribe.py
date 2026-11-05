"""Transcribe the driver's narration in a recording (Hebrew) with Whisper, on the recording clock.

    python3 tests/transcribe.py data/drive-20261105-0815.json [--model large-v3] [--lang he]

Writes data/drive-…narration.json next to the recording:
    {"model": …, "segments": [{"t0": s, "t1": s, "text": "…", "words": [[t, "word"], …]}, …]}
and prints the transcript with times (m:ss on the recording clock). Reading it, write the labels next to the
recording as data/drive-….labels.json = [[t, 'smooth'|'ok'|'harsh'|'none', 'up'|'down'|'launch', 'what was said'], …].
evaluate.js and dataset.js pick up both files by themselves: the spoken segments are masked from the rpm (the voice
sits in the same band as the engine), and the labels count as truth (said right after a change, like a passenger tap).

Needs: pip install faster-whisper, and ffmpeg. The model downloads on first use (large-v3 is ~3 GB; small ~0.5 GB).
"""
import base64, json, os, subprocess, sys, tempfile
import numpy as np

def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default

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
                # voice activity filter on: long stretches of engine noise produce no text
                pieces, _ = model.transcribe(audio, language=lang, vad_filter=True, word_timestamps=True,
                                             initial_prompt='העברתי הילוך. הורדתי לשני. היה חלק. קפץ. טלטלה. יוצא מהרמזור.')
                for p in pieces:
                    t0 = (sg.get('t0') or 0)
                    out.append({'t0': round(t0 + p.start, 2), 't1': round(t0 + p.end, 2), 'text': p.text.strip(),
                                'words': [[round(t0 + w.start, 2), w.word.strip()] for w in (p.words or [])]})
        dst = path[:-5] + '.narration.json'
        json.dump({'model': model_name, 'lang': lang, 'segments': out}, open(dst, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        print(f'\n{os.path.basename(path)}  ({rec.get("mode", "drive")}, {len(out)} segments) → {os.path.basename(dst)}')
        for s in out:
            print(f'  {int(s["t0"] // 60)}:{int(s["t0"] % 60):02d}  {s["text"]}')

if __name__ == '__main__':
    main()
