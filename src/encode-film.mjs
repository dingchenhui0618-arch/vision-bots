/**
 * 分段编码：改一处，只重编那一小段，其余直接从上一版成片里流拷贝过来。
 *
 * 分段重渲只解决了「画面」，编码仍是整条重来——x264 编 17 秒竖屏要三十多秒，
 * 比渲染本身还贵。可成片是 h264，普通编码只在开头有一个关键帧，中间切不开。
 * 所以编码时就让关键帧落在固定帧栅格上（每 KEY_EVERY 帧一个 IDR），
 * 之后改到哪一段，就只把那一整格重编，前面和后面从上一版成片 -c copy 切出来拼回去。
 *
 * 用什么编不写死，由 src/encoder.mjs 决定（它会先验栅格、再验拼接，才让硬编进候选）。
 * 编码器 id 写进成片的 stream tag：换过编码器的上一版不许混着拼——SPS/PPS 不同，
 * 拼出来会花，宁可整条重编一次。
 *
 * 拼错比慢更糟，所以每一步都验：
 *   · 上一版成片在栅格位置上真的有关键帧，没有就整条重编（老片子、换过参数）
 *   · 上一版成片的编码器和这次一致，不一致就整条重编
 *   · 拼完总帧数必须等于 scene.frames，不对就报错，不交错位的片子
 *   · 拼完窗口外必须逐帧一致，不一致就整条重编（不交一条偷偷错位的片）
 */
import { writeFileSync, existsSync, copyFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  KEY_EVERY, countFrames, keyframePositions, frameHashes, concatCopy, cutCopy, seekCopy, seekEncode,
  videoArgs, resolveEncoder, readEncoderTag, plainName, tagOf, DEFAULT_ID,
} from './encoder.mjs'
import { ff } from './ffmpeg.mjs'

export { KEY_EVERY, countFrames }

/** mp4 的时间基：用 30 帧的整数倍，帧时间就落在整数 tick 上。 */
export function timescale(fps) {
  return Math.round(fps) * 512
}

/** 把改动窗口扩到整格：切点必须和关键帧对齐，多编几帧不算浪费。 */
export function expandWindow(dirty, frames, every = KEY_EVERY) {
  if (!dirty || dirty.all || dirty.none) return null
  const from = Math.max(0, Math.floor(dirty.from / every) * every)
  const to = Math.min(frames - 1, (Math.floor(dirty.to / every) + 1) * every - 1)
  return { from, to }
}

/**
 * 这一版成片能不能切：栅格要对，编码器也要是同一个。
 * 两件事缺一件就只能整条重编——宁可慢一次，不交一条拼歪的片。
 */
