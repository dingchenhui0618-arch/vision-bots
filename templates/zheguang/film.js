// 折光 · film —— 逐帧渲染器：每一帧都是 scene.json + 时间的纯函数。
// 设计对齐用户给的折光案例：常驻 HUD（页码 / 品牌胶囊 / 进度线）、章节卡、语义强调大字、
// 六种版式（满幅 / 竖框居中 / 右上小窗 / 全屏字卡 / 章节卡 / 结尾画中画）、图形块。
// 画面里出现的每个字都来自 scene.json（原话 + 词级时间戳），这里不做内容判断、不写数字。
import { setSize, W, H, TAU, C, F, rgba, clamp, lerp, seg, E, hash, txt, measure, font, dot, ring,
  rrect, pill, line, glowStroke, glowDot, rectProgress, cornerTicks, polyProgress } from '/engine/core.js'
import { reg, QA } from '/engine/devices.js'
import { loadJSON } from '/engine/media.js'

let FPS = 30
const R = (hex, a = 1) => {
  const h = String(hex).replace('#', '')
  const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + a + ')'
}
const chW = ch => (/[\x00-\xff]/.test(ch) ? 0.56 : 1)
const textEm = s => [...String(s || '')].reduce((n, ch) => n + chW(ch), 0)
const bare = s => String(s || '').replace(/[\s，。！？、；：,.!?;:""''…—~·\-]/g, '')

