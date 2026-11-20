/**
 * 剪辑决策：只在"词与词之间的空档"下刀，永远不切断一个词。
 * 输入词级时间戳，输出保留区间（源时间）+ 时间映射。
 */

export const DEFAULT_PLAN = {
  pauseThreshold: 0.45, // 超过这个长度的停顿才剪
  keepHead: 0.10,       // 停顿前保留的呼吸
  keepTail: 0.14,       // 停顿后保留的起音
  minSegment: 0.60,     // 短于这个的保留段并进邻居，避免碎剪
  leadIn: 0.15,
  tailOut: 0.30,
  speed: 1.0,
}

export function buildPlan(words, mediaDuration, options = {}) {
  const o = { ...DEFAULT_PLAN, ...options }
  if (!words.length) throw new Error('没有识别到任何词')

  const sorted = words.filter(w => w.end > w.start).sort((a, b) => a.start - b.start)
  const cuts = []
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].start - sorted[i].end
    if (gap > o.pauseThreshold) {
      const from = sorted[i].end + o.keepHead
      const to = sorted[i + 1].start - o.keepTail
      if (to - from > 0.05) cuts.push([from, to, gap])
    }
  }

  const start = Math.max(0, sorted[0].start - o.leadIn)
  const end = Math.min(mediaDuration || sorted.at(-1).end + o.tailOut, sorted.at(-1).end + o.tailOut)

  // 保留区间 = 全程减去切口
  const keep = []
  let cursor = start
  for (const [from, to] of cuts) {
    if (from > cursor) keep.push([cursor, from])
    cursor = Math.max(cursor, to)
  }
  if (cursor < end) keep.push([cursor, end])

  const merged = mergeTiny(keep, o.minSegment)
  const keptSeconds = merged.reduce((sum, [a, b]) => sum + (b - a), 0)
  const outDuration = keptSeconds / o.speed

  return {
    options: o,
    keep: merged,
    cuts,
    sourceDuration: mediaDuration,
    outDuration,
    keptSeconds,
    cutSeconds: Math.max(0, mediaDuration - keptSeconds),
    speedSaved: Math.max(0, keptSeconds - outDuration),
    removedPauses: cuts.length,
  }
}

/** 太短的保留段并进前一段（间隔过大的不并，避免把长停顿带回来）。 */
function mergeTiny(ranges, minSegment) {
  const out = []
  for (const [a, b] of ranges) {
    if (b - a <= 0) continue
    const prev = out.at(-1)
    if (prev && (b - a < minSegment) && (a - prev[1] < 0.35)) prev[1] = b
    else if (prev && b - a < 0.15 && a - prev[1] < 0.6) prev[1] = b
    else out.push([a, b])
  }
  // 合并后可能又产生过短的收尾段
  while (out.length > 1 && out.at(-1)[1] - out.at(-1)[0] < 0.25) {
    const last = out.pop()
    out.at(-1)[1] = last[1]
  }
  return out
}

/** 源时间 → 成片时间；落在切口里的源时间按切口起点算。 */
export function makeMapper(plan) {
  const { keep, options } = plan
  const bounds = []
  let acc = 0
  for (const [a, b] of keep) {
    const d = (b - a) / options.speed
    bounds.push({ a, b, start: acc, end: acc + d })
    acc += d
  }
  return function map(t) {
    for (const r of bounds) {
      if (t <= r.a) return r.start
      if (t <= r.b) return r.start + (t - r.a) / options.speed
    }
    return acc
  }
}
