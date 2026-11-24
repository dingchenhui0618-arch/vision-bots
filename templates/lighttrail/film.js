// 光轨 · film —— 数据驱动的逐帧渲染器。每一帧都是 scene.json + 时间的纯函数。
// 画面里出现的每个数字都来自 scene.json（EDL、词级时间戳），这里不做任何内容判断。
//
// 2026-11-23 改版：真素材暴露了三个问题，一起改在这里——
//   1. 光轨横穿人脸：轨道位置现在按 scene.person.headBand（像素实测）自动往下让，让不开会在 scene.layout 里报冲突；
//   2. 顶部 HUD 白字打在白色天花板上：所有 HUD 一律加半透明深色 pill，可读性不靠画面亮度；
//   3. 一句一章抖字幕：大字跟着段落走（约 9 秒一段），一句话那一级交给底部字幕 pill。
import { setSize, W, H, TAU, C, F, rgba, clamp, lerp, seg, win, E, hash, txt, measure, font, dot, ring,
  rrect, pill, line, glowStroke, glowDot, cornerTicks } from '/engine/core.js'
import * as D from '/engine/devices.js'
import { loadJSON } from '/engine/media.js'

const { reg } = D
const GRADE = 'contrast(1.06) saturate(0.92) brightness(0.97)'
const FADE = 0.22
let FPS = 30

// 老工作目录里没有 template.json（模板是后加的）时，退回 3:4 那一套，别让片子渲染不出来。
const FALLBACK_34 = {
  size: [1080, 1440],
  rail: { y: 0.585, x: 56, right: 56, height: 66, bar: 3, gap: 3 },
  band: { top: 0.56 },
  big: { left: 64, right: 64, bottom: 340, lineGap: 1.08, size: 84, min: 52, lineChars: 6, maxLines: 2, align: 'alt' },
  sub: { bottom: 150, size: 44, padX: 38, padY: 20 },
  label: { top: 44, side: 44, gap: 40, footer: 'bottom', inset: 44 },
}