export async function createFilm({ media }) {
  const S = await loadJSON('/project/scene.json')
  const [w, h] = S.size
  FPS = S.fps
  setSize(w, h)
  let TPL = null
  try { TPL = await loadJSON('/project/template.json') } catch (e) { TPL = null }
  const L = (TPL && TPL.layouts && (TPL.layouts[S.ratio] || TPL.layouts[TPL.ratio])) || {}
  const TY = (S.type && S.type.size) ? S.type : { big: 96, bigMin: 62, sub: 42, subSmall: 34, eyebrow: 21, chapterNum: 84, chapterTitle: 54, block: 26, blockSmall: 20, page: 22, brand: 21 }
  const P = Object.assign({ void: '#0B0B0C', paper: '#F4F2EC', lime: '#D8FF3E', green: '#35E07A', yellow: '#F5E13C', red: '#E23A2C', ash: '#8C8B85' }, S.palette || {})
  const M = L.margin || 56
  const HUD_Y = (L.hud && L.hud.y) || 92
  const CH = L.chapter || { y: 260, gap: 26 }
  const BGL = L.big || { left: 62, right: 150, y: 0.46, lineGap: 1.06, maxLines: 3 }
  const SUBL = L.sub || { bottom: 236, padX: 28, padY: 15, radius: 14 }
  const PROG = L.progress || { y: h - 68, h: 2 }
  const BRAND = (S.labels && S.labels.brand) || ''
  media.register('person', { url: '/media/frames/person', count: S.person.count })

  const shotAt = (t) => (S.shots || []).find(s => t >= s.f0 && t < s.f1) || (S.shots || [])[0] || { kind: 'full' }
  const pageAt = (t) => (S.pages || []).find(p => t >= p.start && t < p.end) || (S.pages || [])[0] || null
  const blockAt = (t) => (S.blocks || []).filter(b => t >= b.f0 && t < b.f1)

  function srcIdx(f) {
    for (const r of S.person.ranges) {
      if (f >= r.outF0 && f < r.outF1) return r.srcF0 + Math.min(r.srcCount - 1, Math.round((f - r.outF0) * r.speed))
    }
    return Math.max(0, S.person.count - 1)
  }

  // ───────── 人物：版式决定画在哪 ─────────
  function personRect(shot) {
    const ww = w
    if (shot.kind === 'frame') {
      const dw = Math.round(ww * ((L.frame && L.frame.w) || 0.52))
      const dh = Math.round(dw * h / w)
      const dy = Math.round(h * ((L.frame && L.frame.y) || 0.11))
      return { x: Math.round((w - dw) / 2), y: dy, w: dw, h: dh, round: 0 }
    }
    if (shot.kind === 'corner') {
      const dw = Math.round(ww * ((L.corner && L.corner.w) || 0.40))
      const dh = Math.round(dw * h / w)
      return { x: w - dw - M, y: Math.round(h * ((L.corner && L.corner.top) || 0.12)), w: dw, h: dh, round: 12 }
    }
    if (shot.kind === 'outro') {
      const dw = Math.round(ww * ((L.outro && L.outro.w) || 0.54))
      const dh = Math.round(dw * h / w)
      return { x: Math.round((w - dw) / 2), y: Math.round(h * 0.16), w: dw, h: dh, round: 28 }
    }
    return { x: 0, y: 0, w, h, round: 0 }
  }

  function drawPerson(c, img, shot) {
    const r = personRect(shot)
    if (shot.kind !== 'full') {
      c.fillStyle = R(P.void, 1)
      c.fillRect(0, 0, w, h)
    }
    if (!img) return
    c.save()
    c.filter = 'contrast(1.05) saturate(0.94) brightness(0.98)'
    if (r.round) { rrect(c, r.x, r.y, r.w, r.h, r.round); c.clip() }
    c.drawImage(img, r.x, r.y, r.w, r.h)
    c.restore()
    if (r.round || shot.kind !== 'full') {
      c.save()
      rrect(c, r.x, r.y, r.w, r.h, r.round || 0)
      c.strokeStyle = R(P.paper, 0.14); c.lineWidth = 2; c.stroke()
      c.restore()
    }
  }

  // ───────── 压光：字要压得住，人不能被压死 ─────────
  function scrim(c, shot, t) {
    if (shot.kind === 'card') return
    const top = c.createLinearGradient(0, 0, 0, h * 0.22)
    top.addColorStop(0, R(P.void, 0.55)); top.addColorStop(1, R(P.void, 0))
    c.fillStyle = top; c.fillRect(0, 0, w, h * 0.22)
    const bot = c.createLinearGradient(0, h * 0.52, 0, h)
    bot.addColorStop(0, R(P.void, 0)); bot.addColorStop(0.55, R(P.void, 0.38)); bot.addColorStop(1, R(P.void, 0.72))
    c.fillStyle = bot; c.fillRect(0, h * 0.52, w, h * 0.48)
    if (shot.kind === 'corner' || shot.kind === 'outro') {
      const side = c.createLinearGradient(0, 0, w * 0.7, 0)
      side.addColorStop(0, R(P.void, 0.9)); side.addColorStop(1, R(P.void, 0.2))
      c.fillStyle = side; c.fillRect(0, 0, w, h)
    }
  }

  // ───────── HUD：页码 / 品牌胶囊 / 进度线 ─────────
  function timecode(t) {
    const fr = Math.floor(t * FPS)
    const p = n => String(n).padStart(2, '0')
    return p(Math.floor(fr / (FPS * 60))) + ':' + p(Math.floor(fr / FPS) % 60) + ':' + p(fr % FPS)
  }

  function chrome(c, t, dark = false) {
    const page = pageAt(t)
    const inkA = dark ? 0.72 : 0.78
    const ink = dark ? P.void : P.paper
    // 左上：P. 01 / 08
    if (page) {
      const label = 'P. ' + String(page.index).padStart(2, '0') + ' / ' + String(page.total).padStart(2, '0')
      txt(c, label, M, HUD_Y + 9, { size: TY.page + 3, family: F.disp, weight: 700, color: R(ink, 0.86), spacing: 2.6 })
      reg(M, HUD_Y - 16, measure(c, label, TY.page, F.disp, 700, 2.4), 40, 'hud:page')
    }
    // 右上：品牌胶囊 + 时间码
    const tc = timecode(t)
    const body = (BRAND ? BRAND + '  ' : '') + tc
    const padX = 18, hh = (L.hud && L.hud.h) || 42
    const tw = measure(c, body, TY.brand, F.disp, 600, 1.4)
    const pw = Math.round(tw + padX * 2 + 18)
    const px = w - M - pw + pw / 2, py = HUD_Y + 5
    c.save()
    pill(c, px, py, pw, hh, dark ? R(P.void, 0.90) : R(P.paper, 0.92))
    dot(c, px - pw / 2 + padX + 3, py, 5, R(P.red, 1))
    txt(c, body, px - pw / 2 + padX + 16, py + 7, { size: TY.brand, family: F.disp, weight: 600, color: dark ? R(P.paper, 0.95) : R(P.void, 0.92), spacing: 1.4 })
    c.restore()
    reg(w - M - pw, py - hh / 2, pw, hh, 'hud:brand')
    // 底部：进度线
    const pw2 = w - M * 2
    line(c, M, PROG.y, M + pw2, PROG.y, R(ink, 0.16), PROG.h)
    const k = clamp(t / Math.max(0.1, S.duration))
    line(c, M, PROG.y, M + pw2 * k, PROG.y, R(P.lime, 0.9), PROG.h)
    dot(c, M + pw2 * k, PROG.y, 3.5, R(P.lime, 1))
    reg(M, PROG.y - 6, pw2, 12, 'hud:progress')
  }

  // ───────── 章节卡 ─────────
  function chapterCard(c, t) {
    const page = pageAt(t)
    if (!page || !page.title) return
    const k0 = seg(t, page.start, page.start + 0.34)
    const k1 = 1 - seg(t, page.start + 1.55, page.start + 2.0)
    const a = E.outExpo(k0) * k1
    if (a <= 0.01) return
    const y = CH.y
    const num = String(page.index).padStart(2, '0')
    c.save()
    c.globalAlpha *= a
    // 顶部一条短绿线，压住章节卡的起点
    line(c, M, y - 104, M + 64 * E.outExpo(k0), y - 104, R(P.lime, 0.95), 4)
    txt(c, 'CHAPTER ' + num + ' / ' + String(page.total).padStart(2, '0'), M, y - 66, { size: TY.eyebrow, family: F.disp, weight: 600, color: R(P.ash, 0.95), spacing: 3 })
    const numW = txt(c, num, M, y + 52, { size: TY.chapterNum, family: F.disp, weight: 800, color: R(P.green, 1), spacing: -1 })
    const tx = M + Math.max(104, numW + 26)
    const titleSize = Math.min(TY.chapterTitle, Math.floor((w - M - tx - M) / Math.max(1, textEm(page.title))))
    txt(c, page.title, tx, y + 50, { size: titleSize, family: F.sans, weight: 900, color: R(P.paper, 1), spacing: -0.5 })
    c.restore()
    reg(M, y - 90, w - M * 2, 170, 'chapter')
  }

  // ───────── 大字：语义强调卡，一行一条逐行上屏 ─────────
  function fitBigSize(lines) {
    const avail = w - BGL.left - BGL.right
    const longest = Math.max(1, ...lines.map(l => textEm(l)))
    return Math.max(TY.bigMin, Math.min(TY.big, Math.floor(avail / longest)))
  }

  /** 大字的底边（不是顶边）：满幅压在胸口，竖框在小窗下面，小窗在左侧中下部。
   *  参考片的大字基本落在 0.5–0.72 这一段，字幕在 0.84——两者永远不重叠。 */
  function bigBottom(shot) {
    if (shot.kind === 'frame') return h * 0.80
    if (shot.kind === 'corner') return h * 0.50
    return h * 0.71
  }

  function drawBig(c, b, t, shot) {
    if (t < b.f0 || t >= b.f1) return
    const lines = b.lines && b.lines.length ? b.lines : [b.text]
    const size = fitBigSize(lines)
    const lh = size * (BGL.lineGap || 1.06)
    const bottom = bigBottom(shot)
    const top = bottom - lines.length * lh
    c.save()
    // 小字眉：换页之后才出现，避免和章节卡打架
    const page = pageAt(t)
    if (page && page.title && t > page.start + 2.0 && b.pageTitle) {
      const eye = '● ' + b.pageTitle
      txt(c, eye, BGL.left, top - 18, { size: TY.eyebrow, family: F.disp, weight: 600, color: R(P.lime, 0.85), spacing: 2.6 })
    }
    c.textBaseline = 'alphabetic'
    lines.forEach((ln, li) => {
      const at = b.f0 + li * (b.lineIn || 0.1)
      const k = E.outExpo(clamp(seg(t, at, at + 0.32)))
      if (k <= 0.01) return
      const y = top + li * lh + size * 0.86
      const baseX = BGL.left + (1 - k) * size * 0.10
      c.globalAlpha = k
      drawRuns(c, ln, baseX, y, size, b.style, b.hot, true)
    })
    c.restore()
    reg(BGL.left, top - 20, w - BGL.left - BGL.right, lines.length * lh + 10, 'big')
  }

  /** 一行字按高亮拆成 before / hot / after 三段画；hot 可以是黄字、荧光绿底黑字、红底白字 */
  function drawRuns(c, ln, x, y, size, style, hot, shadow) {
    const parts = []
    const hotText = hot && ln.includes(hot) ? hot : ''
    const useStyle = hotText ? style : 'plain'
    if (!hotText) parts.push({ text: ln, style: 'plain' })
    else {
      const i = ln.indexOf(hotText)
      if (i > 0) parts.push({ text: ln.slice(0, i), style: 'plain' })
      parts.push({ text: hotText, style: useStyle })
      if (i + hotText.length < ln.length) parts.push({ text: ln.slice(i + hotText.length), style: 'plain' })
    }
    let cx = x
    c.font = font(size, F.sans, 900)
    for (const p of parts) {
      const pw = measure(c, p.text, size, F.sans, 900)
      const accent = p.style === 'yellow'
      const lime = p.style === 'limeMark'
      const red = p.style === 'redBox'
      if (lime || red) {
        const padX = size * 0.08, padY = size * 0.10
        c.save()
        c.fillStyle = lime ? R(P.lime, 1) : R(P.red, 1)
        c.fillRect(cx - padX, y - size * 0.80 - padY * 0.4, pw + padX * 2, size * 0.92 + padY)
        c.restore()
      }
      c.save()
      if (shadow && !lime && !red) { c.shadowColor = R(P.void, 0.75); c.shadowBlur = 26; c.shadowOffsetY = 5 }
      c.fillStyle = lime || red ? R(P.void, 1) : accent ? R(P.yellow, 1) : R(P.paper, 1)
      c.textAlign = 'left'
      c.fillText(p.text, cx, y)
      c.restore()
      cx += pw
    }
  }

  // ───────── 字幕：一句一张，关键词在行内换色 ─────────
  function drawSub(c, t) {
    const cur = (S.subs || []).find(s => t >= s.f0 && t < s.f1)
    if (!cur) return
    const nb = (S.bigs || []).find(b => t >= b.f0 && t < b.f1)
    if (nb && bare(nb.text) === bare(cur.text)) return
    const kIn = E.outCubic(seg(t, cur.f0, cur.f0 + 0.14))
    const kOut = 1 - seg(t, cur.f1 - 0.10, cur.f1)
    const a = Math.min(kIn, kOut)
    if (a <= 0.01) return
    let size = TY.sub
    const avail = w - M * 2 - SUBL.padX * 2
    let lines = [cur.text]
    if (textEm(cur.text) * size > avail) {
      size = TY.subSmall
      if (textEm(cur.text) * size > avail) {
        // 两行：按词边界切（数据层已经断好过一次，这里只兜底）
        const mid = Math.ceil([...cur.text].length / 2)
        lines = [cur.text.slice(0, mid), cur.text.slice(mid)]
      }
    }
    const lh = size * 1.28
    const ph = Math.round(lines.length * lh + SUBL.padY * 2)
    const pw = Math.round(Math.min(avail, Math.max(...lines.map(l => textEm(l))) * size) + SUBL.padX * 2)
    const cx = w / 2
    const cy = h - SUBL.bottom - ph / 2
    c.save()
    c.globalAlpha *= a
    c.translate(0, (1 - kIn) * 10)
    rrect(c, cx - pw / 2, cy - ph / 2, pw, ph, SUBL.radius)
    c.fillStyle = R(P.void, 0.84); c.fill()
    c.strokeStyle = R(P.paper, 0.10); c.lineWidth = 1.5; c.stroke()
    c.restore()
    c.save()
    c.globalAlpha *= a
    c.translate(0, (1 - kIn) * 10)
    c.font = font(size, F.sans, 700)
    lines.forEach((ln, li) => {
      const runs = cur.runs && lines.length === 1 ? cur.runs : [{ text: ln, style: 'plain' }]
      let total = measure(c, ln, size, F.sans, 700)
      let x = cx - total / 2
      const y = cy - ph / 2 + SUBL.padY + size * 0.86 + li * lh
      for (const r of runs) {
        const rw = measure(c, r.text, size, F.sans, r.style === 'hot' ? 800 : 700)
        c.fillStyle = r.style === 'hot' ? R(P.yellow, 1) : R(P.paper, 1)
        c.textAlign = 'left'
        c.fillText(r.text, x, y)
        x += rw
      }
    })
    c.restore()
    reg(cx - pw / 2, cy - ph / 2, pw, ph, 'sub')
  }

  // ───────── 图形块 ─────────
  const blockCard = (c, x, y, ww, hh, r = 16) => {
    rrect(c, x, y, ww, hh, r)
    c.fillStyle = R(P.void, 0.76); c.fill()
    c.strokeStyle = R(P.paper, 0.13); c.lineWidth = 1.5; c.stroke()
  }

  function tagWall(c, b, t) {
    const items = b.items || []
    const shot = shotAt(t)
    const r = personRect(shot)
    const leftZone = { x: M, w: Math.max(120, r.x - M - 18) }
    const rightZone = { x: r.x + r.w + 18, w: Math.max(120, w - M - (r.x + r.w + 18)) }
    const top = r.y + 40, bottom = r.y + r.h - 60
    const size = TY.blockSmall + 2
    items.forEach((it, i) => {
      const at = b.f0 + i * 0.13
      const k = E.outBack(clamp(seg(t, at, at + 0.26)))
      if (k <= 0.01) return
      const right = i % 2 === 1
      const zone = right ? rightZone : leftZone
      const chipsInZone = items.filter((_, j) => (j % 2 === 1) === right).length || 1
      const slot = Math.floor(i / 2)
      const y = top + (slot + 0.5) * ((bottom - top) / chipsInZone)
      const cw = Math.min(zone.w, measure(c, it, size, F.sans, 700) + 30)
      const chh = 46
      const x = right ? zone.x : zone.x + Math.max(0, (zone.w - cw) * 0.5)
      c.save()
      c.globalAlpha *= Math.min(1, k)
      c.translate(x + cw / 2, y); c.scale(0.9 + 0.1 * k, 0.9 + 0.1 * k); c.translate(-(x + cw / 2), -y)
      const hot = i === 0
      blockCard(c, x, y - chh / 2, cw, chh, 10)
      if (hot) { c.fillStyle = R(P.paper, 0.96); rrect(c, x, y - chh / 2, cw, chh, 10); c.fill() }
      txt(c, it, x + 15, y + 8, { size, family: F.sans, weight: 700, color: hot ? R(P.void, 1) : R(P.paper, 0.95) })
      c.restore()
      reg(x, y - chh / 2, cw, chh, 'block:tag')
    })
  }

  function gauge(c, b, t) {
    const k = clamp(seg(t, b.f0 + 0.2, b.f0 + 0.9))
    const cw = Math.min(430, w - M * 2), chh = 210
    const x = w - M - cw, y = h * 0.575
    c.save()
    c.globalAlpha *= k
    blockCard(c, x, y, cw, chh, 18)
    txt(c, 'BARRIER', x + 24, y + 40, { size: TY.blockSmall - 2, family: F.disp, weight: 700, color: R(P.ash, 0.9), spacing: 3 })
    txt(c, b.label || '门槛', x + 24, y + 82, { size: TY.block + 2, family: F.sans, weight: 900, color: R(P.paper, 1) })
    const cells = 5, gap = 10, cellW = (cw - 48 - gap * (cells - 1)) / cells
    const fill = E.outCubic(k)
    for (let i = 0; i < cells; i++) {
      const cx = x + 24 + i * (cellW + gap), cy = y + 116
      rrect(c, cx, cy, cellW, 16, 5)
      c.fillStyle = R(P.paper, 0.14); c.fill()
      const on = clamp((fill * cells - i) / 1)
      if (on > 0) {
        rrect(c, cx, cy, cellW * on, 16, 5)
        c.fillStyle = R(i < 2 ? P.green : P.lime, 0.95); c.fill()
      }
    }
    txt(c, '越来越低', x + 24, y + 176, { size: TY.blockSmall + 2, family: F.sans, weight: 700, color: R(P.lime, 0.95) })
    c.restore()
    reg(x, y, cw, chh, 'block:gauge')
  }

  function checkCard(c, b, t) {
    const k = E.outBack(clamp(seg(t, b.f0, b.f0 + 0.3)))
    if (k <= 0.01) return
    const size = TY.block + 2
    const tw = Math.min(w - M * 2, measure(c, b.text, size, F.sans, 800) + 128)
    const cw = tw, chh = 84
    const shot = shotAt(t)
    const yBase = shot.kind === 'corner' ? h * 0.585 : shot.kind === 'frame' ? h * 0.86 : h * 0.775
    const x = M, y = Math.round(yBase) - chh
    c.save()
    c.globalAlpha *= Math.min(1, k)
    c.translate(M, y); c.scale(0.94 + 0.06 * k, 0.94 + 0.06 * k); c.translate(-M, -y)
    blockCard(c, x, y, cw, chh, 16)
    dot(c, x + 42, y + chh / 2, 17, R(P.lime, 1))
    c.strokeStyle = R(P.void, 1); c.lineWidth = 4; c.beginPath()
    c.moveTo(x + 34, y + chh / 2); c.lineTo(x + 40, y + chh / 2 + 7); c.lineTo(x + 51, y + chh / 2 - 8); c.stroke()
    txt(c, b.text, x + 72, y + chh / 2 + size * 0.36, { size, family: F.sans, weight: 800, color: R(P.paper, 1) })
    c.restore()
    reg(x, y, cw, chh, 'block:check')
  }

  function banner(c, b, t) {
    const k = E.outExpo(clamp(seg(t, b.f0, b.f0 + 0.26)))
    if (k <= 0.01) return
    const text = b.text || ''
    const size = TY.block + 6
    const bh = 78
    for (let i = 0; i < 2; i++) {
      const ang = (i ? 2.6 : -2.2) * Math.PI / 180
      const y = h * (i ? 0.545 : 0.455)
      c.save()
      c.globalAlpha *= Math.min(1, k) * (i ? 0.92 : 1)
      c.translate(w / 2, y); c.rotate(ang)
      const bw = w * 1.1
      c.fillStyle = R(P.red, 0.96)
      c.fillRect(-bw / 2, -bh / 2, bw, bh)
      const unit = measure(c, text, size, F.sans, 900) + 74
      const reps = Math.max(2, Math.floor((bw - 48) / unit))
      for (let r = 0; r < reps; r++) {
        const x = -bw / 2 + 26 + r * unit
        txt(c, text, x, 12, { size, family: F.sans, weight: 900, color: R(P.void, 1) })
        txt(c, '×', x + measure(c, text, size, F.sans, 900) + 20, 12, { size: size + 6, family: F.sans, weight: 900, color: R(P.void, 1) })
      }
      c.restore()
      reg(0, y - bh / 2, w, bh, 'block:banner')
    }
  }

  function dataLine(c, b, t) {
    const k = clamp(seg(t, b.f0, b.f0 + 1.0))
    if (k <= 0.01) return
    const x0 = M, x1 = w - M, y0 = h * 0.66, y1 = h * 0.44
    const pts = []
    for (let i = 0; i < 5; i++) pts.push([lerp(x0, x1, i / 4), lerp(y0 + 20, y1, Math.pow(i / 4, 1.5)) + (i % 2 ? -12 : 8)])
    c.save()
    glowStroke(c, () => polyProgress(c, pts, k), P.lime, 3, 0.90)
    pts.forEach((p, i) => {
      const q = clamp((k * 5 - i) / 1)
      if (q <= 0) return
      glowDot(c, p[0], p[1], 5 * q, P.lime, 0.8)
    })
    c.restore()
    reg(pts[0][0], pts[pts.length - 1][1], x1 - x0, y0 - y1 + 20, 'block:line')
  }

  function avatarCard(c, b, t) {
    const k = E.outCubic(clamp(seg(t, b.f0, b.f0 + 0.3)))
    if (k <= 0.01) return
    const cw = Math.min(560, w - M * 2), chh = 132
    const x = M, y = h * 0.32
    c.save()
    c.globalAlpha *= k
    c.translate(0, (1 - k) * 12)
    blockCard(c, x, y, cw, chh, 18)
    ring(c, x + 52, y + chh / 2, 30, R(P.lime, 0.9), 3)
    const initials = [...b.name].slice(0, 1).join('')
    txt(c, initials, x + 52, y + chh / 2 + 14, { size: 34, family: F.sans, weight: 900, color: R(P.lime, 1), align: 'center' })
    txt(c, b.name, x + 100, y + 58, { size: 34, family: F.sans, weight: 900, color: R(P.paper, 1) })
    txt(c, 'AUTHOR', x + 100, y + 92, { size: TY.blockSmall - 2, family: F.disp, weight: 700, color: R(P.ash, 0.9), spacing: 3 })
    c.restore()
    reg(x, y, cw, chh, 'block:avatar')
  }

  // ───────── 全屏字卡 / 结尾画中画 ─────────
  function cardShot(c, t, shot) {
    const b = (S.bigs || []).find(x => t >= x.f0 && t < x.f1)
    const page = pageAt(t)
    c.fillStyle = R(P.lime, 1)
    c.fillRect(0, 0, w, h)
    cornerTicks(c, M, M, w - M * 2, h - M * 2, 26, R(P.void, 0.30), 3)
    const text = b ? b.text : (page && page.title) || ''
    if (!text) return
    const lines = (b && b.lines && b.lines.length) ? b.lines : [text]
    const size = Math.min(TY.big + 56, Math.floor((w - M * 2) / Math.max(1, ...lines.map(l => textEm(l)))))
    const lh = size * 1.02
    const top = (h - lines.length * lh) / 2 - 40
    c.save()
    // 小字眉用页面标题（原话摘的），不是编出来的英文
    const eye = page && page.title ? page.title : 'WHY'
    txt(c, eye, M, top - 52, { size: TY.eyebrow + 2, family: F.disp, weight: 700, color: R(P.void, 0.52), spacing: 4 })
    line(c, M, top - 34, M + 56, top - 34, R(P.void, 0.35), 3)
    c.textBaseline = 'alphabetic'
    lines.forEach((ln, i) => {
      const at = (b ? b.f0 : t) + i * 0.12
      const k = E.outExpo(clamp(seg(t, at, at + 0.40)))
      c.globalAlpha = k
      c.fillStyle = R(P.void, 1)
      c.font = font(size, F.sans, 900)
      c.fillText(ln, M + (1 - k) * size * 0.12, top + i * lh + size * 0.88)
    })
    c.restore()
    reg(M, top - 60, w - M * 2, lh * lines.length + 80, 'big')
  }

  return {
    frames: S.frames,
    fps: S.fps,
    async prepare(f) {
      const i = srcIdx(f)
      await media.need([['person', i]])
      media.prefetch([['person', i + 1], ['person', i + 2]])
    },
    samples(f) {
      const t = f / S.fps
      const shot = shotAt(t)
      return shot && shot.f0 > t - 0.4 && shot.f0 <= t ? 1 : 0.5
    },
    draw(c, t, f) {
      const shot = shotAt(t)
      const img = media.frame('person', srcIdx(f))
      c.fillStyle = R(P.void, 1)
      c.fillRect(0, 0, w, h)
      if (shot.kind === 'card') cardShot(c, t, shot)
      else {
        drawPerson(c, img, shot)
        scrim(c, shot, t)
      }
      const onCard = shot.kind === 'card'
      const onOutro = shot.kind === 'outro'
      // 图形块压在大字下面，先画；色卡是纯字卡，上面不叠任何块
      if (!onCard) {
        for (const b of blockAt(t)) {
          if (b.kind === 'tagwall') tagWall(c, b, t)
          else if (b.kind === 'gauge') gauge(c, b, t)
          else if (b.kind === 'check') checkCard(c, b, t)
          else if (b.kind === 'banner' && !onOutro) banner(c, b, t)
          else if (b.kind === 'avatar') avatarCard(c, b, t)
        }
        if (!onOutro) {
          const act = (S.bigs || []).find(b => t >= b.f0 && t < b.f1)
          if (act) drawBig(c, act, t, shot)
        }
        chapterCard(c, t)
      }
      chrome(c, t, onCard)
      if (onCard) return
      if (onOutro) {
        const page = pageAt(t)
        if (page && page.title) {
          txt(c, 'END', M, h * 0.685, { size: TY.eyebrow, family: F.disp, weight: 700, color: R(P.lime, 0.9), spacing: 4 })
          const tsize = Math.min(64, Math.floor((w - M * 2) / Math.max(1, textEm(page.title))))
          txt(c, page.title, M, h * 0.685 + 68, { size: tsize, family: F.sans, weight: 900, color: R(P.paper, 1) })
        }
        return
      }
      drawSub(c, t)
    },
    cues: () => S.cues,
    post: () => ({ bloom: 0.20, grain: 0.020, vig: 0.30, ca: 0.8 }),
    qa() { const b = QA.boxes; QA.boxes = []; return { boxes: b, layout: { shots: (S.shots || []).length, pages: (S.pages || []).length } } },
  }
}
