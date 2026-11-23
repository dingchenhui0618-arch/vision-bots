/**
 * 画面审计：所有结论都从真实像素里量出来，不接受「模板说了它没问题」。
 *
 * 三件事：
 *   1. 人物在哪（时间中位背景板 + 运动差分）：头部区间必须能算出来，算不出来要报 unknown，不许静默放过。
 *   2. 文字读不读得出（渲染后成片里，文字盒内的背景亮度 vs 文字颜色，算 WCAG 对比度）。
 *   3. 盒子之间压不压（互相重叠、出安全区）。
 *
 * 坐标系：场景/成片坐标（1080×1920 这类）；素材到成片走 cover（scale 取大 + 居中裁）。
 */
import { ff } from './ffmpeg.mjs'

export const TEXT_COLOR = { bone: [0.945, 0.929, 0.894], signal: [1.0, 0.353, 0.122], ash: [0.545, 0.537, 0.514] }

export function luma([r, g, b]) {
  const f = v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

/** WCAG 对比度：1 到 21。 */
export function contrastRatio(a, b) {
  const la = luma(a), lb = luma(b)
  const hi = Math.max(la, lb), lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/** 素材 → 成片的坐标映射（和抽帧那条 ffmpeg 滤镜同一套：scale 增 + 居中裁）。 */
export function coverMap(src, out) {
  const scale = Math.max(out[0] / src[0], out[1] / src[1])
  const sw = src[0] * scale, sh = src[1] * scale
  return { scale, ox: (sw - out[0]) / 2, oy: (sh - out[1]) / 2, sw, sh }
}

export function srcRectToFilm(rect, { src, out }) {
  const m = coverMap(src, out)
  return {
    x: rect.x * src[0] * m.scale - m.ox,
    y: rect.y * src[1] * m.scale - m.oy,
    w: rect.w * src[0] * m.scale,
    h: rect.h * src[1] * m.scale,
  }
}

/** 抽若干成片帧，低分辨率 raw RGB（省内存，量对比度够用）。 */
export async function grabFilmFrames({ file, frames, size = [216, 384] }) {
  const list = [...new Set(frames)].sort((a, b) => a - b)
  if (!list.length) return []
  const sel = list.map(n => 'eq(n\\,' + n + ')').join('+')
  const { stdout } = await ff([
    '-v', 'error', '-i', file,
    '-vf', "select='" + sel + "',scale=" + size[0] + ':' + size[1],
    '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
  ], { encoding: 'buffer' })
  const bytes = size[0] * size[1] * 3
  const out = []
  for (let i = 0; i < list.length; i++) {
    const buf = stdout.subarray(i * bytes, (i + 1) * bytes)
    if (buf.length < bytes) break
    out.push({ frame: list[i], rgb: buf, w: size[0], h: size[1] })
  }
  return out
}

/** 从素材抽「一对」相邻帧（隔 gap 秒）：静止机位下，背景不动、人会动，这就是人的边界。 */
export async function grabSourcePairs({ input, times, gap = 0.25, size = [108, 192] }) {
  const out = []
  for (const t of times) {
    const pair = []
    for (const dt of [0, gap]) {
      const { stdout } = await ff([
        '-v', 'error', '-ss', (t + dt).toFixed(3), '-i', input, '-frames:v', '1',
        '-vf', 'scale=' + size[0] + ':' + size[1],
        '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-',
      ], { encoding: 'buffer' })
      if (stdout.length < size[0] * size[1] * 3) break
      pair.push({ rgb: stdout, w: size[0], h: size[1] })
    }
    if (pair.length === 2) out.push({ t, a: pair[0], b: pair[1] })
  }
  return out
}

/**
 * 人物头部区间（归一化 y）。只用运动，不用「和背景差」：
 * 正面口播是近景，人在画面里占一大半，时间中位背景板会被人的身体污染，反而把背景当成人。
 * 相邻两帧之间动的像素才是人（嘴、眼、手、身体微动）；背景（柔光箱、白板、桌子）是静的。
 * 判定不出就返回 ok:false —— 质检会因此判不通过，不会静默当成「没问题」。
 */
export function subjectBand(pairs, { diff = 0.07, rowCoverage = 0.04 } = {}) {
  if (!pairs || pairs.length < 4) return { ok: false, reason: '样帧太少（' + ((pairs && pairs.length) || 0) + '），算不出人物位置' }
  const { w, h } = pairs[0].a
  const n = w * h
  const rowAny = new Array(h).fill(0)
  const widthRows = new Array(h).fill(0)
  let moved = 0
  for (const p of pairs) {
    for (let y = 0; y < h; y++) {
      let hit = 0
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        // rgb24 是打包（交错）的：一个像素 3 个字节连着放，不是三个平面。
        // 以前按平面读（n+i / 2n+i），拿到的是 R 通道的远处像素，亮度算出来是垃圾。
        const k = i * 3
        const d = Math.max(
          Math.abs(p.a.rgb[k] - p.b.rgb[k]),
          Math.abs(p.a.rgb[k + 1] - p.b.rgb[k + 1]),
          Math.abs(p.a.rgb[k + 2] - p.b.rgb[k + 2]),
        ) / 255
        if (d > diff) hit++
      }
      widthRows[y] += hit / w
      if (hit / w >= rowCoverage) rowAny[y]++
      moved += hit
    }
  }
  for (let y = 0; y < h; y++) widthRows[y] /= pairs.length
  const coverage = moved / (n * pairs.length)
  // 过半样帧里都在动，才算这一行「有人」
  const rows = []
  for (let y = 0; y < h; y++) if (rowAny[y] >= Math.max(2, Math.round(pairs.length * 0.5))) rows.push(y)
  if (coverage < 0.005 || rows.length < 3) {
    return { ok: false, coverage: Number(coverage.toFixed(5)), reason: '画面里找不到可辨认的人（运动像素占比 ' + (coverage * 100).toFixed(2) + '%），可能是空镜、镜头会动或不是口播' }
  }
  const top = rows[0]
  const bottom = rows.at(-1)
  // 肩线：头顶的宽度很窄；往下某一行突然变宽（头→肩），那一行就是头底。
  const band = Math.max(4, Math.round((bottom - top) * 0.12))
  let topW = 0
  for (let y = top; y < Math.min(bottom, top + band); y++) topW = Math.max(topW, widthRows[y])
  const neckLine = Math.max(topW * 1.5, 0.18)
  let shoulder = null
  for (let y = top + 2; y <= bottom; y++) {
    if (widthRows[y] > neckLine) { shoulder = y; break }
  }
  const headBottom = shoulder ?? Math.min(bottom, top + Math.round((bottom - top) * 0.45))
  return {
    ok: true,
    coverage: Number(coverage.toFixed(4)),
    band: { top: Number((top / h).toFixed(4)), bottom: Number((headBottom / h).toFixed(4)) },
    subject: { top: Number((top / h).toFixed(4)), bottom: Number((bottom / h).toFixed(4)) },
    shoulder: shoulder !== null,
    pairs: pairs.length,
  }
}

/** 盒子在成片里量对比度：把接近文字颜色的像素当成字，其余当中背景。 */
export function boxContrast({ frames, box, color, fps }) {
  const per = []
  for (const f of frames) {
    const t = f.frame / fps
    if (t + 1e-6 < box.t0 || t - 1e-6 > box.t1) continue
    const x0 = Math.max(0, Math.round((box.x / (box.outW || 1)) * f.w))
    const x1 = Math.min(f.w - 1, Math.round(((box.x + box.w) / (box.outW || 1)) * f.w))
    const y0 = Math.max(0, Math.round((box.y / (box.outH || 1)) * f.h))
    const y1 = Math.min(f.h - 1, Math.round(((box.y + box.h) / (box.outH || 1)) * f.h))
    const n = f.w * f.h
    const target = luma(color)
    const bg = []
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * f.w + x
        const k = i * 3
        const l = luma([f.rgb[k] / 255, f.rgb[k + 1] / 255, f.rgb[k + 2] / 255])
        if (Math.abs(l - target) > 0.05) bg.push(l)
      }
    }
    if (bg.length < 12) continue
    bg.sort((a, b) => a - b)
    const p50 = bg[bg.length >> 1]
    per.push({ t: Number(t.toFixed(2)), bgLuma: Number(p50.toFixed(3)), ratio: Number(contrastRatio(color, [p50, p50, p50]).toFixed(2)) })
  }
  if (!per.length) return { ok: false, reason: '这个盒子在样帧里没有出现', samples: [] }
  const worst = per.reduce((a, b) => (a.ratio <= b.ratio ? a : b))
  return { ok: true, worst, samples: per }
}

export function rectOf(b) {
  return { x: b.x, y: b.y, w: b.w, h: b.h }
}

export function intersect(a, b) {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w), y2 = Math.min(a.y + a.h, b.y + b.h)
  if (x2 <= x || y2 <= y) return null
  return { x, y, w: x2 - x, h: y2 - y, area: (x2 - x) * (y2 - y) }
}

/** 盒子并集（同 tag 跨帧）。 */
export function unionBoxes(boxes) {
  const m = new Map()
  for (const b of boxes) {
    const cur = m.get(b.tag)
    if (!cur) { m.set(b.tag, { ...b, t0: b.t0 ?? 0, t1: b.t1 ?? 0, seen: 1 }); continue }
    const x = Math.min(cur.x, b.x), y = Math.min(cur.y, b.y)
    const x2 = Math.max(cur.x + cur.w, b.x + b.w), y2 = Math.max(cur.y + cur.h, b.y + b.h)
    cur.x = x; cur.y = y; cur.w = x2 - x; cur.h = y2 - y
    cur.t0 = Math.min(cur.t0, b.t0 ?? 0); cur.t1 = Math.max(cur.t1, b.t1 ?? 0)
    cur.seen++
  }
  return [...m.values()]
}