/**
 * 光轨 · scene.json —— 全部数字由词级时间戳和 EDL 确定性推导，模型不参与。
 * 这一层只做数据，不碰画布：film.js 读它，渲染器换掉不影响内容。
 */
import { makeMapper } from '../../src/plan.mjs'
import { mergeSentences, CHAPTER_MAX } from '../../src/chapters.mjs'
import { segment } from '../../src/segment.mjs'

const round = (n, k = 3) => Number(n.toFixed(k))

/** 成片时间 t → 源时间 s（EDL 是唯一真相） */
export function sourceAt(plan, t) {
  const { keep, options } = plan
  let acc = 0
  for (const [a, b] of keep) {
    const d = (b - a) / options.speed
    if (t <= acc + d) return a + (t - acc) * options.speed
    acc += d
  }
  return keep.at(-1)[1]
}

/** 每条保留段在成片里的位置；抽帧按它切，帧号才对得上。 */
export function frameRanges(plan, fps) {
  const { keep, options } = plan
  const ranges = []
  let outF = 0
  let srcF = 0
  for (const [a, b] of keep) {
    const outCount = Math.max(1, Math.round(((b - a) / options.speed) * fps))
    const srcCount = Math.max(1, Math.round((b - a) * fps))
    ranges.push({ outF0: outF, outF1: outF + outCount, srcF0: srcF, srcCount, speed: options.speed, srcSec: a, durSec: b - a })
    outF += outCount
    srcF += srcCount
  }
  return ranges
}

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu

export function buildScene({ words, segments, plan, brief = {}, tpl, cards = [], ratio = null }) {
  const t = tpl
  const fps = t.spec.fps
  // 画幅：brief 说的优先，模板不认就退回模板自己的默认画幅（不静默改尺寸）
  const layouts = t.layouts || {}
  const RATIO = (ratio && layouts[ratio]) ? ratio : (layouts[t.ratio] ? t.ratio : (Object.keys(layouts)[0] || '3:4'))
  const L = layouts[RATIO] || { size: [t.spec.width || 1080, t.spec.height || 1440] }
  const map = makeMapper(plan)
  const ranges = frameRanges(plan, fps)
  const totalFrames = ranges.reduce((n, r) => n + (r.outF1 - r.outF0), 0)
  const duration = totalFrames / fps

  // ── 卡片：需要逐字的落点（大字按音节落下），所以从词重新排一遍 ──
  const beats = (cards.length ? cards : []).map(c => ({
    text: c.text,
    f0: round(c.start),
    f1: round(Math.max(c.start + 0.35, c.end)),
    chars: (c.chars || []).map(k => ({ ch: k.ch, f0: round(k.f0), f1: round(k.f1) })),
  })).filter(c => c.text && c.f1 > c.f0)

  // ── 章节：取 ASR 整句，短句并进去，但并长了不并（和 PPT 底座同一套规则）──
  const sentences = (segments || [])
    .map(s => ({ start: map(s.start), end: Math.max(map(s.start) + 1.0, map(s.end)), text: String(s.text || '').replace(PUNCT, '') }))
    .filter(s => s.text && s.end > s.start)
  const chapters = mergeSentences(sentences).map(c => ({ start: round(c.start), end: round(c.end), text: c.text }))
  if (chapters.length < 2) {
    // 句子信息不可用（whisper 有时整段只回一个 segment）时退回到按卡片分组：
    // 攒到 CHAPTER_MAX 字就落一章，不再固定「两张一章」——那样会攒出三行墙和「这件事」这种孤儿章。
    chapters.length = 0
    let cur = []
    const flush = () => {
      if (!cur.length) return
      chapters.push({ start: cur[0].f0, end: cur.at(-1).f1, text: cur.map(c => c.text).join('') })
      cur = []
    }
    for (const b of beats) {
      if (cur.length && cur.reduce((n, c) => n + c.text.length, 0) + b.text.length > CHAPTER_MAX) flush()
      cur.push(b)
    }
    flush()
    // 残句并回上一章：「这件事」这种 3 字章单独上屏会一闪而过
    chapters.splice(0, chapters.length, ...mergeSentences(chapters, { maxChars: CHAPTER_MAX, shortSec: 0 }))
  }

  // ── 大字：一章一个落点，整句上屏不截断；逐字落点留给 film.js 排 ──
  const bigs = chapters.map((ch, i) => {
    const chars = []
    for (const b of beats) {
      if (b.f0 < ch.start - 0.02 || b.f0 > ch.end + 0.02) continue
      for (const k of b.chars) chars.push(k)
    }
    return {
      index: i + 1,
      text: ch.text,
      // 词边界跟着内容走：画布引擎按它断行，不靠字数硬切（「视 / 频」那种切口）
      words: segment(ch.text),
      f0: round(ch.start),
      // 大字挂到这一章结束（下一章开始）为止，而不是「字数 × 0.16s」就撤。
      // 按字数算的窗口在 16–20 字的章节上会提前 1–1.5s 消失，那一段画面只剩声音、没有一个字。
      f1: round(ch.end),
      chars,
    }
  })

  // ── 一条光轨：点燃 → 扫描 → 变成声波基线，每章一个齿 ──
  const marks = chapters.map((ch, i) => ({ t: round(ch.start), index: i + 1, total: chapters.length }))

  // ── 音效只回应看得见的动作：点燃、扫描、每章一下、收尾 ──
  const cues = []
  cues.push({ t: 0.08, sfx: 'click', gain: 0.7 })
  cues.push({ t: 0.16, sfx: 'zip', gain: 0.8 })
  cues.push({ t: 0.7, sfx: 'scan', gain: 0.55 })
  for (const m of marks.slice(1)) cues.push({ t: m.t, sfx: 'impact', gain: 0.5 })
  cues.push({ t: Math.max(0.2, duration - 0.45), sfx: 'drop', gain: 0.7 })

  const scene = {
    template: t.id,
    ratio: RATIO,
    size: L.size,
    fps,
    frames: totalFrames,
    duration: round(duration),
    palette: t.palette,
    person: { seq: 'person', count: ranges.reduce((n, r) => n + r.srcCount, 0), ranges },
    beats,
    bigs,
    marks,
    cues,
    stats: {
      source: round(plan.sourceDuration || 0, 2),
      out: round(duration, 2),
      kept: round(plan.keptSeconds, 2),
      cut: round(plan.cutSeconds, 2),
      segments: plan.keep.length,
      pauses: plan.removedPauses,
      speed: plan.options.speed,
    },
    timeline: {
      duration: round(duration),
      tracks: [
        {
          name: 'KEEP',
          color: t.palette.signal,
          clips: ranges.map(r => [round(r.outF0 / fps / duration, 4), round(r.outF1 / fps / duration, 4)]),
        },
      ],
    },
    labels: {
      platform: brief.platform || '',
      template: t.name,
    },
  }
  return scene
}