export async function createFilm({ media }) {
  const S = await loadJSON('/project/scene.json')
  const PEAKS = await loadJSON('/project/peaks.json')
  const [w, h] = S.size
  FPS = S.fps
  setSize(w, h)

  // 画幅只决定布局：几何全部来自 template.json 的 layouts[ratio]，引擎里没有写死的坐标。
  let TPL = null
  try { TPL = await loadJSON('/project/template.json') } catch (e) { TPL = null }
  const L = (TPL && TPL.layouts && (TPL.layouts[S.ratio] || TPL.layouts[TPL.ratio])) || FALLBACK_34
  const BIG = L.big
  const SUB = L.sub || { bottom: Math.round(h * 0.12), size: 44, padX: 38, padY: 20 }
  const LABEL = L.label
  const BAND_TOP = (L.band ? L.band.top : 0.6) * h
  media.register('person', { url: '/media/frames/person', count: S.person.count })

  // ── 轨道位置：按实测的人物头部让位 ──
  // headBand 由 src/frame-audit.mjs 在真素材像素上量出来（归一化 y）。没有它就不许瞎猜：
  // 轨道退回模板值，layout.conflict 记下「这一版没有让开人物」。
  const head = S.person && S.person.headBand && S.person.headBand.ok ? S.person.headBand : null
  const SUB_H = Math.round(SUB.size * 1.18) + SUB.padY * 2
  const SUB_TOP = h - SUB.bottom - SUB_H
  let RAIL_Y = L.rail.y * h
  if (head) RAIL_Y = Math.max(RAIL_Y, head.bottom * h + h * 0.045)
  let conflict = null
  const RAIL_CEIL = SUB_TOP - L.rail.height - 24
  if (RAIL_Y > RAIL_CEIL) {
    // 让不开：人物太大，下巴下面没有放轨道的地方。往下压到字幕上沿，并如实记账。
    RAIL_Y = RAIL_CEIL
    if (head && RAIL_Y < head.bottom * h) conflict = '人物头部到 ' + (head.bottom * 100).toFixed(0) + '% 高度，轨道压到 ' + (RAIL_Y / h * 100).toFixed(0) + '% 仍然避不开'
  }
  const RAIL = { y: RAIL_Y, x: L.rail.x, w: w - L.rail.x - L.rail.right, h: L.rail.height, bar: L.rail.bar, gap: L.rail.gap }
  const BIG_BOTTOM = RAIL_Y - 44
  // 渲染完让质检能读到这版几何：轨道在哪、有没有避开人、标记在哪
  S.layout = { railY: Math.round(RAIL_Y), subTop: Math.round(SUB_TOP), bigBottom: Math.round(BIG_BOTTOM), conflict, headBand: head ? head.band : null }

  // ── 成片帧 → 源帧（EDL 是唯一真相）──
  function srcIdx(f) {
    const R = S.person.ranges
    for (const r of R) {
      if (f >= r.outF0 && f < r.outF1) return r.srcF0 + Math.min(r.srcCount - 1, Math.round((f - r.outF0) * r.speed))
    }
    return Math.max(0, S.person.count - 1)
  }

  // ── 段落大字的排版：先定行，再由字宽定字号，整句不截断 ──
  const BIGTYPES = S.bigs.map((b, bi) => {
    // 断行由数据层算好（src/segment.mjs，和 PPT 底座同一套规则）；没有才回落到本地切
    let lines
    if (Array.isArray(b.lines) && b.lines.length) {
      lines = b.lines.slice()
    } else {
      let lineChars = BIG.lineChars
      const parts = b.words && b.words.length ? b.words : [...b.text]
      lines = splitLines(parts, lineChars)
      while (lines.length > BIG.maxLines && lineChars < 15) { lineChars += 1; lines = splitLines(parts, lineChars) }
      fixLineStart(lines)
    }
    const cw = lines.map(l => [...l].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0))
    const longest = Math.max(1, ...cw)
    const availW = w - BIG.left - BIG.right
    const size = Math.max(BIG.min, Math.min(BIG.size, Math.floor(availW / longest)))
    const side = BIG.align === 'left' ? 'left' : (bi % 2 ? 'right' : 'left')
    return { ...b, lines, size, side }
  })

  // ── 光轨：点燃 → 扫描 → 变成声波基线 ──
  function rail(c, t) {
    const y = RAIL.y
    const dur = S.duration
    const ignite = E.pro(clamp(seg(t, 0.10, 0.52)))
    const scan = seg(t, 0.52, 0.94)
    const tail = seg(t, dur - 0.55, dur - 0.05)

    if (ignite > 0 && tail < 1) {
      const half = (RAIL.w / 2) * ignite
      const cx = w / 2
      c.save()
      c.globalAlpha *= 1 - tail
      line(c, cx - half, y, cx + half, y, rgba('bone', 0.5), 2)
      if (ignite < 1) {
        glowDot(c, cx - half, y, 4, 'signal', 1)
        glowDot(c, cx + half, y, 4, 'signal', 1)
      }
      c.restore()
    }

    if (t > 0.9) {
      const a = clamp(seg(t, 0.9, 1.4)) * (1 - E.inCubic(tail))
      c.save(); c.globalAlpha *= a
      // 轨道背后垫一层暗：橙线直接压在浅色衣服上时对比不够（质检从像素里量出 2.1:1）
      c.save()
      c.globalAlpha *= a * 0.5
      pill(c, w / 2, y, RAIL.w + 32, RAIL.h + 18, rgba('void', 0.90))
      c.restore()
      D.waveform(c, PEAKS, {
        x: RAIL.x, y, w: RAIL.w, h: RAIL.h, tA: 0, tB: dur, tNow: Math.min(t, dur),
        p: 1, color: 'signal', dim: 0.3, bar: RAIL.bar, gap: RAIL.gap, gain: 1.5,
      })
      c.restore()
      reg(RAIL.x, y - RAIL.h / 2, RAIL.w, RAIL.h, 'rail')
    }

    if (scan > 0 && scan < 1) {
      const sy = lerp(y, h * 0.98, E.inOutCubic(scan))
      c.save()
      c.globalAlpha *= 0.4 * (1 - seg(scan, 0.75, 1))
      line(c, 0, sy, w, sy, rgba('signal', 1), 2)
      c.restore()
    }

    // 每段一个齿：段落刻度，不再是「每句一个」
    S.marks.forEach((m) => {
      const x = RAIL.x + (m.t / dur) * RAIL.w
      const q = seg(t, m.t - 0.06, m.t + 0.12)
      if (q <= 0) return
      const live = t >= m.t && t < (S.marks[m.index] ? S.marks[m.index].t : dur)
      c.save(); c.globalAlpha *= q * (1 - tail * 0.6)
      line(c, x, y - 7, x, y + 7, live ? rgba('signal', 1) : rgba('bone', 0.4), 2)
      c.restore()
      if (live) txt(c, String(m.index).padStart(2, '0'), x + 6, y - RAIL.h / 2 - 10, { size: 18, family: F.mono, weight: 700, color: C.signal, alpha: q })
    })

    if (tail > 0) {
      const cx = w / 2
      const r = lerp(4, 2, tail)
      glowDot(c, cx, y, r * (1 + Math.sin(tail * Math.PI) * 0.9), 'signal', 1 - tail * 0.4)
    }
  }

  // ── 大字：一句一条，区间就是那张字幕卡的区间（2026-11-24 起跟着口播换）──
  // 同一时刻只画一条：相邻两条各自淡入会在同一基线上叠成两行假标题（"如果你也是"+"捡内容生产力"）
  function bigType(c, b, t) {
    // 大字跟着口播换：到了这一句开口的那一刻就换上去，不做淡入。
    // 淡入要在句首前 0.12s 起画，上一句的大字还没撤——两张叠在一起正是以前修掉的那个 bug
    // （「一句话在屏幕上出现两次」）。换字本身是硬切，和底部字幕 pill 同一种节奏。
    if (t < b.f0 || t >= b.f1) return
    const alpha = 1

    const size = b.size
    const lh = size * BIG.lineGap
    const top = BIG_BOTTOM - b.lines.length * lh
    c.save()
    c.globalAlpha *= alpha
    c.font = font(size, F.sans, 900)
    c.textBaseline = 'alphabetic'
    // 大字直接压在实拍上：先给一层柔和的暗影托底，再保证读得清（质检会从成片像素里量对比度）
    c.shadowColor = rgba('void', 0.72)
    c.shadowBlur = 26
    c.shadowOffsetY = 6
    b.lines.forEach((ln, li) => {
      const wLn = c.measureText(ln).width
      const x0 = b.side === 'right' ? w - BIG.right - wLn : BIG.left
      const kLine = E.outExpo(clamp(seg(t, b.f0 + li * 0.05, b.f0 + li * 0.05 + 0.3)))
      const dy = (1 - kLine) * size * 0.22
      const base = top + li * lh + size * 0.86 + dy
      c.fillStyle = C.bone
      c.globalAlpha = alpha * (0.35 + 0.65 * kLine)
      c.fillText(ln, x0, base)
    })
    c.restore()
    if (b.side === 'right') reg(w - BIG.right - size * 4, top + size * 0.1, size * 4, b.lines.length * lh, 'big')
    else reg(BIG.left, top + size * 0.1, Math.max(size * 3, Math.min(w - BIG.left - BIG.right, size * b.lines[0].length)), b.lines.length * lh, 'big')
  }

  // ── 字幕：一句话一张，压在底部 pill 里，可读性由 pill 保证 ──
  // 同一时刻只画一张：字幕卡首尾相接，交叉淡入会让两张叠在一起（实测糊成「圈真正的机会…」）
  function subline(c, t) {
    const idx = S.subs.findIndex(s => t >= s.f0 && t < s.f1)
    const cur = idx >= 0 ? S.subs[idx] : null
    if (!cur) return
    const first = idx === 0 ? 1 - seg(t, cur.f0, cur.f0 + 0.12) : 1
    const last = idx === S.subs.length - 1 ? 1 - seg(t, cur.f1 - 0.12, cur.f1) : 1
    const a = Math.min(first, last)
    if (a <= 0.01) return
    // 和这一段的大字重复时不画：一段话在屏幕上只出现一次，别一句变两句
    const curBig = BIGTYPES.find(b => t >= b.f0 && t < b.f1)
    if (curBig && sameText(cur.text, curBig.text)) return
    const size = SUB.size
    const pw = Math.min(w - 48, Math.round(textEm(cur.text) * size + SUB.padX * 2))
    const ph = Math.round(size * 1.18) + SUB.padY * 2
    const cx = w / 2
    const cy = h - SUB.bottom - ph / 2
    c.save(); c.globalAlpha *= a
    pill(c, cx, cy, pw, ph, rgba('void', 0.90))
    txt(c, cur.text, cx, cy + size * 0.36, { size, family: F.sans, weight: 700, color: C.bone, align: 'center' })
    c.restore()
    reg(cx - pw / 2, cy - ph / 2, pw, ph, 'sub')
  }

  // ── HUD：只放真实数字，一律带 pill 底 ──
  function hud(c, t) {
    const X = LABEL.side
    const TOP = LABEL.top
    const tc = timecode(t)
    const size = 22
    // 左：REC + 时间码
    const left = 'REC ' + tc
    const lw = Math.round(textEm(left) * size + 34)
    pill(c, X + lw / 2 - 8, TOP + 4, lw, 44, rgba('void', 0.90))
    dot(c, X + 8, TOP + 4, 5, rgba('signal', Math.floor(t * 2) % 2 ? 0.4 : 1))
    txt(c, left, X + 22, TOP + 11, { size, family: F.mono, weight: 600, color: rgba('bone', 0.92), spacing: 1 })
    reg(X - 16, TOP - 18, lw + 22, 60, 'hud:rec')

    // 右：段落计数
    const cur = [...S.marks].reverse().find(m => t >= m.t) || S.marks[0]
    if (cur) {
      const right = String(cur.index).padStart(2, '0') + ' / ' + String(cur.total).padStart(2, '0')
      const rw = Math.round(textEm(right) * size + 32)
      pill(c, w - X - rw / 2 + 8, TOP + 4, rw, 44, rgba('void', 0.90))
      txt(c, right, w - X - 8, TOP + 11, { size, family: F.mono, weight: 700, color: rgba('bone', 0.92), align: 'right', spacing: 1 })
      reg(w - X - rw - 8, TOP - 18, rw + 22, 60, 'hud:sec')
    }
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
      return BIGTYPES.some(b => f / S.fps >= b.f0 - 0.1 && f / S.fps <= b.f0 + 0.35) ? 1 : 0.5
    },
    draw(c, t, f) {
      const img = media.frame('person', srcIdx(f))
      c.fillStyle = C.void
      c.fillRect(0, 0, W, H)
      if (img) {
        c.save(); c.filter = GRADE
        c.drawImage(img, 0, 0, W, H)
        c.restore()
      }
      // 大字区间的压光：只压到段落大字和轨道这一带，底部留给字幕 pill
      const g = c.createLinearGradient(0, BAND_TOP, 0, h)
      g.addColorStop(0, rgba('void', 0))
      g.addColorStop(0.45, rgba('void', 0.34))
      g.addColorStop(1, rgba('void', 0.5))
      c.fillStyle = g
      c.fillRect(0, BAND_TOP, W, h - BAND_TOP)

      // 只画当前这一段：forEach 会让上一段的收尾和下一段的起势在同一基线上叠成两行（实测踩到）
      const act = BIGTYPES.find(b => t >= b.f0 - 0.12 && t < b.f1)
      if (act) bigType(c, act, t)
      rail(c, t)
      subline(c, t)
      hud(c, t)
    },
    cues: () => S.cues,
    post: () => ({ bloom: 0.34, grain: 0.026, vig: 0.26, ca: 1.1 }),
    // 质检要读两样东西：这一帧画了哪些盒子（供量对比度/压没压人），以及这版几何（轨道在哪、有没有让开人物）
    qa() { const b = D.QA.boxes; D.QA.boxes = []; return { boxes: b, layout: S.layout } },
  }
}

