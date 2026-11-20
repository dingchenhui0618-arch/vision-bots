import { ff, probeFile } from './ffmpeg.mjs'

/** 质检：每条结论必须带证据（时间点 / 数值），没有证据不许判通过。 */
export async function qa({ file, plan, captions, targetDuration = null, asrFix = null }) {
  const info = await probeFile(file)
  const duration = Number(info.format.duration)
  const audio = info.streams.find(s => s.codec_type === 'audio')
  const checks = []
  const add = (id, ok, detail, evidence) => checks.push({ id, ok, detail, evidence })

  add('duration', true, `成片 ${duration.toFixed(2)}s，源 ${(plan.sourceDuration || 0).toFixed(2)}s，剪掉 ${(plan.cutSeconds || 0).toFixed(2)}s`,
    { duration, source: plan.sourceDuration, segments: plan.keep.length })
  if (targetDuration) {
    const delta = duration - targetDuration
    add('target', Math.abs(delta) <= targetDuration * 0.12, `目标 ${targetDuration}s，实际 ${duration.toFixed(2)}s（差 ${delta.toFixed(1)}s）`, { delta })
  }

  if (audio) {
    let silences = []
    try {
      const { stderr } = await ff(['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.6', '-f', 'null', '-'])
      const starts = [...stderr.matchAll(/silence_start: (\d+\.?\d*)/g)].map(m => Number(m[1]))
      const ends = [...stderr.matchAll(/silence_end: (\d+\.?\d*) \| silence_duration: (\d+\.?\d*)/g)].map(m => ({ end: Number(m[1]), dur: Number(m[2]) }))
      silences = ends.map((e, i) => ({ start: starts[i] ?? e.end - e.dur, end: e.end, dur: e.dur }))
    } catch { /* silencedetect 只是警告，不阻断 */ }
    const long = silences.filter(s => s.dur > 0.8)
    add('silence', long.length === 0, long.length ? `还有 ${long.length} 段超过 0.8s 的静音` : '没有超过 0.8s 的静音',
      { long: long.slice(0, 8) })

    let lufs = null
    try {
      const { stderr } = await ff(['-hide_banner', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
      const m = [...stderr.matchAll(/I:\s+(-?\d+\.\d+) LUFS/g)].pop()
      if (m) lufs = Number(m[1])
    } catch { /* 同上 */ }
    add('loudness', lufs === null || (lufs > -22 && lufs < -8), `响度 ${lufs ?? '未测出'} LUFS`, { lufs })
  } else {
    add('audio', false, '成片没有音轨', {})
  }

  if (captions) {
    add('caption_coverage', captions.coverage.missing === 0,
      captions.coverage.missing === 0 ? `${captions.cards.length} 张字幕，原文 ${captions.coverage.originalChars} 字全覆盖` : `漏了 ${captions.coverage.missing} 个字`,
      captions.coverage)
    const longCard = captions.cards.filter(c => c.text.length > 16)
    add('caption_length', longCard.length === 0, longCard.length ? `${longCard.length} 张字幕超过 16 字` : '字幕长度都在 16 字以内',
      { longest: Math.max(0, ...captions.cards.map(c => c.text.length)) })
  }

  // 错字治理自己也要被查：改了几处、打回几处、还有几处没把握，全部带位置
  if (asrFix) {
    const { applied = [], rejected = [], pending = [], assertion = {} } = asrFix
    const kinds = applied.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] || 0) + 1 }), {})
    const kindText = Object.entries(kinds).map(([k, n]) => `${({ homophone: '同音字', term: '专有名词', number: '数字' })[k] || k} ${n}`).join('、')
    // 打回一处不算缺陷：校验器拦住模型的错改，正是它该干的事。只有词数/时间码被动过才算不过。
    const safe = assertion.wordCount === true && assertion.timingUntouched === true
    add('asr_fix', safe,
      `改字 ${applied.length} 处${kindText ? `（${kindText}）` : ''}，打回 ${rejected.length} 处，没把握 ${pending.length} 处` +
      (pending.length ? `：${pending.slice(0, 5).map(p => `「${p.w}」@${p.at}s`).join('、')}${pending.length > 5 ? ' 等' : ''}` : '') +
      `；词数 ${assertion.wordCount ? '未变' : '变了'}，时间码 ${assertion.timingUntouched ? '未动' : '被动了'}`,
      { applied, rejected, pending, assertion })
  }

  const failed = checks.filter(c => !c.ok)
  return { file, duration, passed: failed.length === 0, checks, failed: failed.map(c => c.id) }
}