export async function gridIsCuttable(file, frames, fps, { every = KEY_EVERY, plan = null } = {}) {
  if (!existsSync(file)) return { ok: false, reason: '上一版成片不在了' }
  if (plan) {
    const tag = await readEncoderTag(file).catch(() => null)
    if (!tag) return { ok: false, reason: '上一版成片没记编码器（旧片），没法确认和这次的参数一致' }
    if (tag !== plan.tag) return { ok: false, reason: '上一版是「' + tag.replace(/^vision-bots\//, '') + '」编的，这版是「' + plan.id + '」，两套参数不混着拼' }
  }
  let keys
  let all
  try {
    const k = await keyframePositions(file, fps)
    keys = k.keys
    all = k.all
  } catch (e) {
    return { ok: false, reason: '上一版成片读不了（' + String(e.message || e).slice(0, 60) + '）' }
  }
  if (all.size !== frames) return { ok: false, reason: '上一版成片是 ' + all.size + ' 帧，不是 ' + frames + ' 帧' }
  const keySet = new Set(keys)
  const missing = []
  for (let i = 0; i < frames; i += every) if (!keySet.has(i)) missing.push(i)
  if (missing.length) return { ok: false, reason: '上一版成片第 ' + missing.slice(0, 3).join('/') + ' 帧不是关键帧' }
  return { ok: true, keyframes: keySet.size }
}

/** 整条重编：关键帧按栅格落下，给下一次改一句留切点。 */
async function encodeFull({ master, mixed, out, fps, plan }) {
  await ff(['-y', '-loglevel', 'error', '-i', master, '-i', mixed,
    '-map', '0:v', '-map', '1:a', ...videoArgs(plan),
    '-metadata:s:v:0', 'encoder=' + plan.tag,
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-video_track_timescale', String(timescale(fps)), out])
  return out
}

/**
 * 只重编 [from,to]：母版是 -g 1 的 FFV1，-ss 能精确到帧。
 * 关键帧参数必须和整条重编一致——不然拼出来的片子在栅格位置上没有关键帧，
 * 下次「改一句」就切不动了，只能整条重编（这条踩过）。
 */
async function encodePiece({ master, from, to, fps, out, plan }) {
  await ff(['-y', '-loglevel', 'error', '-ss', seekEncode(from, fps), '-i', master,
    '-frames:v', String(to - from + 1), '-an', ...videoArgs(plan, { piece: true }),
    '-metadata:s:v:0', 'encoder=' + plan.tag, out])
  return out
}

function firstLine(e) {
  const text = String((e && (e.stderr || e.message)) || e)
  return text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop().slice(0, 140)
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
 * @param encoder 指定编码器（测试用）；不给就按 src/encoder.mjs 的选型
 * @returns { encodeSeconds, mode, window, checks, frames, encoder }
 */
export async function encodeFilm({ master, mixed, out, frames, fps, dirty, log = () => {}, encoder = null }) {
  const plan = encoder || resolveEncoder()
  try {
    return await encodeOnce({ master, mixed, out, frames, fps, dirty, log, plan })
  } catch (e) {
    // 自检过了但真片编不动（分辨率、显存、驱动抽风）：退回软件编码重来一次，不交半成品
    if (plan.encoder === 'libx264') throw e
    const soft = resolveEncoder({ id: DEFAULT_ID })
    log(plainName(plan) + ' 这次编不动（' + firstLine(e) + '），退回 ' + plainName(soft) + ' 重来一次')
    return await encodeOnce({ master, mixed, out, frames, fps, dirty, log, plan: soft })
  }
}

async function encodeOnce({ master, mixed, out, frames, fps, dirty, log, plan }) {
  const enc = { id: plan.id, label: plainName(plan), tag: plan.tag, source: plan.source }
  // 画面一点没变：成片就是上一版，连编码都不用起
  if (dirty && dirty.none && existsSync(out)) {
    log('编码跳过：成片就是上一版')
    return { encodeSeconds: 0, mode: 'reuse', window: null, checks: null, frames: await countFrames(out), encoder: enc }
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
      checks = await gridIsCuttable(out, frames, fps, { plan })
      if (checks.ok) mode = 'splice'
      else log('整条重编：' + checks.reason)
    }

    if (mode === 'full') {
      await encodeFull({ master, mixed, out, fps, plan })
    } else {
      const { from, to } = window
      copyFileSync(out, prevCopy)
      const parts = []
      if (from > 0) {
        await cutCopy({ src: prevCopy, ss: null, frames: from, out: headOut })
        parts.push(headOut)
      }
      await encodePiece({ master, from, to, fps, out: pieceOut, plan })
      parts.push(pieceOut)
      if (to < frames - 1) {
        await cutCopy({ src: prevCopy, ss: seekCopy(to + 1, fps), frames: frames - 1 - to, out: tailOut })
        parts.push(tailOut)
      }
      const videoOnly = work + '-video.mkv'
      await concatCopy(parts, videoOnly)
      await ff(['-y', '-loglevel', 'error', '-i', videoOnly, '-i', mixed,
        '-map', '0:v', '-map', '1:a', '-c', 'copy',
        '-metadata:s:v:0', 'encoder=' + plan.tag,
        '-movflags', '+faststart', '-video_track_timescale', String(timescale(fps)), out])
      rmSync(videoOnly, { force: true })
      log('只重编第 ' + from + '–' + to + ' 帧（' + (to - from + 1) + '/' + frames + ' 帧），其余从上一版成片切出')

      // 拼完必须逐帧对得上：窗口外的画面是从上一版成片流拷贝过来的，一个像素都不该变。
      // 对不上说明切点或拼接出了偏差，宁可整条重编也不能交出去。
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
        await encodeFull({ master, mixed, out, fps, plan })
      }
    }

    const got = await countFrames(out)
    if (got !== frames) throw new Error('编码拼出来是 ' + got + ' 帧，应该是 ' + frames + ' 帧')
    const encodeSeconds = (Date.now() - t0) / 1000
    log('编码完成：' + encodeSeconds.toFixed(1) + 's（' + plan.label + '，'
      + (mode === 'splice' ? '只编 ' + (window.to - window.from + 1) + ' 帧' : '整条重编 ' + frames + ' 帧') + '）')
    return { encodeSeconds, mode, window, checks, frames: got, encoder: enc }
  } finally {
    // 排查用：KEEP_ENC_WORK=1 时保留中间文件（head / piece / tail / 拼接结果）
    if (!process.env.KEEP_ENC_WORK) await clean()
  }
}