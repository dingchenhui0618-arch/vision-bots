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
      const longest = Math.max(1, ...b.lines.map(l => [...l].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)))
      // 三行缩一档，和 film.js 的 fitBigSize 同一口径（不然盒子说 96、画面画 90，量出来的高度是假的）
      const capSize = lines >= 3 ? Math.min(TY.big || 96, 104) : (TY.big || 96)
      const size = Math.max(TY.bigMin || 62, Math.min(capSize, Math.floor(((w - L.big.left - L.big.right) * 0.98) / longest)))
      // 盒子量的是「墨迹」，不是行盒：film.js 把基线画在 top + i*lh + size*0.86 上，
      // 所以第一行字顶在 top + 0.14*size，最后一行字底在 top + (lines-1)*lh + 0.74*size。
      // 按行盒算会往下多出 30px 的空白，和大字上方的图形块量出 4px 的假重叠（自测 11 踩到）。
      const lh = size * ((L.big && L.big.lineGap) || 1.06)
      const bh = Math.round((lines - 1) * lh + size * 0.74)
      const inkTop = Math.round((size * 0.74 - size * 0.86) * 0 + size * 0.14)
      const bottom = shot.kind === 'frame' ? h * 0.80 : h * 0.775
      const x = (L.big && L.big.left) || 62
      // 小窗版式的大字以前被压窄到 0.55w（怕撞小窗），结果字号掉到 62、左边一片死黑；
      // 小窗只占上方右侧（0.10–0.50h），大字压在 0.56h 以下的胸口，两者从不重叠，用满宽。
      const maxW = w - x - ((L.big && L.big.right) || 150)
      const blockTop = Math.round(bottom - lines * lh)
      items.push({ tag: 'big', x, y: blockTop + inkTop, w: Math.round(maxW), h: Math.round(bh), t0: b.f0, t1: b.f1, shot: shot.kind })
    }
    // 字幕：和 film.js 同一个字宽公式
    for (const s of scene.subs || []) {
      const em = [...String(s.text)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)
      const pw = Math.min(w - 96, Math.round(em * SUB2.size + SUB2.padX * 2))
      const ph = Math.round(SUB2.size * 1.28 + SUB2.padY * 2)
      items.push({ tag: 'sub', x: Math.round((w - pw) / 2), y: Math.round(h - SUB2.bottom - ph), w: pw, h: ph, t0: s.f0, t1: s.f1 })
    }
    // 人物窗口矩形：和 film.js 的 personRect 同一个算法（几何全在 template.json 里）
    const M0 = L.margin || 56
    const personRect = (kind) => {
      if (kind === 'frame') {
        const dw = Math.round(w * ((L.frame && L.frame.w) || 0.52))
        const dh = Math.round(dw * h / w)
        return { x: Math.round((w - dw) / 2), y: Math.round(h * ((L.frame && L.frame.y) || 0.2)), w: dw, h: dh }
      }
      if (kind === 'corner') {
        const dw = Math.round(w * ((L.corner && L.corner.w) || 0.52))
        const dh = Math.round(dw * h / w)
        return { x: w - dw - M0, y: Math.round(h * ((L.corner && L.corner.top) || 0.2)), w: dw, h: dh }
      }
      if (kind === 'outro') {
        const dw = Math.round(w * ((L.outro && L.outro.w) || 0.54))
        const dh = Math.round(dw * h / w)
        return { x: Math.round((w - dw) / 2), y: Math.round(h * 0.16), w: dw, h: dh }
      }
      return { x: 0, y: 0, w, h }
    }

    // 图形块：按种类算真实范围（不是「整块保守区」）
    for (const b of scene.blocks || []) {
      const sk = shotAt(b.f0).kind
      if (b.kind === 'check') items.push({ tag: 'block:check', x: 56, y: Math.round(sk === 'corner' ? h * 0.50 : sk === 'frame' ? h * 0.86 : h * 0.775) - 84, w: Math.min(w - 112, 620), h: 84, t0: b.f0, t1: b.f1, shot: sk })
      else if (b.kind === 'banner') {
        // 红条是两条斜杠压出来的「划掉」：位置按 film.js 的 banner() 记两个真盒子（以前记成一个 0.42h 的整条，
        // 量出来的高度和画出来的不是一回事）。它按设计是满幅出血，所以带 bleed 标记，安全区只放宽横向。
        for (const yy of [0.575, 0.635]) items.push({ tag: 'block:banner', x: 0, y: Math.round(h * yy - 28), w, h: 56, t0: b.f0, t1: b.f1, shot: sk, bleed: true })
      }
      else if (b.kind === 'gauge') items.push({ tag: 'block:gauge', x: w - 56 - 430, y: Math.round(h * 0.575), w: 430, h: 210, t0: b.f0, t1: b.f1, shot: sk })
      else if (b.kind === 'tagwall') {
        // 标签墙以前按「人物整块区域」记一个 1080×62% 的大盒子，于是永远和章节卡相交、
        // 也永远贴边——那是盒子编错了，不是画面压了。这里按 film.js 的真实摆放逐个算：
        // 左右两个窄带、交替左右、按同侧的个数平分高度。
        const r = personRect(sk)
        // 和 film.js 的 tagZones 同一套：放不下 (<140px) 的那一侧不排，全部挪到另一侧
        const rawL = r.x - M0 - 18
        const rawR = w - M0 - (r.x + r.w + 18)
        const useL = rawL >= 140, useR = rawR >= 140
        const leftZone = { x: M0, w: Math.max(140, rawL) }
        const rightZone = { x: r.x + r.w + 18, w: Math.max(140, rawR) }
        const onRight = j => useR && (!useL || j % 2 === 1)
        const top = r.y + 40, bottom = r.y + r.h - 60
        const list = b.items || []
        list.forEach((it, i) => {
          const right = onRight(i)
          const zone = right ? rightZone : leftZone
          const count = list.filter((_, j) => onRight(j) === right).length || 1
          const slot = list.filter((_, j) => j < i && onRight(j) === right).length
          const y = top + (slot + 0.5) * ((bottom - top) / count)
          // 字宽按 24px 估（实际 22px），盒子宁可偏大：只会让检查更严
          // 宽度必须和 film.js 一样先按窄带截断：不截的话长词（生产力工具）量出来的盒子比画出来的宽，
          // 安全区就会报「出画」——那是盒子编的，不是画面出的。
          const cw = Math.min(Math.round(zone.w), Math.round(textEm(it) * 24 + 30))
          const x = right ? zone.x : zone.x + Math.max(0, (zone.w - cw) * 0.5)
          items.push({ tag: 'block:tag', x: Math.round(x), y: Math.round(y - 23), w: Math.round(cw), h: 46, t0: b.f0, t1: b.f1, shot: sk })
        })
      }
      else if (b.kind === 'avatar') items.push({ tag: 'block:avatar', x: 56, y: Math.round(h * 0.32), w: 560, h: 132, t0: b.f0, t1: b.f1, shot: sk })
    }
    // 句子级小标签：和 film.js 的 chipLayer 同一套几何（左右两条边、三条泳道）
    const CHIPL = L.chips || { lanes: [0.255, 0.345, 0.435], left: M0, right: 150, h: 46, padX: 20 }
    for (const ch of scene.chips || []) {
      const size = TY.chip || 24
      const cw = Math.round(textEm(ch.text) * size + (CHIPL.padX || 20) * 2)
      const hh = CHIPL.h || 46
      const y = Math.round(h * (((CHIPL.lanes || [])[ch.lane]) || 0.3))
      const sk2 = shotAt(ch.f0).kind
      const pr = personRect(sk2)
      const x = (sk2 === 'frame' || sk2 === 'corner')
        ? (ch.side ? pr.x + pr.w + 18 : pr.x - 18 - cw)
        : (ch.side ? w - (CHIPL.right || 150) - cw : (CHIPL.left || M0))
      items.push({ tag: 'block:chip', x, y: y - hh / 2, w: cw, h: hh, t0: ch.f0, t1: ch.f1, shot: shotAt(ch.f0).kind })
    }
    // HUD 三件 + 章节卡：以前没进盒子表，等于质检看不见页码/胶囊/进度线/章节卡，
    // 「章节卡压大字」「小字眉压亮背景读不清」这类问题全都漏检。
    const M2 = L.margin || 56
    const HUDY = (L.hud && L.hud.y) || 92
    const HUDH = (L.hud && L.hud.h) || 42
    items.push({ tag: 'hud:page', x: M2, y: HUDY, w: 240, h: HUDH, t0: 0, t1: scene.duration })
    items.push({ tag: 'hud:brand', x: w - M2 - 320, y: HUDY, w: 320, h: HUDH, t0: 0, t1: scene.duration })
    const PG = L.progress || { y: h - 68, h: 2 }
    items.push({ tag: 'hud:progress', x: M2, y: PG.y - 6, w: w - M2 * 2, h: 12, t0: 0, t1: scene.duration })
    const CH2 = L.chapter || { y: 260 }
    for (const p of scene.pages || []) {
      if (!p.title) continue
      items.push({ tag: 'chapter', x: M2, y: Math.round(CH2.y - 90), w: w - M2 * 2, h: 170, t0: p.start, t1: Math.min(p.end, p.start + 2.0) })
    }
    return { ok: true, items, layout: { mode: 'zheguang', bigBottom: Math.round(h * 0.775), subTop: Math.round(h - SUB2.bottom - 90), shots: shots.length } }
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