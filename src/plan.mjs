/**
 * 剪辑决策 v2：先决定删哪些词，再决定停机留多长，最后让接缝落在最安静的地方。
 * 永远不切断一个词——所有刀都在词与词之间。
 *
 * v1 只会一件事：找到长空档剪掉。v2 多三层（来源：口播生产线的剪辑表语义）：
 *   1) 删除表按理由分类：repeat（说了两遍）、filler（口头语）、mistake（口误，需外部给）。
 *      每条都带文本、理由和位置，随片交付，质检和制片人不用猜剪了什么。
 *   2) 停机长度按标点分级：句号 0.30s、逗号 0.22s、删词接缝 0.08s、无标点 0.20s。
 *      一刀切 0.45s 会把该断的地方留得太长、该留的换气剪掉。
 *   3) 接缝落在能量最低处：在名义刀口前后 250ms 里找连续 25ms 的安静段，
 *      两侧各让一半。给了 envelope 才做；没给就按名义值切（老路径不变）。
 *
 * 硬约束：只输出保留区间，词的文本和时间码一个字都不动（时间码是剪辑定的）。
 */

export const DEFAULT_PLAN = {
  pauseThreshold: 0.45, // 超过这个长度的停顿才剪
  keepHead: 0.10,       // 停顿前保留的呼吸（无能量包络时的兜底）
  keepTail: 0.14,       // 停顿后保留的起音
  minSegment: 0.60,     // 短于这个的保留段并进邻居，避免碎剪
  leadIn: 0.15,
  tailOut: 0.30,
  speed: 1.0,
  // 停机目标：按前一个词的标点分级
  gap: { period: 0.30, comma: 0.22, cut: 0.08, none: 0.20 },
  // 接缝吸附
  seam: { searchMs: 250, quietMs: 25, thresholdDb: -34, nudge: 0.012 },
  // 相邻重复：同一段话紧接着说了两遍，删后一遍
  dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 },
  // 口头语
  filler: { enabled: true, minGapSec: 0.12, words: [], markers: [] },
  // 删除的总字数占比上限：删过头就不是剪辑，是重写
  maxDeleteShare: 0.30,
}

const PERIOD = /[。！？!?]$/
const COMMA = /[，、；：,;:]$/
const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu

const textOf = w => String(w && w.w != null ? w.w : (w && w.text) || '')
const bare = s => String(s || '').replace(PUNCT, '')

/** 词的时间戳兜底：两种字段名都认（历史数据里有 start/end 和 s/e）。 */
function norm(words) {
  // i 必须是「过滤、排序之后」的下标：删除表里记的是区间下标，保留表是按 i 过滤的。
  // 一边用下标、一边用 i，只要先被过滤掉一个词（空词、零时长），后面全体错位一格——
  // 真素材上就是这么把重复句前一个词「容」删掉、刀口切进它中间的。
  return (words || [])
    .map(w => ({ w: textOf(w), start: Number(w.start ?? w.s), end: Number(w.end ?? w.e) }))
    .filter(w => w.w && Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => a.start - b.start)
    .map((w, i) => ({ ...w, i }))
}

/** 在词序列里找一段原话（连续词拼起来等于 text），near 用来区分重复出现的同一句。 */
function findRun(ws, text, near = null) {
  const target = bare(text)
  if (!target) return null
  const hits = []
  for (let i = 0; i < ws.length; i++) {
    let acc = ''
    for (let j = i; j < ws.length && acc.length < target.length; j++) {
      acc += bare(ws[j].w)
      if (acc === target) { hits.push([i, j]); break }
      if (!target.startsWith(acc)) break
    }
  }
  if (!hits.length) return null
  if (near == null) return hits[0]
  return hits.reduce((best, h) => (Math.abs(ws[h[0]].start - near) < Math.abs(ws[best[0]].start - near) ? h : best), hits[0])
}

/**
 * 找相邻重复：同一段连续词紧接着又出现一次（中间停顿 < maxGapSec）。
 * 只删后一遍，前一遍保留——观众听到的第一遍才是他的节奏。
 */
function findRepeats(ws, { minWords = 3, minChars = 4, maxGapSec = 0.8 } = {}, taken) {
  const out = []
  for (let k = 8; k >= minWords; k--) {
    for (let i = 0; i + 2 * k <= ws.length; i++) {
      const a = ws.slice(i, i + k), b = ws.slice(i + k, i + 2 * k)
      if (a.some(w => taken.has(w.i)) || b.some(w => taken.has(w.i))) continue
      const ta = a.map(w => bare(w.w)).join(''), tb = b.map(w => bare(w.w)).join('')
      if (!ta || ta !== tb || ta.length < minChars) continue
      if (b[0].start - a[k - 1].end > maxGapSec) continue
      out.push({ i0: i + k, i1: i + 2 * k - 1, reason: 'repeat', text: tb, from: b[0].start })
      for (let x = i + k; x < i + 2 * k; x++) taken.add(ws[x].i)
    }
  }
  return out
}

