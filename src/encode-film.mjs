/**
 * 分段编码：改一处，只重编那一小段，其余直接从上一版成片里流拷贝过来。
 *
 * 分段重渲只解决了「画面」，编码仍是整条重来——x264 编 17 秒竖屏要三十多秒，
 * 比渲染本身还贵。可成片是 h264，普通编码只在开头有一个关键帧，中间切不开。
 * 所以编码时就让关键帧落在固定帧栅格上（每 KEY_EVERY 帧一个 IDR），
 * 之后改到哪一段，就只把那一整格重编，前面和后面从上一版成片 -c copy 切出来拼回去。
 *
 * 拼错比慢更糟，所以每一步都验：
 *   · 上一版成片在栅格位置上真的有关键帧，没有就整条重编（老片子、换过参数）
 *   · 拼完总帧数必须等于 scene.frames，不对就报错，不交错位的片子
 */
import { writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ff } from './ffmpeg.mjs'
import { FFPROBE, FFMPEG } from './env.mjs'

const run = promisify(execFile)

/** 关键帧栅格：每 32 帧一个 IDR（30fps 下 1.07 秒）。改一句通常落在两三格里。 */
export const KEY_EVERY = 32

/** 编码参数：改这里等于换一套成片，上一版的切点自然也不再可信。 */
export const VIDEO_ARGS = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p']

/**
 * mp4 的时间基：用 30 帧的整数倍，帧时间就落在整数 tick 上。
 * 用默认的毫秒时间基时 1/30 秒会被四舍五入，拼接时前一段的结尾和后一段的开头
 * 会撞在同一毫秒上，concat 于是把交界那一帧复制一遍（整条后面错一帧）。
 */
export function timescale(fps) {
  return Math.round(fps) * 512
}

/** 关键帧按帧数写死（keyint），不靠时间表达式：x264 的 keyint 是精确帧计数。 */
export function keyframeParams(every = KEY_EVERY) {
  return 'keyint=' + every + ':min-keyint=' + every + ':scenecut=0'
}

/** 把改动窗口扩到整格：切点必须和关键帧对齐，多编几帧不算浪费。 */
export function expandWindow(dirty, frames, every = KEY_EVERY) {
  if (!dirty || dirty.all || dirty.none) return null
  const from = Math.max(0, Math.floor(dirty.from / every) * every)
  const to = Math.min(frames - 1, (Math.floor(dirty.to / every) + 1) * every - 1)
  return { from, to }
}

/**
 * 这一版成片在栅格位置上是不是真的有关键帧——不对就别切。
 * mp4 的包是按解码顺序排的（B 帧），所以关键帧位置只能从 pts 换算成帧号，
 * 不能拿包序号当帧号。
 */
export async function gridIsCuttable(file, frames, fps, every = KEY_EVERY) {
  if (!existsSync(file)) return { ok: false, reason: '上一版成片不在了' }
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-show_packets', '-print_format', 'json', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const packets = (JSON.parse(stdout || '{}').packets) || []
  const keys = new Set()
  const all = new Set()
  for (const pk of packets) {
    if (pk.pts_time == null) continue
    const i = Math.round(Number(pk.pts_time) * fps)
    all.add(i)
    if (String(pk.flags || '').includes('K')) keys.add(i)
  }
  if (all.size !== frames) return { ok: false, reason: '上一版成片是 ' + all.size + ' 帧，不是 ' + frames + ' 帧' }
  const missing = []
  for (let i = 0; i < frames; i += every) if (!keys.has(i)) missing.push(i)
  if (missing.length) return { ok: false, reason: '上一版成片第 ' + missing.slice(0, 3).join('/') + ' 帧不是关键帧' }
  return { ok: true, keyframes: keys.size }
}

