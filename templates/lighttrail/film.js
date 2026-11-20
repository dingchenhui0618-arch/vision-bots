// 光轨 · film —— 数据驱动的逐帧渲染器。每一帧都是 scene.json + 时间的纯函数。
// 画面里出现的每个数字都来自 scene.json（EDL、词级时间戳），这里不做任何内容判断。
import { setSize, W, H, TAU, C, F, rgba, clamp, lerp, seg, win, E, hash, txt, font, dot, ring,
  rrect, line, glowStroke, glowDot, cornerTicks } from '/engine/core.js'
import * as D from '/engine/devices.js'
import { loadJSON } from '/engine/media.js'

const GRADE = 'contrast(1.06) saturate(0.92) brightness(0.97)'
const FADE = 0.24
let FPS = 30

// 老工作目录里没有 template.json（模板是后加的）时，退回 3:4 那一套，别让片子渲染不出来。
const FALLBACK_34 = {
  size: [1080, 1440],
  rail: { y: 0.585, x: 60, right: 60, height: 88, bar: 4, gap: 3 },
  band: { top: 0.44 },
  big: { left: 72, right: 72, bottom: 104, lineGap: 1.12, size: 96, min: 56, lineChars: 7, maxLines: 3, align: 'alt' },
  label: { top: 44, side: 44, gap: 48, footer: 'bottom', inset: 44 },
}

