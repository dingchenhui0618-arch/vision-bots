/**
 * 编码器：把「用什么编」从写死的 libx264 变成有证据的选择。
 *
 * 一个编码器要能用，三件事必须同时成立，少一件都不行：
 *   ① 编得出来——驱动、硬件真的在（ffmpeg -encoders 列出来 ≠ 能用）
 *   ② 关键帧落在固定帧栅格上——改一句时的切点靠它
 *   ③ 切出来能拼回去——窗口外的帧必须逐帧一致，否则改一句会悄悄错位
 * 只有三条都过的编码器才进候选池。dsm doctor 会把每个候选的结论、失败原因和实测
 * 速度／体积打出来，换机器一条命令就能重测。
 *
 * 默认 x264 veryfast 不是「软件编码兜底」，是实测选出来的。同一母版、1080×1920、
 * 17 秒、511 帧（栅格参数一致）：
 *
 *   编码器                耗时     体积       PSNR
 *   x264 medium          32.1s   17.49MB   39.76
 *   x264 fast            26.4s   17.64MB   39.93
 *   x264 veryfast        19.1s   17.38MB   39.69
 *   QuickSync slow/gq22  17.9s   32.21MB   39.76
 *   QuickSync med/gq20   18.3s   39.99MB   39.94
 *
 * 硬编没赢：同观感下体积 1.8–2.3 倍，最快的也只比 veryfast 快 1.2 秒。这是「大字 +
 * 纯色底」这类内容的结论，真实口播素材接进来要重测——不是因为它可能翻盘就不测，
 * 而是因为 dsm doctor 让重测只要一条命令。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FFMPEG, FFPROBE } from './env.mjs'

const run = promisify(execFile)
const MAXBUF = 256 << 20

/** 关键帧栅格：每 32 帧一个 IDR（30fps 下 1.07 秒）。改一句通常落在两三格里。 */
export const KEY_EVERY = 32

/** 质量档位：x264 的 crf 数，其它编码器按自己的名字映射过去（见 videoArgs）。 */
export const DEFAULT_CRF = 20

/** 契约自检用的小样：96 帧 = 正好三格，能验出全部栅格位置。 */
const PROBE_FRAMES = 96
const PROBE_FPS = 30
const PROBE_SIZE = '256x144'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

export function ff(args) {
  return run(FFMPEG, args, { maxBuffer: MAXBUF })
}

const LABELS = {
  h264_qsv: 'QuickSync（Intel 硬编）',
  h264_nvenc: 'NVENC（NVIDIA 硬编）',
  h264_amf: 'AMF（AMD 硬编）',
  h264_videotoolbox: 'VideoToolbox（Apple 硬编）',
  'libx264/veryfast': 'x264 veryfast（软编）',
  'libx264/fast': 'x264 fast（软编）',
  'libx264/medium': 'x264 medium（软编）',
}

/**
 * 候选表，顺序即优先级（同分时靠前的赢）。
 * 软编放最后但一定在：硬编全挂的机器也得能出片。
 */
export function candidates(platform = process.platform) {
  const hw =
    platform === 'darwin' ? ['h264_videotoolbox']
    : platform === 'win32' ? ['h264_qsv', 'h264_nvenc', 'h264_amf']
    : ['h264_nvenc']
  const list = hw.map(id => ({ id, encoder: id, preset: null }))
  for (const preset of ['veryfast', 'fast', 'medium']) list.push({ id: 'libx264/' + preset, encoder: 'libx264', preset })
  return list.map(c => ({ ...c, label: LABELS[c.id] || c.id }))
}

export const DEFAULT_ID = 'libx264/veryfast'

export function candidateById(id, platform = process.platform) {
  return candidates(platform).find(c => c.id === id) || null
}

/** 成片里记下是谁编的：换编码器之后不许混着拼（SPS/PPS 不同，拼出来会花）。 */
export function tagOf(cand) {
  return 'vision-bots/' + cand.id
}

/**
 * 视频编码参数。栅格参数必须每个编码器都显式给，不能靠默认值：
 * x264 用 -x264-params，硬编用 -g/-keyint_min，NVENC 还要 -forced-idr（不然给的是
 * 非 IDR 的 I 帧，流拷贝拼接会坏）。
 * every <= 0 表示不要栅格（纯字幕／PPT 底座那种整条重编、不拼接的路径）。
 */