async function concatCopy(parts, out) {
  const list = out + '.txt'
  writeFileSync(list, parts.map(p => "file '" + resolve(String(p)).replace(/\\/g, '/') + "'").join('\n'), 'utf8')
  try {
    await ff(['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out])
  } finally {
    rmSync(list, { force: true })
  }
  return out
}

/**
 * 逐帧解码指纹（framemd5）。整条顺序解：带 seek 的抽帧在关键帧和 B 帧上会差一帧，
 * 拿来验对错会误报（踩过），顺序解虽然慢两三秒，但结论是确定的。
 */
async function frameHashes(file) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-i', file, '-an', '-f', 'framemd5', '-'], { encoding: 'utf8', maxBuffer: 512 << 20 })
  return String(stdout).trim().split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim())
}

/** 数帧数：读包头，不解码。mkv 的 nb_frames 不可信，所以统一走 nb_read_packets。 */
export async function countFrames(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-print_format', 'json', file], { encoding: 'utf8', maxBuffer: 64 << 20 })
  const streams = ((JSON.parse(stdout || '{}').streams) || [])
  return Number((streams[0] || {}).nb_read_packets || 0)
}

/**
 * 输入侧 -ss + 流拷贝：ffmpeg 会给到目标时间**之前最近的那个关键帧**，
 * 所以时间不能写 frame/fps——差 0.0007 秒就会退回到上一个关键帧（一整格，32 帧）。
 * 加半帧落在目标格里，才保证取到的是目标那一帧。
 */
function seekToFrame(frame, fps) {
  return ((frame + 0.5) / fps).toFixed(6)
}

/** 流拷贝切一段，帧数必须正好是 ints，多一帧少一帧都说明切点落错了。 */
async function cutCopy({ src, ss, frames, out }) {
  const args = ['-y', '-loglevel', 'error']
  if (ss != null) args.push('-ss', ss)
  args.push('-i', src, '-frames:v', String(frames), '-an', '-c', 'copy', out)
  await ff(args)
  const got = await countFrames(out)
  if (got !== frames) throw new Error('切出来是 ' + got + ' 帧，应该是 ' + frames + ' 帧：' + out)
  return out
}

