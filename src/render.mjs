import { writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ff, even } from './ffmpeg.mjs'

const SCRIM_STEPS = 32

/** 按保留区间切、拼、变速、烧字幕。全部一次 ffmpeg 完成，不落中间文件。 */
export async function renderCut({ input, plan, assText, out, hasAudio = true, size = null, crf = 18, layout = null }) {
  const speed = plan.options.speed
  const parts = []
  const ctx = []
  plan.keep.forEach(([a, b], i) => {
    parts.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=(PTS-STARTPTS)/${speed}[v${i}]`)
    if (hasAudio) parts.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,atempo=${speed.toFixed(3)}[a${i}]`)
    ctx.push(hasAudio ? `[v${i}][a${i}]` : `[v${i}]`)
  })
  parts.push(`${ctx.join('')}concat=n=${plan.keep.length}:v=1:a=${hasAudio ? 1 : 0}[vc]${hasAudio ? '[acc]' : ''}`)
  if (hasAudio) parts.push(`[acc]loudnorm=I=-14:TP=-1.5:LRA=11[ac]`)

  let vout = 'vc'
  if (layout) {
    // 模板构图：先铺底，再把人物按模板给的矩形贴上去（cover 裁切，不拉伸）
    const W = even(layout.width), H = even(layout.height)
    const r = layout.videoRect
    const vw = even(r.w), vh = even(r.h)
    parts.push(`[vc]scale=${vw}:${vh}:force_original_aspect_ratio=increase,crop=${vw}:${vh},setsar=1,format=yuv420p[vid]`)
    parts.push(`color=c=${layout.bg}:s=${W}x${H}:r=30[bg]`)
    parts.push(`[bg][vid]overlay=x=${r.x}:y=${r.y}:shortest=1[comp]`)
    vout = 'comp'
    if (layout.scrim) {
      const s = layout.scrim
      let i = 0
      // 一条渐变要拆成条带画：drawbox 只能铺纯色，整块铺会在遮罩下沿留一条硬边。
      const bands = (y0, h, aTop, aBottom) => {
        if (!h || h <= 0) return
        for (let k = 0; k < SCRIM_STEPS; k++) {
          const ya = Math.round(y0 + (h * k) / SCRIM_STEPS)
          const yb = Math.round(y0 + (h * (k + 1)) / SCRIM_STEPS)
          const a = aTop + (aBottom - aTop) * ((k + 0.5) / SCRIM_STEPS)
          if (yb <= ya || a <= 0.003) continue
          parts.push(`[${vout}]drawbox=x=0:y=${ya}:w=${W}:h=${yb - ya}:color=black@${a.toFixed(3)}:t=fill[sc${++i}]`)
          vout = `sc${i}`
        }
      }
      bands(0, s.top, s.topAlpha, 0)
      bands(H - s.bottom, s.bottom, 0, s.bottomAlpha)
    }
  } else if (size) {
    const [w, h] = size
    parts.push(`[vc]scale=${even(w)}:${even(h)}:force_original_aspect_ratio=decrease,pad=${even(w)}:${even(h)}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[vs]`)
    vout = 'vs'
  }

  const args = ['-y', '-loglevel', 'error', '-i', input]
  let assPath = null
  if (assText) {
    const assName = basename(out).replace(/\.\w+$/, '') + '.ass'
    assPath = join(dirname(out), assName)
    writeFileSync(assPath, assText, 'utf8')
    parts.push(`[${vout}]ass=${assName}[vf]`)
    vout = 'vf'
  }

  args.push('-filter_complex', parts.join(';'), '-map', `[${vout}]`)
  if (hasAudio) args.push('-map', '[ac]', '-c:a', 'aac', '-b:a', '192k')
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-r', '30', out)

  // ass 用相对路径，避开 Windows 下 filter 里转义盘符的坑
  await ff(args, { cwd: dirname(out) })
  return { out, segments: plan.keep.length, layout: layout ? 'template' : size ? 'fit' : 'native' }
}

export async function renderStill(input, time, out) {
  await ff(['-y', '-loglevel', 'error', '-ss', String(time), '-i', input, '-frames:v', '1', out])
  return out
}
