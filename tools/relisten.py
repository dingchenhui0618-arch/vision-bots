"""听音复核：把一个短音频窗口交给指定模型重听，输出词级时间戳。

和 asr.py 的区别是「用途」：asr.py 转写整条素材，这里只重听 3–8 秒的一小段，
所以默认关掉 VAD（窗口已经很紧，VAD 会把 0.3s 的短音当成气口丢掉），
并且允许指定 compute_type（int8 / float32），用来做两次独立的听。
"""
import argparse, json


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default='medium')
    ap.add_argument('--compute', default='int8')
    ap.add_argument('--language', default='zh')
    ap.add_argument('--threads', type=int, default=4)
    ap.add_argument('--beam', type=int, default=5)
    ap.add_argument('--vad', action='store_true')
    ap.add_argument('--hotwords', default='', help='术语表热词：和主转写用同一串，免得重听把 GPT 写成 GDP')
    args = ap.parse_args()

    try:
        from opencc import OpenCC
        cc = OpenCC('t2s').convert
    except Exception:
        cc = lambda s: s

    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device='cpu', compute_type=args.compute, cpu_threads=args.threads)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=args.vad,
        vad_parameters={'min_silence_duration_ms': 300},
        condition_on_previous_text=False,
        beam_size=args.beam,
        initial_prompt=(args.hotwords or None),
    )
    words, segs = [], []
    for seg in segments:
        segs.append({'start': float(seg.start), 'end': float(seg.end), 'text': cc(seg.text.strip())})
        for w in (seg.words or []):
            t = cc((w.word or '').strip())
            if t:
                words.append({
                    'w': t,
                    'start': float(w.start),
                    'end': float(w.end),
                    'p': round(float(getattr(w, 'probability', 1.0)), 3),
                })
    with open(args.out, 'w', encoding='utf-8') as f:
        json.dump({'model': args.model, 'compute': args.compute, 'duration': float(info.duration),
                   'words': words, 'segments': segs}, f, ensure_ascii=False, indent=1)
    print(json.dumps({'words': len(words), 'segments': len(segs)}))


if __name__ == '__main__':
    main()