/**
 * 口头语。分两类，因为误删的代价不一样：
 *   words   —— 语气词（嗯/啊/呃/哎）：只要一侧有停顿就是独立说出来的，可以删。
 *   markers —— 话语标记（那个/就是说/你知道吧）：后面必须有停顿才算口头语。
 *              「那个」在「那个人」里是指示词，后面紧跟名词、没有停顿，删了就改了原意。
 */
function findFillers(ws, { words = [], markers = [], minGapSec = 0.12 } = {}, taken) {
  const strong = new Set(words.map(bare).filter(Boolean))
  const weak = new Set(markers.map(bare).filter(Boolean))
  if (!strong.size && !weak.size) return []
  const out = []
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i]
    if (taken.has(w.i)) continue
    const t = bare(w.w)
    const isStrong = strong.has(t), isWeak = weak.has(t)
    if (!isStrong && !isWeak) continue
    const gapBefore = i > 0 ? w.start - ws[i - 1].end : 9
    const gapAfter = i + 1 < ws.length ? ws[i + 1].start - w.end : 9
    const ok = isStrong ? (gapBefore >= minGapSec || gapAfter >= minGapSec) : gapAfter >= minGapSec
    if (!ok) continue
    out.push({ i0: i, i1: i, reason: 'filler', text: t, from: w.start })
    taken.add(w.i)
  }
  return out
}

/** 一句都不许删空：删完必须先留下至少一个词。 */
function protect(ws, dels) {
  const taken = new Set()
  for (const d of dels) for (let i = d.i0; i <= d.i1; i++) taken.add(i)
  const out = []
  for (const d of dels) {
    let alive = 0
    for (let i = 0; i < ws.length; i++) if (!taken.has(i)) alive++
    // 全删光就把 filler 退回去（口头语可以留，片子不能没声）
    if (alive === 0 && d.reason === 'filler') { taken.delete(d.i0); continue }
    out.push(d)
  }
  return out
}

function targetGap(prev, deleted, gap) {
  const t = String(prev && prev.w || '')
  if (PERIOD.test(t)) return gap.period
  if (COMMA.test(t)) return gap.comma
  return deleted ? gap.cut : gap.none
}

/** 从 t 开始往后找连续 quietMs 的安静段；找不到返回 null（去找名义值，别硬编一个假安静点）。 */
function quietForward(env, t, limit, { quietMs = 25, thresholdDb = -34 } = {}) {
  if (!env) return null
  const hop = env.hopSec, n = Math.max(1, Math.round(quietMs / 1000 / hop))
  for (let x = t; x <= limit; x += hop) {
    const i = Math.round(x / hop)
    let ok = true
    for (let k = 0; k < n; k++) {
      const v = env.db[i + k]
      if (v === undefined || v >= thresholdDb) { ok = false; break }
    }
    if (ok) return x
  }
  return null
}

/** 从 t 开始往前找连续 quietMs 的安静段；找不到返回 null。 */
function quietBack(env, t, limit, { quietMs = 25, thresholdDb = -34 } = {}) {
  if (!env) return null
  const hop = env.hopSec, n = Math.max(1, Math.round(quietMs / 1000 / hop))
  for (let x = t; x >= limit; x -= hop) {
    const i = Math.round(x / hop) - n
    let ok = i >= 0
    if (ok) for (let k = 0; k < n; k++) {
      const v = env.db[i + k]
      if (v === undefined || v >= thresholdDb) { ok = false; break }
    }
    if (ok) return x
  }
  return null
}

/**
 * 一刀：A 的尾音之后到 B 的起音之前，留 g 秒，两侧各让一半。
 * lo/hi 是这刀两边不许越界的硬边：删词时是删除区间（切口必须完整盖住它），
 * 空档时是前后两个词的边。
 *
 * 能量吸附只是「把刀口挪到更安静的地方」，挪不动就用名义值——
 * 宁可接缝留一点吸气声，也不能把切口算成负数（那样会既不剪也不留）。
 */
function refineCut(A, B, lo, hi, g, opts) {
  const nudge = opts.seam.nudge ?? 0.012
  const half = g / 2
  const nominal = [Math.min(A.end + half, lo - nudge), Math.max(B.start - half, hi + nudge)]
  if (!opts.envelope) return nominal

  const search = (opts.seam.searchMs || 250) / 1000
  const te = quietForward(opts.envelope, A.end + 0.06, Math.min(A.end + 0.06 + search, lo), opts.seam)
  const hs = quietBack(opts.envelope, B.start - 0.04, Math.max(B.start - 0.04 - search * 0.8, hi), opts.seam)
  // 没找到够宽的安静区（噪声地板高、或者安静点太窄）：用名义值。
  // 宁可留一点吸气声，也不要为「吸附」而多留 100ms 的停顿。
  if (te == null || hs == null || !(hs - te >= g)) return nominal
  const a = Math.min(half, (hs - te) / 2)
  const out = Math.min(te + a, lo - nudge)
  const back = Math.max(hs - (g - a), hi + nudge)
  return back > out ? [out, back] : nominal
}