export function videoArgs(cand, { crf = DEFAULT_CRF, every = KEY_EVERY, piece = false } = {}) {
  const grid = every > 0
  const a = ['-c:v', cand.encoder]
  if (cand.encoder === 'libx264') {
    a.push('-preset', cand.preset || 'veryfast', '-crf', String(crf), '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p')
    if (grid) a.push('-x264-params', 'keyint=' + every + ':min-keyint=' + every + ':scenecut=0')
  } else if (cand.encoder === 'h264_qsv') {
    a.push('-preset', 'medium', '-global_quality', String(crf), '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'nv12')
    if (grid) a.push('-g', String(every), '-keyint_min', String(every), '-sc_threshold', '0')
  } else if (cand.encoder === 'h264_nvenc') {
    a.push('-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p')
    if (grid) a.push('-g', String(every), '-keyint_min', String(every), '-no-scenecut', '1', '-forced-idr', '1')
  } else if (cand.encoder === 'h264_amf') {
    a.push('-quality', 'balanced', '-rc', 'vbr_peak', '-qp_i', String(crf), '-qp_p', String(crf + 2), '-b:v', '8M', '-maxrate', '8M', '-pix_fmt', 'yuv420p')
    if (grid) a.push('-g', String(every), '-keyint_min', String(every))
  } else if (cand.encoder === 'h264_videotoolbox') {
    a.push('-b:v', '8M', '-maxrate', '8M', '-pix_fmt', 'yuv420p')
    if (grid) a.push('-g', String(every), '-keyint_min', String(every))
  } else {
    throw new Error('不认识的编码器：' + cand.encoder)
  }
  if (piece) {
    // -bf 0：不用 B 帧，第一帧的 pts 才落在 0 上（带 B 帧时 concat 会在交界空一格）
    a.push('-bf', '0')
    // 时间戳从 0 起：concat 按「末帧 pts + 帧长」累计时长，起头晚一帧就会空一格
    a.push('-bsf:v', 'setts=pts=PTS-STARTPTS')
  }
  return a
}

/* ── 数帧、关键帧、逐帧指纹、流拷贝切片：拼接的全部证据链 ───────────────── */

/** 数帧数：读包头，不解码。mkv 的 nb_frames 不可信，所以统一走 nb_read_packets。 */
export async function countFrames(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets',
    '-show_entries', 'stream=nb_read_packets', '-print_format', 'json', file], { encoding: 'utf8', maxBuffer: MAXBUF })
  const streams = ((JSON.parse(stdout || '{}').streams) || [])
  return Number((streams[0] || {}).nb_read_packets || 0)
}

/**
 * 关键帧落在哪几帧。mp4 的包按解码顺序排（B 帧），所以位置只能从 pts 换算成帧号，
 * 不能拿包序号当帧号。
 */
export async function keyframePositions(file, fps) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,flags', '-show_packets', '-print_format', 'json', file],
    { encoding: 'utf8', maxBuffer: 64 << 20 })
  const packets = (JSON.parse(stdout || '{}').packets) || []
  const keys = new Set()
  const all = new Set()
  for (const pk of packets) {
    if (pk.pts_time == null) continue
    const i = Math.round(Number(pk.pts_time) * fps)
    all.add(i)
    if (String(pk.flags || '').includes('K')) keys.add(i)
  }
  const sorted = [...keys].sort((a, b) => a - b)
  return { keys: sorted, all, packets: packets.length }
}

/**
 * 逐帧解码指纹（framemd5）。整条顺序解：带 seek 的抽帧在关键帧和 B 帧上会差一帧，
 * 拿来验对错会误报（踩过），顺序解虽然慢两三秒，但结论是确定的。
 */
export async function frameHashes(file) {
  const { stdout } = await run(FFMPEG, ['-v', 'error', '-i', file, '-an', '-f', 'framemd5', '-'],
    { encoding: 'utf8', maxBuffer: 512 << 20 })
  return String(stdout).trim().split(/\r?\n/).filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim())
}

