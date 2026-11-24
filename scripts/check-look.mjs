
/**
 * 量「成片像不像参考片」：只用像素，不解释观感。
 *
 *   node scripts/check-look.mjs --ours <成片.mp4> --ref <参考片.mp4>
 *   node scripts/check-look.mjs --ours ... --ref ... --json
 *
 * 为什么要有这一层：自测 11–16 改视觉都是凭抽帧眼看，改完也不知道离参考片近了还是远了。
 * 2026-11-25 先量了一遍才发现「我们的底压得比参考片更暗」——凭感觉改方向是反的。
 *
 * 量四样（都能从像素直接算，不猜）：
 *   · 平均亮度 meanY          —— 整体曝光
 *   · 亮度标准差 sdY          —— 画面亮度波动（全屏色卡会把这条拉飞）
 *   · 强调色占比 accent       —— 荧光绿/红/黄在画面里的面积份额
 *   · 切点密度 cuts/s         —— 版式变化率
 * 量不出来的明说量不出来：层次、构图、字重、留白、动画曲线。别拿这张表当观感结论。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FF = process.env.VISION_BOTS_FFMPEG || 'ffmpeg'
const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d
}
const OURS = arg('ours')
const REFLIST = argv.reduce((acc, a, i) => {
  if (a === '--ref' && argv[i + 1] && !argv[i + 1].startsWith('--')) for (const f of String(argv[i + 1]).split(',')) if (f.trim()) acc.push(f.trim())
  return acc
}, [])
const JSONOUT = Boolean(arg('json', false))
if (!OURS) {
  console.error('用法：node scripts/check-look.mjs --ours <成片.mp4> [--ref <参考片.mp4>]')
  process.exit(2)
}

// 分析分辨率：54×96 已经够算亮度/色块占比，又不至于让 2000 帧跑几分钟
const AW = 54
const AH = 96
// 调色板的强调色（和 template.json 的 palette 同源；换了模板要一起改）
const ACCENT = [
  [0xd8, 0xff, 0x3e], // lime
  [0xe2, 0x3a, 0x2c], // red
  [0xf5, 0xe1, 0x3c], // yellow
  [0x35, 0xe0, 0x7a], // green
]
const ACCENT_DIST = 62 // RGB 欧氏距离：抗一次重编码的色偏，又不把普通白/灰算进来

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,nb_frames,duration,r_frame_rate',
    '-of', 'json', file], { encoding: 'utf8', maxBuffer: 8 << 20 })
  const s = JSON.parse(out).streams[0]
  const [n, d] = String(s.r_frame_rate).split('/').map(Number)
  return { w: s.width, h: s.height, frames: Number(s.nb_frames) || 0, duration: Number(s.duration), fps: d ? n / d : 30 }
}

function stats(file) {
  const info = probe(file)
  const dir = mkdtempSync(join(tmpdir(), 'look-'))
  const raw = join(dir, 'a.raw')
  try {
    execFileSync(FF, ['-y', '-v', 'error', '-i', file, '-vf', 'scale=' + AW + ':' + AH + ':flags=area',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', raw], { maxBuffer: 1 << 28 })
    const buf = readFileSync(raw)
    const px = AW * AH
    const stride = px * 3
    const n = Math.floor(buf.length / stride)
    const lum = new Float64Array(n)
    const accent = new Float64Array(n)
    for (let f = 0; f < n; f++) {
      const o = f * stride
      let sy = 0
      let na = 0
      for (let p = 0; p < px; p++) {
        const i = o + p * 3
        const r = buf[i], g = buf[i + 1], b = buf[i + 2]
        sy += 0.2126 * r + 0.7152 * g + 0.0722 * b
        for (const [ar, ag, ab] of ACCENT) {
          const dr = r - ar, dg = g - ag, db = b - ab
          if (dr * dr + dg * dg + db * db <= ACCENT_DIST * ACCENT_DIST) { na++; break }
        }
      }
      lum[f] = sy / px
      accent[f] = na / px
    }
    const mean = a => a.reduce((s, x) => s + x, 0) / (a.length || 1)
    const meanL = mean(lum)
    const sd = Math.sqrt(mean(Array.from(lum, x => (x - meanL) ** 2)))
    // 切点：相邻帧降采样亮度差大就记一次，但**连续的几帧算一次**。
    // 自测17 这里数的是「超线的帧数」而不是「变化次数」：一次 3 帧的渐变算 3 个切点、
    // 一次 1 帧的硬切算 1 个。参考片的转场是渐变（3–6 帧），我们的是硬切，
    // 同一件事量出来差三倍——「切点密度 0.24/s vs 0.52–0.78/s」就是这么来的，
    // 差点为这个假差距去塞没用的切点。聚成事件后：我们 0.19/s，参考族 0.20–0.23/s。
    let cuts = 0
    let prevCut = -99
    for (let f = 1; f < n; f++) {
      if (Math.abs(lum[f] - lum[f - 1]) > 9) {
        if (f - prevCut > 1) cuts++
        prevCut = f
      }
    }
    const sorted = Array.from(lum).map((y, i) => ({ t: info.fps ? i / info.fps : i, y })).sort((a, b) => b.y - a.y)
    const accSorted = Array.from(accent).map((a, i) => ({ t: info.fps ? i / info.fps : i, a })).sort((x, y) => y.a - x.a)
    const accentMean = mean(accent)
    const accentMax = Math.max(...accent)
    return {
      file, w: info.w, h: info.h, frames: n, duration: info.duration, fps: info.fps,
      meanY: meanL, sdY: sd, accent: accentMean, accentMax,
      cuts, cutRate: n / Math.max(info.duration, 1e-6) ? cuts / info.duration : 0,
      brightest: sorted.slice(0, 5), darkest: sorted.slice(-3), accTop: accSorted.slice(0, 6),
      accHeavy: accSorted.filter(x => x.a > 0.2).length,
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录清不掉不算错 */ }
  }
}