// 字宽口径：中文 1em、ASCII 0.56em。画 pill 和算盒子用同一个公式，盒子才和画面对得上
const chWidth = ch => (/[\x00-\xff]/.test(ch) ? 0.56 : 1)
const textEm = str => [...String(str)].reduce((n, ch) => n + chWidth(ch), 0)

/**
 * 两句是不是同一句（字幕和大字撞车时用；只比字，不改写）。
 * 只认「完全一样」：现在大字是这一句的压缩词，几乎总是这句字幕的子串，
 * 按「包含」判撞车会把正常句子的字幕整条吞掉（2026-11-24 改成句级大字后实测）。
 */
function sameText(a, b) {
  const norm = x => String(x || '').replace(/[\s，。！？、；：,.!?;:""''…—~·]/g, '')
  const A = norm(a), B = norm(b)
  return Boolean(A && B && A === B)
}

// 行首禁则：和 src/segment.mjs 同一份字表。单字助词不许起行，并回上一行。
const NO_LINE_START = '的了着过吧呢吗啊呀嘛地得'
function fixLineStart(lines) {
  for (let i = 1; i < lines.length; i++) {
    let moved = 0
    while (moved < 2 && lines[i].length > 1 && NO_LINE_START.includes(lines[i][0])) {
      lines[i - 1] += lines[i][0]
      lines[i] = lines[i].slice(1)
      moved++
    }
  }
  return lines
}

/** 按词断行：断点只在词边界上，词本身比一行还宽时才逐字切。 */
function splitLines(parts, lineChars) {
  const lines = []
  let cur = ''
  let w = 0
  const flush = () => { if (cur) lines.push(cur); cur = ''; w = 0 }
  const putChar = ch => {
    const cw = chWidth(ch)
    if (cur && w + cw > lineChars + 0.01) flush()
    cur += ch
    w += cw
  }
  for (const part of parts) {
    let ww = 0
    for (const ch of part) ww += chWidth(ch)
    if (ww > lineChars + 0.01) {
      for (const ch of part) putChar(ch)
      continue
    }
    if (cur && w + ww > lineChars + 0.01) flush()
    cur += part
    w += ww
  }
  flush()
  return lines
}

function timecode(t) {
  const fr = Math.floor(t * FPS)
  const h = Math.floor(fr / (FPS * 3600))
  const m = Math.floor(fr % (FPS * 3600) / (FPS * 60))
  const s = Math.floor(fr % (FPS * 60) / FPS)
  const f = fr % FPS
  const p = n => String(n).padStart(2, '0')
  return p(h) + ':' + p(m) + ':' + p(s) + ':' + p(f)
}