/** -f concat 的清单要绝对路径、反斜杠转正斜杠，不然 ffmpeg 在 cwd 里找不到。 */
export async function concatCopy(parts, out) {
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
 * 流拷贝的 -ss：ffmpeg 会给到目标时间**之前最近的那个关键帧**，
 * 所以时间不能写 frame/fps——差 0.0007 秒就会退回到上一个关键帧（一整格，32 帧）。
 * 加半帧落在目标格里，取到的就是这个关键帧。
 */
export function seekCopy(frame, fps) {
  return ((frame + 0.5) / fps).toFixed(6)
}

/**
 * 重编码的 -ss：这里语义反过来——ffmpeg 会**丢掉** pts 不大于目标时间的第一帧，
 * 所以用「帧中点」当目标会把目标帧自己丢掉，整段往前错一帧（片尾还会少一帧）。
 * 减半帧，落在目标帧之前、上一帧之后，解出来的第一帧才是目标帧。
 */
export function seekEncode(frame, fps) {
  return ((frame - 0.5) / fps).toFixed(6)
}

/** 老名字，等同流拷贝那一档（拼接切点用）。 */
export const seekToFrame = seekCopy

/** 流拷贝切一段，帧数必须正好是 frames，多一帧少一帧都说明切点落错了。 */
export async function cutCopy({ src, ss, frames, out }) {
  const args = ['-y', '-loglevel', 'error']
  if (ss != null) args.push('-ss', ss)
  args.push('-i', src, '-frames:v', String(frames), '-an', '-c', 'copy', out)
  await ff(args)
  const got = await countFrames(out)
  if (got !== frames) throw new Error('切出来是 ' + got + ' 帧，应该是 ' + frames + ' 帧：' + out)
  return out
}

/** 成片里记的编码器。没有就是 null（老成片、或者不是这条管线出的片）。 */
export async function readEncoderTag(file) {
  if (!existsSync(file)) return null
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags=encoder',
    '-print_format', 'json', file], { encoding: 'utf8', maxBuffer: MAXBUF })
  const st = ((JSON.parse(stdout || '{}').streams) || [])[0] || {}
  const tag = (st.tags || {}).encoder || null
  return tag && tag.startsWith('vision-bots/') ? tag : null
}

/* ── 契约自检：编得出来 · 栅格对 · 切得拼得回 ──────────────────────────── */

function whyOf(e) {
  const text = String((e && (e.stderr || e.message)) || '')
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const hit = lines.find(l => /Driver does not|minimum required|failed to open|Cannot load|No device|not supported|Error while opening encoder|Unknown error|Invalid argument|Function not implemented|does not support|No such device/i.test(l))
  return (hit || lines[lines.length - 1] || '未知错误').replace(/^\[[^\]]*@[^\]]*\]\s*/, '').slice(0, 180)
}

/**
 * ffmpeg 的报错是英文且很长，这里把最常撞的几种翻译成人话，原文仍然保留在括号里。
 * 「不支持」这种话没有信息量：要能看出是缺驱动、缺硬件，还是参数写错。
 */
const EXPLAIN = [
  [/nvenc API version|minimum required Nvidia driver/i, 'NVIDIA 驱动太老：ffmpeg 要 nvenc API 13.1，本机只有 13.0'],
  [/amfrt64\.dll/i, 'AMD 驱动没装或版本不对（amfrt64.dll 打不开）'],
  [/No such device|No device|Cannot load/i, '本机没有对应的硬件，或驱动没起来'],
  [/Function not implemented|not supported|does not support/i, '这个 ffmpeg 构建不支持，或者硬件不支持这组参数'],
]

export function explain(why) {
  const text = String(why || '')
  const hit = EXPLAIN.find(([re]) => re.test(text))
  return hit ? hit[1] + '（' + text + '）' : text
}

const PROBE_SRC = 'testsrc2=size=' + PROBE_SIZE + ':rate=' + PROBE_FPS + ':duration=' + (PROBE_FRAMES / PROBE_FPS)

/**
 * 一个编码器能不能用：真编一段、真切一段、真拼回去，逐帧比。
 * 不是「ffmpeg 列出来就算支持」——NVENC 列着，驱动一老直接编不出来。
 */