const ours = stats(OURS)
const refs = []
for (const f of REFLIST) refs.push(stats(f))
const r1 = (x, k = 1) => Number(x.toFixed(k))
const pct = x => r1(x * 100, 2) + '%'

// 参考族：折光同一个人做的几支成片，档位不是一个点而是一段区间。
// 2026-11-25 先按单支参考 + 自设门槛判，结果「曝光差 −16 级」被判不在档——
// 回头量了折光另两支（成片2 145.1 / 成片3 66.9），才发现人家自己就横跨 78 级。
// 拿一支片子当尺子，量的其实是我自己的口味；拿一个族当尺子，才量得出「出了人家自己的范围没有」。
const band = key => refs.length ? { lo: Math.min(...refs.map(r => r[key])), hi: Math.max(...refs.map(r => r[key])) } : null
const lines = []
const push = s => lines.push(s)
const desc = (x, k = 1) => x

push('成片：' + ours.file)
push('  ' + ours.w + '×' + ours.h + '  ' + ours.frames + ' 帧  ' + r1(ours.duration, 2) + 's')
push('  平均亮度 ' + r1(ours.meanY) + '   亮度标准差 ' + r1(ours.sdY) + '   强调色占比 ' + pct(ours.accent) + '（峰值 ' + r1(ours.accentMax * 100, 1) + '%）   切点 ' + ours.cuts + '（' + r1(ours.cutRate) + '/s）')
push('')

const rows = []
if (refs.length) {
  push('参考族（' + refs.length + ' 支，折光自己的成片）：')
  for (const r of refs) push('  ' + r.file.split('\\').pop() + '  ' + r.w + '×' + r.h + '  ' + r1(r.duration, 2) + 's  亮度 ' + r1(r.meanY) + '  波动 ' + r1(r.sdY) + '  强调色 ' + pct(r.accent) + '  切点 ' + r1(r.cutRate) + '/s')
  push('')
  // 切点密度是「次数 / 时长」，一次事件的差别在 0.017/s 量级：11 次 vs 13 次不叫差距。
  // 其它三项是逐帧平均出来的连续量，没有这个问题。容差只给切点，且只给一次事件。
  const TOL = { cutRate: 1 / Math.max(ours.duration, 1e-6) }
  const checks = [
    ['meanY', '平均亮度', ours.meanY, x => String(r1(x)), x => String(r1(x))],
    ['sdY', '亮度波动', ours.sdY, x => String(r1(x)), x => String(r1(x))],
    ['accent', '强调色占比', ours.accent, x => pct(x), x => pct(x)],
    ['cutRate', '切点密度', ours.cutRate, x => r1(x, 2) + '/s', x => r1(x, 2) + '/s'],
  ]
  push('指标        成片        参考族区间              判定')
  for (const [key, label, val, fmt, rfmt] of checks) {
    const b = band(key)
    const tol = TOL[key] || 0
    const inBand = val >= b.lo - tol - 1e-9 && val <= b.hi + tol + 1e-9
    rows.push({ key, label, val, lo: b.lo, hi: b.hi, ok: inBand })
    const padLabel = label.padEnd(12 - [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 127 ? 1 : 0), 0))
    push(padLabel + '' + fmt(val).padEnd(12) + (rfmt(b.lo) + ' – ' + rfmt(b.hi)).padEnd(24) + (inBand ? '在档内' : (val < b.lo ? '低于参考族' : '高于参考族')))
  }
  push('')
  const bright = ours.brightest
  push('最亮的 3 帧：' + bright.slice(0, 3).map(b => r1(b.t, 2) + 's Y=' + r1(b.y)).join('   '))
  push('强调色最重的 3 帧：' + ours.accTop.slice(0, 3).map(b => r1(b.t, 2) + 's ' + r1(b.a * 100, 1) + '%').join('   ') + '（>20% 的帧 ' + ours.accHeavy + ' 个）')
  push('')
  push('结论：' + (rows.every(r => r.ok) ? '四项都落在折光自己三支成片的区间内' : '出了参考族区间的是：' + rows.filter(r => !r.ok).map(r => r.label).join('、')))
}

push('')
push('量不出来的（别拿这张表当观感结论）：层次与构图、字号字重、留白、动画曲线、元素是否在说人话。')
if (JSONOUT) console.log(JSON.stringify({ ours, refs, rows }, null, 2))
else console.log(lines.join('\n'))