export async function createFilm({ media }) {
  const S = await loadJSON('/project/scene.json')
  const PEAKS = await loadJSON('/project/peaks.json')
  const [w, h] = S.size
  FPS = S.fps
  setSize(w, h)

  // 画幅只决定布局：几何全部来自 template.json 的 layouts[ratio]，引擎里没有写死的坐标。
  // 换画幅 = 换一份布局，时间线和 scene.json 一个字不用动。
  let TPL = null
  try { TPL = await loadJSON('/project/template.json') } catch (e) { TPL = null }
  const L = (TPL && TPL.layouts && (TPL.layouts[S.ratio] || TPL.layouts[TPL.ratio])) || FALLBACK_34
  const RAIL = { y: L.rail.y * h, x: L.rail.x, w: w - L.rail.x - L.rail.right, h: L.rail.height, bar: L.rail.bar, gap: L.rail.gap }
  const BIG = L.big
  const LABEL = L.label
  const BAND_TOP = L.band.top * h    // 大字区间的遮罩起点
  media.register('person', { url: '/media/frames/person', count: S.person.count })

  // ── 成片帧 → 源帧（EDL 是唯一真相）──
  function srcIdx(f) {
    const R = S.person.ranges
    for (const r of R) {
      if (f >= r.outF0 && f < r.outF1) return r.srcF0 + Math.min(r.srcCount - 1, Math.round((f - r.outF0) * r.speed))
    }
    return Math.max(0, S.person.count - 1)
  }

  // ── 章节大字的排版：先定行，再由字宽定字号，整句不截断 ──
  const BIGTYPES = S.bigs.map((b, bi) => {
    let lineChars = BIG.lineChars
    // scene.json 带词边界（src/segment.mjs 分的词）；老 scene 没有就退回按字
    const parts = b.words && b.words.length ? b.words : [...b.text]
    let lines = splitLines(parts, lineChars)
    while (lines.length > BIG.maxLines && lineChars < 15) { lineChars += 2; lines = splitLines(parts, lineChars) }
    fixLineStart(lines)
    const cw = lines.map(l => [...l].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0))
    const longest = Math.max(1, ...cw)
    const availW = w - BIG.left - BIG.right
    const size = Math.max(BIG.min, Math.min(BIG.size, Math.floor(availW / longest)))
    // 3:4 左右交替（设计语言）；9:16 一律左对齐——竖屏右侧是平台按钮区，居右的大字会被压住
    const side = BIG.align === 'left' ? 'left' : (bi % 2 ? 'right' : 'left')
    return { ...b, lines, size, side }
  })

  const flatChars = (b) => b.chars || []

  // ── 光轨：点燃 → 扫描 → 变成声波基线 ──
  function rail(c, t, f, tf) {
    const y = RAIL.y
    const dur = S.duration
    const p = clamp(t / dur)
    const ignite = E.pro(clamp(seg(t, 0.10, 0.52)))
    const scan = seg(t, 0.52, 0.94)
    const tail = seg(t, dur - 0.55, dur - 0.05)

    // 线：从中心长到满幅
    if (ignite > 0 && tail < 1) {
      const half = (RAIL.w / 2) * ignite
      const cx = w / 2
      c.save()
      c.globalAlpha *= 1 - tail
      line(c, cx - half, y, cx + half, y, rgba('bone', 0.55), 2)
      // 点燃的光头
      if (ignite < 1) {
        glowDot(c, cx - half, y, 4, 'signal', 1)
        glowDot(c, cx + half, y, 4, 'signal', 1)
      }
      c.restore()
    }

    // 声波基线：走过的信号橙，没走过的骨白暗压
    if (t > 0.9) {
      const a = clamp(seg(t, 0.9, 1.4)) * (1 - E.inCubic(tail))
      c.save(); c.globalAlpha *= a
      D.waveform(c, PEAKS, {
        x: RAIL.x, y, w: RAIL.w, h: RAIL.h, tA: 0, tB: dur, tNow: Math.min(t, dur),
        p: 1, color: 'signal', dim: 0.26, bar: RAIL.bar, gap: RAIL.gap, gain: 1.6,
      })
      c.restore()
    }

    // 扫描：一条橙光从上往下扫一屏
    if (scan > 0 && scan < 1) {
      const sy = lerp(y, h * 0.98, E.inOutCubic(scan))
      c.save()
      c.globalAlpha *= 0.5 * (1 - seg(scan, 0.75, 1))
      line(c, 0, sy, w, sy, rgba('signal', 1), 3)
      c.globalCompositeOperation = 'lighter'
      line(c, 0, sy - 10, w, sy - 10, rgba('signal', 0.18), 22)
      c.restore()
    }

    // 每章一个齿：编辑时间线上的刻度
    S.marks.forEach((m) => {
      const x = RAIL.x + (m.t / dur) * RAIL.w
      const q = seg(t, m.t - 0.06, m.t + 0.12)
      if (q <= 0) return
      const live = t >= m.t && t < (S.marks[m.index] ? S.marks[m.index].t : dur)
      c.save(); c.globalAlpha *= q * (1 - tail * 0.6)
      line(c, x, y - 8, x, y + 8, live ? rgba('signal', 1) : rgba('bone', 0.45), 2)
      c.restore()
      if (live) txt(c, String(m.index).padStart(2, '0'), x + 7, y - RAIL.h / 2 - 14, { size: 20, family: F.mono, weight: 700, color: C.signal, alpha: q })
    })

    // 收尾：整条光收成一个点
    if (tail > 0) {
      const cx = w / 2
      const r = lerp(4, 2, tail)
      glowDot(c, cx, y, r * (1 + Math.sin(tail * Math.PI) * 0.9), 'signal', 1 - tail * 0.4)
    }
    return p
  }

  // ── 大字：整句上屏，按音节由灰翻白 ──
  function bigType(c, b, t) {
    if (t < b.f0 - 0.14 || t > b.f1 + FADE) return
    const appear = E.outCubic(clamp(seg(t, b.f0 - 0.14, b.f0 + 0.06)))
    const leave = E.inCubic(clamp(seg(t, b.f1, b.f1 + FADE)))
    const alpha = appear * (1 - leave)
    if (alpha <= 0.002) return

    const size = b.size
    const lh = size * BIG.lineGap
    const bottom = h - BIG.bottom
    const top = bottom - b.lines.length * lh
    c.save()
    c.globalAlpha *= alpha
    c.font = font(size, F.sans, 900)
    c.textBaseline = 'alphabetic'

    const chars = flatChars(b)
    let ci = 0
    b.lines.forEach((ln, li) => {
      const wLn = c.measureText(ln).width
      const x0 = b.side === 'right' ? w - BIG.right - wLn : BIG.left
      const kLine = E.outExpo(clamp(seg(t, b.f0 + li * 0.06, b.f0 + li * 0.06 + 0.28)))
      const dy = (1 - kLine) * size * 0.22
      const base = top + li * lh + size * 0.86 + dy
      let x = x0
      for (const ch of ln) {
        const cw = c.measureText(ch).width
        const meta = chars[ci]
        const lit = meta ? clamp((t - meta.f0) / Math.max(0.05, meta.f1 - meta.f0)) : 1
        const sayP = meta ? seg(t, meta.f0 - 0.02, meta.f0 + 0.10) : 1
        c.fillStyle = rgba('ash', 0.92 * lerp(0.55, 1, kLine))
        c.fillText(ch, x, base)
        if (lit > 0) {
          c.save()
          c.globalAlpha *= sayP
          c.fillStyle = C.bone
          c.fillText(ch, x, base)
          c.restore()
        }
        x += cw
        ci++
      }
    })
    c.restore()
  }

  // ── 标注：只放真实数字 ──
  // 页脚放哪由布局决定：3:4 在画面底部；9:16 移到顶部 HUD，因为竖屏底部 380px 归平台文案区。
  function labels(c, t) {
    const X = LABEL.side
    const TOP = LABEL.top
    const tc = timecode(t)
    txt(c, 'REC ' + tc, X, TOP, { size: 22, family: F.mono, weight: 600, color: rgba('bone', 0.7), spacing: 1 })
    dot(c, X - 14, TOP - 7, 5, rgba('signal', Math.floor(t * 2) % 2 ? 0.35 : 1))

    const cur = [...S.marks].reverse().find(m => t >= m.t) || S.marks[0]
    if (cur) {
      txt(c, String(cur.index).padStart(2, '0') + ' / ' + String(cur.total).padStart(2, '0'),
        w - X, TOP, { size: 22, family: F.mono, weight: 700, color: rgba('bone', 0.8), align: 'right', spacing: 1 })
    }

    const fy = LABEL.footer === 'top' ? TOP + LABEL.gap : h - LABEL.inset
    const a = win(t, 0.5, 4.2, 0.25, 0.3)
    if (a > 0) {
      const s = S.stats
      const str = '素材 ' + s.source.toFixed(1) + 's · 剪掉 ' + s.cut.toFixed(1) + 's · ' + s.segments + ' 段'
      txt(c, str, X, fy, { size: 22, family: F.mono, weight: 500, color: rgba('ash', 1), alpha: a, spacing: 0.5 })
    }
    txt(c, '光轨 / LIGHTTRAIL', w - X, fy, { size: 22, family: F.mono, weight: 500, color: rgba('ash', 0.8), align: 'right', spacing: 1 })
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
      // 大字区间的压光，保证任何画面上都读得清
      const g = c.createLinearGradient(0, BAND_TOP, 0, H)
      g.addColorStop(0, rgba('void', 0))
      g.addColorStop(0.35, rgba('void', 0.42))
      g.addColorStop(1, rgba('void', 0.82))
      c.fillStyle = g
      c.fillRect(0, BAND_TOP, W, H - BAND_TOP)

      BIGTYPES.forEach(b => bigType(c, b, t))
      rail(c, t, f, t)
      labels(c, t)
    },
    cues: () => S.cues,
    post: () => ({ bloom: 0.34, grain: 0.026, vig: 0.26, ca: 1.1 }),
    qa() { const b = D.QA.boxes; D.QA.boxes = []; return { boxes: b } },
  }
}

const chWidth = ch => (/[\x00-\xff]/.test(ch) ? 0.56 : 1)

// 行首禁则：和 src/segment.mjs 同一份字表。单字助词不许起行，并回上一行，
// 那一行最多宽一个字——字号本来就是按最长行算的，不会顶出画面。
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
    if (ww > lineChars + 0.01) { // 整词超宽（长英文 / 长数字）：只能硬切
      for (const ch of part) putChar(ch)
      continue
    }
    if (cur && w + ww > lineChars + 0.01) flush() // 词边界换行
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