export async function verify(cand, { every = KEY_EVERY, dir = null } = {}) {
  const d = dir || mkdtempSync(join(tmpdir(), 'vb-enc-'))
  const own = !dir
  const from = every
  const to = every * 2 - 1
  try {
    const full = join(d, 'probe-' + slug(cand.id) + '.mp4')
    try {
      await ff(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', PROBE_SRC, '-frames:v', String(PROBE_FRAMES),
        '-an', ...videoArgs(cand, { every }), full])
    } catch (e) {
      return { ok: false, stage: 'encode', why: whyOf(e) }
    }
    const frames = await countFrames(full)
    if (frames !== PROBE_FRAMES) return { ok: false, stage: 'encode', why: '编出来是 ' + frames + ' 帧，不是 ' + PROBE_FRAMES + ' 帧' }

    const { keys } = await keyframePositions(full, PROBE_FPS)
    const want = []
    for (let i = 0; i < PROBE_FRAMES; i += every) want.push(i)
    const missing = want.filter(k => !keys.includes(k))
    if (missing.length) return { ok: false, stage: 'grid', why: '第 ' + missing.join('/') + ' 帧没落关键帧（实际落在 ' + keys.slice(0, 6).join('/') + '）' }
    const stray = keys.filter(k => k % every !== 0)
    if (stray.length) return { ok: false, stage: 'grid', why: '多出栅格外的关键帧 ' + stray.slice(0, 4).join('/') + '，切点会歪' }

    // 切：头 0–31、窗口 32–63、尾 64–95，窗口里重编
    const head = join(d, 'probe-head.mkv')
    const tail = join(d, 'probe-tail.mkv')
    const piece = join(d, 'probe-piece.mkv')
    const joined = join(d, 'probe-joined.mkv')
    try {
      await cutCopy({ src: full, ss: null, frames: from, out: head })
      await cutCopy({ src: full, ss: seekCopy(to + 1, PROBE_FPS), frames: PROBE_FRAMES - 1 - to, out: tail })
      await ff(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', PROBE_SRC,
        '-vf', 'trim=start_frame=' + from + ':end_frame=' + (to + 1) + ',setpts=PTS-STARTPTS',
        '-frames:v', String(to - from + 1), '-an', ...videoArgs(cand, { every, piece: true }), piece])
      await concatCopy([head, piece, tail], joined)
    } catch (e) {
      return { ok: false, stage: 'splice', why: whyOf(e) }
    }
    const joinedFrames = await countFrames(joined)
    if (joinedFrames !== PROBE_FRAMES) return { ok: false, stage: 'splice', why: '拼出来是 ' + joinedFrames + ' 帧，不是 ' + PROBE_FRAMES + ' 帧' }
    const [a, b] = await Promise.all([frameHashes(full), frameHashes(joined)])
    if (b.length !== PROBE_FRAMES) return { ok: false, stage: 'splice', why: '拼出来解出 ' + b.length + ' 帧' }
    const bad = []
    for (let i = 0; i < PROBE_FRAMES; i++) {
      if (i >= from && i <= to) continue
      if (a[i] !== b[i]) bad.push(i)
    }
    if (bad.length) return { ok: false, stage: 'splice', why: '窗口外第 ' + bad.slice(0, 4).join('/') + ' 帧对不上（切点或 B 帧问题）' }

    return { ok: true, stage: 'ok', why: '', checks: { frames, keyframes: keys.length, spliceOutsideFrames: PROBE_FRAMES - (to - from + 1) } }
  } finally {
    if (own) rmSync(d, { recursive: true, force: true })
  }
}

/* ── 实测速度与体积 ────────────────────────────────────────────────── */

const BENCH_FRAMES = 96

function cacheDir() {
  return process.env.VISION_BOTS_CACHE || join(ROOT, 'work')
}

/**
 * 合成一条测试源：没有真实母版时用它测速。落盘缓存（FFV1，96 帧）。
 * 每台机器每种尺寸只造一次。近黑底 + 一块灰阶条 + 空格：接近我们片子里的观感
 * （大面积平色 + 硬边），用纯噪声测出来的体积跟实际成片不是一回事。
 */
export async function fixture(size = [1080, 1920], frames = BENCH_FRAMES) {
  const [w, h] = size
  const dir = join(cacheDir(), 'machine')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'fixture-' + w + 'x' + h + '.mkv')
  if (existsSync(out)) return out
  const src =
    'color=c=0x0A0A0D:s=' + w + 'x' + h + ':r=30:d=' + (frames / 30).toFixed(3) + '[bg];' +
    'testsrc2=s=' + w + 'x' + Math.round(h / 6) + ':r=30:d=' + (frames / 30).toFixed(3) + ',format=gray[band];' +
    '[bg][band]overlay=x=0:y=' + Math.round(h * 0.4)
  await ff(['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-frames:v', String(frames),
    '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-pix_fmt', 'yuv420p', out])
  return out
}