export function buildPlan(words, mediaDuration, options = {}) {
  const o = { ...DEFAULT_PLAN, ...options, gap: { ...DEFAULT_PLAN.gap, ...(options.gap || {}) }, seam: { ...DEFAULT_PLAN.seam, ...(options.seam || {}) } }
  const ws = norm(words)
  if (!ws.length) throw new Error('没有识别到任何词')

  // ── 1) 删除表：显式指定的（口误，外部给）+ 能自动认的（重复、口头语）
  const dels = []
  const taken = new Set()
  for (const d of options.deletions || []) {
    const run = findRun(ws, d.text, d.near ?? null)
    if (!run) continue
    const [a, b] = run
    if (ws.slice(a, b + 1).some(w => taken.has(w.i))) continue
    dels.push({ i0: a, i1: b, reason: d.reason || 'mistake', text: ws.slice(a, b + 1).map(w => w.w).join(''), from: ws[a].start })
    for (let x = a; x <= b; x++) taken.add(ws[x].i)
  }
  if (o.dedupe.enabled) for (const d of findRepeats(ws, o.dedupe, taken)) { dels.push(d); taken.add(d.i0) }
  if (o.filler.enabled) for (const d of findFillers(ws, o.filler, taken)) dels.push(d)
  const deletions = protect(ws, dels).sort((a, b) => a.i0 - b.i0)

  // 删过头就不是剪辑了：超了上限就按理由退（先退口头语）
  const totalChars = ws.reduce((n, w) => n + bare(w.w).length, 0)
  let deletedChars = deletions.reduce((n, d) => n + ws.slice(d.i0, d.i1 + 1).reduce((m, w) => m + bare(w.w).length, 0), 0)
  const share = totalChars ? deletedChars / totalChars : 0
  const keptDels = share > (o.maxDeleteShare ?? 0.3)
    ? (() => {
      const drop = new Set()
      for (const d of deletions) if (d.reason === 'filler') drop.add(d)
      return deletions.filter(d => !drop.has(d))
    })()
    : deletions
  deletedChars = keptDels.reduce((n, d) => n + ws.slice(d.i0, d.i1 + 1).reduce((m, w) => m + bare(w.w).length, 0), 0)

  const delIndex = new Set()
  for (const d of keptDels) for (let i = d.i0; i <= d.i1; i++) delIndex.add(i)
  const kept = ws.filter(w => !delIndex.has(w.i))
  if (!kept.length) throw new Error('删完没有留下任何词')

  // ── 2) 找刀口：删词造成的接缝 + 超长空档
  const cuts = []
  for (let k = 1; k < kept.length; k++) {
    const A = kept[k - 1], B = kept[k]
    const deletedBetween = B.i - A.i > 1
    const gapSec = B.start - A.end
    if (!deletedBetween && gapSec <= o.pauseThreshold) continue
    const lo = deletedBetween ? ws[A.i + 1].start : B.start
    const hi = deletedBetween ? ws[B.i - 1].end : A.end
    const g = targetGap(A, deletedBetween, o.gap)
    const [out, back] = refineCut(A, B, lo, hi, g, o)
    // 切口太小说明这刀不值当：留着换气比剪出 20ms 的碎口自然
    if (back - out <= 0.04) continue
    cuts.push({ from: round3(out), to: round3(back), reason: deletedBetween ? 'delete' : 'pause', target: round3(g), gap: round2(gapSec) })
  }

  const start = Math.max(0, kept[0].start - o.leadIn)
  const end = Math.min(mediaDuration || kept.at(-1).end + o.tailOut, kept.at(-1).end + o.tailOut)

  // ── 3) 保留区间 = 全程减去刀口
  const keep = []
  let cursor = start
  for (const c of cuts) {
    if (c.from > cursor) keep.push([cursor, c.from])
    cursor = Math.max(cursor, c.to)
  }
  if (cursor < end) keep.push([cursor, end])

  const merged = mergeTiny(keep, o.minSegment)
  const keptSeconds = merged.reduce((sum, [a, b]) => sum + (b - a), 0)
  const outDuration = keptSeconds / o.speed
  const byReason = keptDels.reduce((m, d) => { m[d.reason] = (m[d.reason] || 0) + 1; return m }, {})
  const deletedSec = round2(keptDels.reduce((n, d) => {
    const a = ws[d.i0].start, b = ws[d.i1].end
    return n + (b - a)
  }, 0))

  return {
    options: o,
    keep: merged,
    cuts,
    deletions: keptDels.map(d => ({
      reason: d.reason,
      text: d.text,
      from: round3(d.from),
      chars: bare(d.text).length,
    })),
    deletedChars,
    deletedSec,
    byReason,
    sourceDuration: mediaDuration,
    outDuration,
    keptSeconds,
    cutSeconds: Math.max(0, mediaDuration - keptSeconds),
    speedSaved: Math.max(0, keptSeconds - outDuration),
    removedPauses: cuts.filter(c => c.reason === 'pause').length,
    seamCuts: cuts.filter(c => c.reason === 'delete').length,
  }
}

const round2 = n => Math.round(n * 100) / 100
const round3 = n => Math.round(n * 1000) / 1000

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