/**
 * 版式盒子：从 scene + template.json 直接算出「每个元素画在哪」。
 *
 * 为什么不靠浏览器回报：那要再起一次 Chrome，机器紧张时起不来，质检就整个失效（2026-11-23 实测踩到）。
 * 版式本来就是数据（template.json 的 layouts + scene 的段落/字幕），坐标可以在 Node 里算准。
 * 垂直位置是精确值（这是「光轨穿脸」那条 bug 的关键维度）；宽度取最宽可能值（保守），
 * 因为盒子偏大只会让检查更严，不会放过问题。
 */
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x)

/** 中文字宽按 1em、ASCII 按 0.56em 估（和断行同一套口径），用于取最宽可能值。 */
const textEm = (str) => [...String(str)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)

export function layoutBoxes({ scene, template }) {
  const L = (template.layouts && (template.layouts[scene.ratio] || template.layouts[template.ratio])) || null
  if (!L) return { ok: false, reason: '模板没有这个画幅的布局：' + scene.ratio, items: [] }
  const [w, h] = scene.size
  const BIG = L.big
  const SUB = L.sub || { bottom: Math.round(h * 0.12), size: 44, padX: 38, padY: 20 }
  const LABEL = L.label || { top: 44, side: 44 }

  // ── 无光轨的模板（折光）：版式按 scene.shots 走，盒子按每段真实版式算 ──
  if (!L.rail) {
    const TY = template.type || {}
    const SUB2 = {
      bottom: (L.sub && L.sub.bottom) || 236,
      size: TY.sub || 42,
      padX: (L.sub && L.sub.padX) || 28,
      padY: (L.sub && L.sub.padY) || 15,
    }
    const items = []
    const shots = scene.shots || [{ f0: 0, f1: scene.duration, kind: 'full' }]
    const shotAt = (t) => shots.find(s => t >= s.f0 && t < s.f1) || shots[0]
    // 大字：按版式给不同的底边（和 film.js 的 bigBottom 一致）
    for (const b of scene.bigs || []) {
      const shot = shotAt(b.f0)
      const lines = Math.max(1, (b.lines && b.lines.length) || 1)
      const size = (b.lines && Math.max(...b.lines.map(l => [...l].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)))) ? Math.max(TY.bigMin || 62, Math.min(TY.big || 96, Math.floor((w - L.big.left - L.big.right) / Math.max(...b.lines.map(l => [...l].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)))))) : (TY.big || 96)
      const bh = lines * size * ((L.big && L.big.lineGap) || 1.06)
      const bottom = shot.kind === 'frame' ? h * 0.80 : shot.kind === 'corner' ? h * 0.50 : h * 0.71
      const x = (L.big && L.big.left) || 62
      const maxW = shot.kind === 'corner' ? w * 0.55 : w - x - ((L.big && L.big.right) || 150)
      items.push({ tag: 'big', x, y: Math.round(bottom - bh), w: Math.round(maxW), h: Math.round(bh), t0: b.f0, t1: b.f1 })
    }
    // 字幕：和 film.js 同一个字宽公式
    for (const s of scene.subs || []) {
      const em = [...String(s.text)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)
      const pw = Math.min(w - 96, Math.round(em * SUB2.size + SUB2.padX * 2))
      const ph = Math.round(SUB2.size * 1.28 + SUB2.padY * 2)
      items.push({ tag: 'sub', x: Math.round((w - pw) / 2), y: Math.round(h - SUB2.bottom - ph), w: pw, h: ph, t0: s.f0, t1: s.f1 })
    }
    // 图形块：按种类给保守的整块范围
    for (const b of scene.blocks || []) {
      if (b.kind === 'check') items.push({ tag: 'block:check', x: 56, y: Math.round(h * 0.775) - 84, w: Math.min(w - 112, 620), h: 84, t0: b.f0, t1: b.f1 })
      else if (b.kind === 'banner') items.push({ tag: 'block:banner', x: 0, y: Math.round(h * 0.42), w, h: Math.round(h * 0.16), t0: b.f0, t1: b.f1 })
      else if (b.kind === 'gauge') items.push({ tag: 'block:gauge', x: w - 56 - 430, y: Math.round(h * 0.575), w: 430, h: 210, t0: b.f0, t1: b.f1 })
      else if (b.kind === 'tagwall') items.push({ tag: 'block:tag', x: 0, y: Math.round(h * 0.10), w, h: Math.round(h * 0.62), t0: b.f0, t1: b.f1 })
      else if (b.kind === 'avatar') items.push({ tag: 'block:avatar', x: 56, y: Math.round(h * 0.32), w: 560, h: 132, t0: b.f0, t1: b.f1 })
    }
    return { ok: true, items, layout: { mode: 'zheguang', bigBottom: Math.round(h * 0.71), subTop: Math.round(h - SUB2.bottom - 90), shots: shots.length } }
  }

  // 轨道：和 film.js 同一套让位规则（有头部实测才让，没有就用模板值）
  const head = scene.person && scene.person.headBand && scene.person.headBand.ok ? scene.person.headBand : null
  const SUB_H = Math.round(SUB.size * 1.18) + SUB.padY * 2
  const SUB_TOP = h - SUB.bottom - SUB_H
  let railY = L.rail.y * h
  if (head) railY = Math.max(railY, head.band.bottom * h + h * 0.045)
  const RAIL_CEIL = SUB_TOP - L.rail.height - 24
  let conflict = null
  if (railY > RAIL_CEIL) {
    railY = RAIL_CEIL
    if (head && railY < head.band.bottom * h) conflict = '人物头部到 ' + (head.band.bottom * 100).toFixed(0) + '% 高度，轨道压到 ' + (railY / h * 100).toFixed(0) + '% 仍然避不开'
  }
  const bigBottom = railY - 44

  const items = []
  // 大字：每段一条，块底固定，块高按最多两行 × 字号上限（保守取大）
  for (const b of scene.bigs || []) {
    const lines = Math.min(BIG.maxLines, Math.max(1, Math.ceil(textEm(b.text) / BIG.lineChars)))
    const size = BIG.size
    const bh = lines * size * BIG.lineGap
    const bw = Math.min(w - BIG.left - BIG.right, Math.max(size * 2, textEm(b.text.length > BIG.lineChars ? Math.ceil([...b.text].length / lines) : b.text) * size))
    items.push({ tag: 'big', x: BIG.left, y: Math.round(bigBottom - bh), w: Math.round(Math.min(bw, w - BIG.left - BIG.right)), h: Math.round(bh), t0: b.f0, t1: b.f1 })
  }
  // 轨道：画面上是「暗底 + 橙色波形」，盒子取暗底（含 16px 出血），和 film.js 的 pill 参数对齐
  items.push({
    tag: 'rail',
    x: Math.round(w / 2 - (w - L.rail.x - L.rail.right + 32) / 2),
    y: Math.round(railY - (L.rail.height + 18) / 2),
    w: w - L.rail.x - L.rail.right + 32,
    h: L.rail.height + 18,
    t0: 0.9, t1: scene.duration,
  })
  // 字幕：和 film.js 同一个字宽公式 → 盒子就是 pill 本身。
  // 和这条大字完全一样的字幕，渲染时是不画的（一句话只上一次屏），盒子也不能算进来，
  // 否则质检会在「没有 pill 的帧」上量对比度，凭空得到一个低分（实测踩到）。
  // 和 film.js 同一套判据：只认完全一样。句级大字通常是字幕的子串，
  // 按包含判会把正常句子的字幕盒子整条吞掉——质检就漏量了那几帧。
  const sameText = (a, b) => {
    const norm = (x) => String(x || '').replace(/[\s，。！？、；：,.!?;:""''…—~·]/g, '')
    const A = norm(a), B = norm(b)
    return Boolean(A && B && A === B)
  }
  for (const s of scene.subs || []) {
    const sec = (scene.bigs || []).find(b => s.f0 >= b.f0 - 0.12 && s.f0 < b.f1)
    if (sec && sameText(s.text, sec.text)) continue
    const tw = Math.min(w - 48, Math.round(textEm(s.text) * SUB.size + SUB.padX * 2))
    items.push({ tag: 'sub', x: Math.round((w - tw) / 2), y: Math.round(h - SUB.bottom - SUB_H), w: tw, h: SUB_H, t0: s.f0, t1: s.f1 })
  }
  // HUD：film.js 里 pill 以 (X + lw/2 - 8, TOP + 4) 为中心、高 44
  const hudW = (str) => Math.round(textEm(str) * 22 + 34)
  items.push({ tag: 'hud:rec', x: LABEL.side - 8, y: LABEL.top + 4 - 22, w: hudW('REC 00:00:00:00'), h: 44, t0: 0, t1: scene.duration })
  const secW = Math.round(textEm('00 / 00') * 22 + 32)
  items.push({ tag: 'hud:sec', x: w - LABEL.side - secW + 8, y: LABEL.top + 4 - 22, w: secW, h: 44, t0: 0, t1: scene.duration })

  return {
    ok: true,
    items,
    layout: { railY: Math.round(railY), subTop: Math.round(SUB_TOP), bigBottom: Math.round(bigBottom), conflict, headBand: head ? head.band : null },
    source: 'layout',
  }
}

/** 取某时刻在屏幕上的那一条（同一 tag 可能有多条，质检按时间取样）。 */
export function boxesAtTime(items, fps, from, to, step) {
  const out = []
  for (let f = from; f <= to; f += step) {
    const t = f / fps
    const list = []
    for (const it of items) {
      if (t + 1e-6 < it.t0 || t - 1e-6 > it.t1) continue
      list.push({ ...it, frame: f, t0: t, t1: t })
    }
    out.push({ frame: f, list })
  }
  return out
}