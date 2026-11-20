"""faster-whisper 转写：输出词级时间戳。"""
import argparse, json, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='small')
    ap.add_argument('--language', default='zh')
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--hotwords', default='', help='术语表热词，注入 initial_prompt')
    args = ap.parse_args()

    try:
        from opencc import OpenCC
        cc = OpenCC('t2s')
    except Exception:
        cc = None

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type='int8', cpu_threads=args.threads)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={'min_silence_duration_ms': 300},
        condition_on_previous_text=False,
        initial_prompt=(args.hotwords or None),
    )
    words, segs = [], []
    for seg in segments:
        st = seg.text.strip()
        if cc:
            st = cc.convert(st)
        segs.append({'start': float(seg.start), 'end': float(seg.end), 'text': st})
        for w in (seg.words or []):
            t = (w.word or '').strip()
            if t:
                if cc:
                    t = cc.convert(t)
                words.append({'w': t, 'start': float(w.start), 'end': float(w.end), 'p': round(float(getattr(w, 'probability', 1.0)), 3)})
    out = {'language': info.language, 'duration': float(info.duration), 'words': words, 'segments': segs}
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(json.dumps({'words': len(words), 'segments': len(segs), 'language': info.language}))

if __name__ == '__main__':
    main()
