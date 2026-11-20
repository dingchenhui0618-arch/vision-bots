/**
 * 逐帧渲染的分段缓存：改一句，只重渲那一句。
 *
 * 光轨一秒画面要渲三秒，60s 成片就是三分钟——但客户改的通常是一章里的一个词。
 * 每一帧都是 scene.json + 时间的纯函数，所以只要能算准「哪几帧的内容变了」，
 * 就能把没变的帧从上一版母版里原样切出来，只渲中间那一段，再无损拼回去。
 *
 * 判据分两类，宁可多重渲也不许拼错：
 *   · 有一帧可能受影响就整条重渲（画幅 / 帧率 / 时长 / EDL / 声波 / 配色 / HUD 文案 / 章节刻度 / 模板）
 *   · 只有某几章的大字或卡片变了，就只重渲它们的显示区间，其余从母版切
 */
import { createHash } from 'node:crypto'
import { writeFileSync, rmSync } from 'node:fs'
import { ff } from './ffmpeg.mjs'

/** 内容指纹：模板 / 引擎 / 声波 / scene 都靠它判断「还是不是同一版」 */
export function hashOf(...parts) {
  const h = createHash('sha256')
  for (const p of parts) h.update(typeof p === 'string' ? p : JSON.stringify(p))
  return h.digest('hex').slice(0, 16)
}

// 这些字段一变，每一帧都可能不一样，不做增量
const GLOBAL = ['template', 'ratio', 'size', 'fps', 'frames', 'duration', 'palette', 'labels', 'stats', 'person', 'marks', 'timeline']

/**
 * @param prev 上一版 { scene, hash, peaks } 或 null
 * @param next 这一版 { scene, hash, peaks }
 * @returns { mode: 'reuse' | 'patch' | 'full', from?, to?, reason }
 */
export function planPatch({ prev, next, fps }) {
  if (!prev) return { mode: 'full', reason: '还没有母版' }
  if (!next || !next.scene) return { mode: 'full', reason: '没有新 scene' }
  if (prev.hash !== next.hash) return { mode: 'full', reason: '模板或引擎变了' }
  if (prev.peaks !== next.peaks) return { mode: 'full', reason: '声波变了（音频一动，光轨整条都不一样）' }
  const a = prev.scene
  const b = next.scene
  for (const k of GLOBAL) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return { mode: 'full', reason: '全局字段变了：' + k }
  }

  const spans = []
  for (const key of ['bigs', 'beats']) {
    const x = a[key] || []
    const y = b[key] || []
    if (x.length !== y.length) return { mode: 'full', reason: key + ' 的条数变了' }
    for (let i = 0; i < x.length; i++) {
      if (JSON.stringify(x[i]) === JSON.stringify(y[i])) continue
      const f0 = Math.floor(Math.min(x[i].f0, y[i].f0) * fps) - 2 // 淡入留两帧余量
      const f1 = Math.ceil(Math.max(x[i].f1, y[i].f1) * fps) + 2
      spans.push([Math.max(0, f0), Math.min(b.frames - 1, f1)])
    }
  }
  if (!spans.length) return { mode: 'reuse', reason: '画面完全一样' }

  const from = Math.min(...spans.map(s => s[0]))
  const to = Math.max(...spans.map(s => s[1]))
  const pct = Math.round(((to - from + 1) / b.frames) * 100)
  if (pct > 45) return { mode: 'full', reason: '改动覆盖了 ' + pct + '% 的帧，不如整条重渲' }
  return { mode: 'patch', from, to, pct, reason: '第 ' + from + '–' + to + ' 帧（' + pct + '%）受影响' }
}

// 切母版走流拷贝，不重编码：FFV1 每帧都是关键帧，所以能精确到帧。
// 一开始用 trim 滤镜重编码，17s 的片子切两刀要 24s，比重新渲还贵。
async function sliceHead(src, out, count) {
  await ff(['-y', '-loglevel', 'error', '-i', src, '-frames:v', String(count), '-c', 'copy', out])
}

async function sliceTail(src, out, startFrame, count, fps) {
  if (count <= 0) return null
  await ff(['-y', '-loglevel', 'error', '-ss', (startFrame / fps).toFixed(6), '-i', src,
    '-frames:v', String(count), '-c', 'copy', out])
  return out
}

/**
 * 把「母版前半 + 新渲的一段 + 母版后半」拼成新母版。
 * 三段都是同一套 FFV1 参数，concat 走 -c copy，不重编码。
 */
export async function spliceMaster({ master, patch, from, to, frames, fps = 30, out, log = () => {} }) {
  const parts = []
  const tmpA = out + '.head.mkv'
  const tmpB = out + '.tail.mkv'
  try {
    if (from > 0) {
      await sliceHead(master, tmpA, from)
      parts.push(tmpA)
    }
    parts.push(patch)
    if (to < frames - 1) {
      await sliceTail(master, tmpB, to + 1, frames - 1 - to, fps)
      parts.push(tmpB)
    }
    const list = out + '.txt'
    writeFileSync(list, parts.map(p => "file '" + String(p).replace(/\\/g, '/') + "'").join('\n'), 'utf8')
    await ff(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
    rmSync(list, { force: true })
  } finally {
    rmSync(tmpA, { force: true })
    rmSync(tmpB, { force: true })
  }
  log('拼回母版：切 ' + (from > 0 ? from + ' 帧' : '0 帧') + ' + 新渲 ' + (to - from + 1) + ' 帧 + 切 ' + Math.max(0, frames - 1 - to) + ' 帧')
  return out
}