/**
 * 量一个编码器在这台机器上编 96 帧要多久、编出多大。
 * source 给真实母版就量真实内容，不给就造合成源。
 */
export async function bench(cand, { source = null, size = [1080, 1920], every = KEY_EVERY } = {}) {
  const dir = join(cacheDir(), 'machine')
  mkdirSync(dir, { recursive: true })
  const src = source || await fixture(size)
  const out = join(dir, 'bench-' + slug(cand.id) + '.mp4')
  const t0 = Date.now()
  try {
    await ff(['-y', '-loglevel', 'error', '-i', src, '-an', '-frames:v', String(BENCH_FRAMES), ...videoArgs(cand, { every }), out])
  } catch (e) {
    return { id: cand.id, label: cand.label, ok: false, why: whyOf(e) }
  }
  const seconds = (Date.now() - t0) / 1000
  const bytes = statSync(out).size
  const frames = await countFrames(out)
  rmSync(out, { force: true })
  return { id: cand.id, label: cand.label, ok: true, seconds: +seconds.toFixed(1), mb: +(bytes / 1e6).toFixed(2), frames, synthetic: !source }
}

/* ── 选型：默认值 + 覆盖 + 落盘缓存 ──────────────────────────────────── */

/**
 * 这一版管线用哪个编码器。
 * 优先级：VISION_BOTS_ENCODER 环境变量 > work/machine.json 里上次的记录 > 默认 x264 veryfast。
 * 只接受候选表里的 id（写错了直接报错并列出可选项，不静默退回默认值）。
 */
export function resolveEncoder({ id = null } = {}) {
  const want = id || process.env.VISION_BOTS_ENCODER || null
  if (want && want !== 'auto') {
    const hit = candidateById(want)
    if (!hit) throw new Error('不认识的编码器「' + want + '」，可选：' + candidates().map(c => c.id).join(' / '))
    return { ...hit, tag: tagOf(hit), source: id ? 'param' : 'env' }
  }
  const cached = readMachineCache()
  const hit = (cached && candidateById(cached.chosen)) || candidateById(DEFAULT_ID)
  return { ...hit, tag: tagOf(hit), source: cached ? 'cache' : 'default' }
}

function readMachineCache() {
  try {
    const p = join(cacheDir(), 'machine.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j && j.chosen && candidateById(j.chosen) ? j : null
  } catch {
    return null
  }
}

/** doctor 测完之后把结论落盘：以后开片沿用同一个编码器，不在交付中途偷偷换参数。 */
export function rememberEncoder(id, note = '') {
  const dir = cacheDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'machine.json')
  const tmp = file + '.tmp'
  const prev = (() => { try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} } })()
  writeFileSync(tmp, JSON.stringify({ ...prev, chosen: id, note, at: new Date().toISOString(), platform: process.platform }, null, 2), 'utf8')
  renameSync(tmp, file)
  return file
}

/**
 * 从实测表里挑一个：体积不超过最小体积 15% 的候选里，取最快的那台。
 * 为什么不是「最快的」：快 3% 换 20% 体积不值（平台会二次压缩，体积大的先掉画质）。
 * 为什么不是「体积最小的」：同体积下快一截是白拿的（本机 medium→veryfast 省 40% 时间、体积不变）。
 */
export const SIZE_SLACK = 1.15

export function pickBest(rows) {
  const ok = (rows || []).filter(r => r && r.ok !== false && r.mb > 0 && r.seconds > 0)
  if (!ok.length) return null
  const minMB = Math.min(...ok.map(r => r.mb))
  const fit = ok.filter(r => r.mb <= minMB * SIZE_SLACK).sort((a, b) => a.seconds - b.seconds || a.mb - b.mb)
  return { chosen: fit[0], minMB, pool: fit.map(f => f.id) }
}

/** 让 CLI／群聊里说人话用 */
export function plainName(cand) {
  return cand ? cand.label : '未知编码器'
}

export function slug(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '-')
}