/** 整条重编：关键帧按栅格落下，给下一次改一句留切点。 */
async function encodeFull({ master, mixed, out, frames, fps }) {
  await ff(['-y', '-loglevel', 'error', '-i', master, '-i', mixed,
    '-map', '0:v', '-map', '1:a', ...VIDEO_ARGS, '-x264-params', keyframeParams(),
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-video_track_timescale', String(timescale(fps)), out])
  return out
}

/**
 * 只重编 [from,to]：母版是 -g 1 的 FFV1，-ss 能精确到帧。
 * 关键帧参数必须和整条重编一致——不然拼出来的片子在栅格位置上没有关键帧，
 * 下次「改一句」就切不动了，只能整条重编（这条踩过）。
 */
async function encodePiece({ master, from, to, fps, out }) {
  // -bf 0：不用 B 帧，第一帧的 pts 才落在 0 上。带 B 帧时 pts 会从 1/30 起头，
  // concat 按「末帧 pts + 帧长」累计时长，会多算一帧，交界处就空出一格（踩过）。
  await ff(['-y', '-loglevel', 'error', '-ss', seekToFrame(from, fps), '-i', master,
    '-frames:v', String(to - from + 1), '-an', ...VIDEO_ARGS, '-x264-params', keyframeParams(), '-bf', '0',
    // 时间戳从 0 起：concat 按「末帧 pts + 帧长」累计时长，起头晚一帧就会在交界处空一格
    '-bsf:v', 'setts=pts=PTS-STARTPTS', out])
  return out
}

/**
 * 编码成片：能切就切，不能切就整条重编。
 *
 * @param master  无损母版
 * @param mixed   混好的音轨
 * @param out     成片路径（上一版就在这个路径上，切之前先挪开）
 * @param frames  总帧数
 * @param fps     帧率
 * @param dirty   { all: true } 或 { from, to }（帧号闭区间）
 * @returns { encodeSeconds, mode, window, checks }
 */
export async function encodeFilm({ master, mixed, out, frames, fps, dirty, log = () => {} }) {
  // 画面一点没变：成片就是上一版，连编码都不用起
  if (dirty && dirty.none && existsSync(out)) {
    log('编码跳过：成片就是上一版')
    return { encodeSeconds: 0, mode: 'reuse', window: null, checks: null, frames: await countFrames(out) }
  }
  const t0 = Date.now()
  const work = out + '.enc'
  const window = expandWindow(dirty, frames)
  const headOut = work + '-head.mkv'
  const tailOut = work + '-tail.mkv'
  const pieceOut = work + '-piece.mkv'
  const prevCopy = work + '-prev.mp4'
  const clean = async () => { for (const p of [headOut, tailOut, pieceOut, prevCopy]) rmSync(p, { force: true }) }

  try {
    let mode = 'full'
    let checks = null
    if (window) {
      checks = await gridIsCuttable(out, frames, fps)
      if (checks.ok) mode = 'splice'
      else log('整条重编：' + checks.reason)
    }

    if (mode === 'full') {
      await encodeFull({ master, mixed, out, frames, fps })
    } else {
      const { from, to } = window
      copyFileSync(out, prevCopy)
      const parts = []
      if (from > 0) {
        await cutCopy({ src: prevCopy, ss: null, frames: from, out: headOut })
        parts.push(headOut)
      }
      await encodePiece({ master, from, to, fps, out: pieceOut })
      parts.push(pieceOut)
      if (to < frames - 1) {
        await cutCopy({ src: prevCopy, ss: seekToFrame(to + 1, fps), frames: frames - 1 - to, out: tailOut })
        parts.push(tailOut)
      }
      const videoOnly = work + '-video.mkv'
      await concatCopy(parts, videoOnly)
      await ff(['-y', '-loglevel', 'error', '-i', videoOnly, '-i', mixed,
        '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', '-video_track_timescale', String(timescale(fps)), out])
      rmSync(videoOnly, { force: true })
      log('只重编第 ' + from + '–' + to + ' 帧（' + (to - from + 1) + '/' + frames + ' 帧），其余从上一版成片切出')

      // 拼完必须逐帧对得上：窗口外的画面是从上一版成片流拷贝过来的，一个像素都不该变。
      // 对不上说明切点或拼接出了偏差，宁可整条重编也不能交出去。
      // 这是拼接唯一的硬证据：两条各解一遍（并行），窗口外的画面必须逐帧等于上一版
      const bad = []
      const [a, b] = await Promise.all([frameHashes(prevCopy), frameHashes(out)])
      if (a.length !== frames || b.length !== frames) bad.push(-1)
      else for (let i = 0; i < frames; i++) {
        if (i >= from && i <= to) continue
        if (a[i] !== b[i]) { bad.push(i); break }
      }
      if (bad.length) {
        log('拼接校验没过（第 ' + bad.join('/') + ' 帧对不上），改为整条重编')
        mode = 'full'
        await encodeFull({ master, mixed, out, frames, fps })
      }
    }

    const got = await countFrames(out)
    if (got !== frames) throw new Error('编码拼出来是 ' + got + ' 帧，应该是 ' + frames + ' 帧')
    const encodeSeconds = (Date.now() - t0) / 1000
    log('编码完成：' + encodeSeconds.toFixed(1) + 's（' + (mode === 'splice' ? '只编 ' + (window.to - window.from + 1) + ' 帧' : '整条重编 ' + frames + ' 帧') + '）')
    return { encodeSeconds, mode, window, checks, frames: got }
  } finally {
    // 排查用：KEEP_ENC_WORK=1 时保留中间文件（head / piece / tail / 拼接结果）
    if (!process.env.KEEP_ENC_WORK) await clean()
  }
}