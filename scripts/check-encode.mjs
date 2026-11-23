/**
 * 分段编码自检：改一处只重编那一格，拼回去必须帧级对得上。
 *
 * 用合成素材跑，不依赖客户资产：
 *   1. 造一条 90 帧的无损母版 + 同长音轨，整条编码，检查栅格关键帧确实落下了
 *   2. 换一条母版（只改 30–59 帧），按 35–40 帧的改动做一次拼接编码
 *   3. 逐帧比：窗口外的帧必须和上一版一模一样，窗口内的必须真的变了
 *   4. 窗口内还不许错帧：每帧都要和母版**同一帧**最像（切片起点对齐，
 *      差一帧在静态画面里看不出来，但那是错的片）
 *   5. 上一版没有栅格关键帧、或者编码器和这次不同时，必须老实整条重编，不许硬切
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG, FFPROBE } from '../src/env.mjs'
import { encodeFilm, gridIsCuttable, countFrames, expandWindow, KEY_EVERY } from '../src/encode-film.mjs'
import { readEncoderTag, resolveEncoder } from '../src/encoder.mjs'

const FRAMES = 90
const FPS = 30
const SIZE = '160x120'
const W = 160
const H = 120

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

function ff(args, opts = {}) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 512 << 20, ...opts })
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-800))
  return r
}

/**
 * variant=0 原样；variant=1 把 30–59 帧刷成红色，模拟「改了一处」。
 * 画面里有一个按帧号移动的白块：相邻帧差别足够大，才能验出「窗口内错了一帧」。
 * 纯色或静态画面是最坏的情况——错一帧肉眼看不出、PSNR 也看不出。
 */
function makeMaster(file, dir, variant) {
  const dur = (FRAMES / FPS).toFixed(3)
  const chain = '[0:v][1:v]overlay=x=\'mod(n*3,150)\':y=10[ov]'
    + (variant ? "; [ov]drawbox=x=0:y=0:w=" + W + ":h=" + H + ":color=red@0.7:t=fill:enable='between(n,30,59)'[v]" : '; [ov]null[v]')
  ff(['-y',
    '-f', 'lavfi', '-i', 'color=c=0x101010:s=' + SIZE + ':r=' + FPS + ':d=' + dur,
    '-f', 'lavfi', '-i', 'color=c=white:s=8x8:r=' + FPS + ':d=' + dur,
    '-filter_complex', chain, '-map', '[v]',
    '-frames:v', String(FRAMES), '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-pix_fmt', 'gbrp', file])
  return file
}

function frameBufs(file) {
  const r = ff(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer' })
  const size = W * H * 3 / 2
  const out = []
  for (let i = 0; i + size <= r.stdout.length; i += size) out.push(r.stdout.subarray(i, i + size))
  return out
}

function hashes(bufs) {
  return bufs.map(b => createHash('md5').update(b).digest('hex'))
}

/** 只比亮度平面：人眼对亮度的错位最敏感，也最不像「编码噪声」 */
function psnrY(a, b) {
  let se = 0
  for (let i = 0; i < W * H; i++) { const d = a[i] - b[i]; se += d * d }
  const mse = se / (W * H)
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse)
}

const dir = mkdtempSync(join(tmpdir(), 'enc-check-'))
try {
  const audio = join(dir, 'a.m4a')
  ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + (FRAMES / FPS), '-c:a', 'aac', '-b:a', '96k', audio])
  const plan = resolveEncoder()

  console.log('— 首出：整条编码')
  const master1 = makeMaster(join(dir, 'm1.mkv'), dir, 0)
  const film = join(dir, 'film.mp4')
  const full = await encodeFilm({ master: master1, mixed: audio, out: film, frames: FRAMES, fps: FPS, dirty: { all: true } })
  ok('首出是整条重编', full.mode === 'full', full.mode)
  ok('首出帧数对', (await countFrames(film)) === FRAMES)
  ok('首出用的是选定的编码器', full.encoder && full.encoder.id === plan.id, JSON.stringify(full.encoder))
  ok('编码器记进了成片（换编码器不许混拼）', (await readEncoderTag(film)) === plan.tag, String(await readEncoderTag(film)))
  const grid = await gridIsCuttable(film, FRAMES, FPS, { plan })
  ok('首出在栅格位置有关键帧', grid.ok === true, grid.reason || '')
  ok('关键帧数量对', grid.ok && grid.keyframes === Math.ceil(FRAMES / KEY_EVERY), String(grid.keyframes))

  console.log('— 改一处：只重编那一格')
  const before = hashes(frameBufs(film))
  ff(['-y', '-i', film, '-c', 'copy', dir + '/before.mp4'])
  const master2 = makeMaster(join(dir, 'm2.mkv'), dir, 1)
  const dirty = { from: 35, to: 40 }
  const win = expandWindow(dirty, FRAMES)
  const sp = await encodeFilm({ master: master2, mixed: audio, out: film, frames: FRAMES, fps: FPS, dirty })
  ok('有栅格关键帧时走拼接', sp.mode === 'splice', sp.mode)
  ok('拼接帧数对', (await countFrames(film)) === FRAMES)
  ok('改动窗口扩到了整格', !!win && win.from % KEY_EVERY === 0 && (win.to + 1) % KEY_EVERY === 0, JSON.stringify(win))
  const afterBufs = frameBufs(film)
  const after = hashes(afterBufs)
  const outsideDiff = after.map((h, i) => (h === before[i] ? -1 : i)).filter(i => i >= 0 && (i < win.from || i > win.to))
  ok('窗口外的帧和上一版逐帧一致', outsideDiff.length === 0, '窗口外变了 ' + outsideDiff.length + ' 帧：' + outsideDiff.slice(0, 8).join(' '))
  const insideChanged = after.slice(win.from, win.to + 1).filter((h, k) => h !== before[win.from + k]).length
  ok('窗口内的帧确实变了', insideChanged > 0, '变了 ' + insideChanged + ' 帧')
  ok('只重编了窗口内的帧', sp.window && (sp.window.to - sp.window.from + 1) < FRAMES, JSON.stringify(sp.window))

  // 错一帧在静态画面里看不出来：用「每帧和母版同一帧最像」来验切片起点。
  const masterFrames = frameBufs(master2)
  const misaligned = []
  for (let i = win.from; i <= win.to; i++) {
    const cand = [-1, 0, 1].map(d => ({ d, p: psnrY(afterBufs[i], masterFrames[i + d] || masterFrames[i]) }))
    cand.sort((a, b) => b.p - a.p)
    if (cand[0].d !== 0) misaligned.push(i + '→' + (cand[0].d > 0 ? '+' : '') + cand[0].d)
  }
  ok('窗口内没有错帧（切片起点对得上母版）', misaligned.length === 0, '错位的帧：' + misaligned.slice(0, 6).join(' '))

  console.log('— 上一版是别的编码器编的：必须整条重编')
  const other = join(dir, 'other.mp4')
  ff(['-y', '-i', film, '-c', 'copy', '-metadata:s:v:0', 'encoder=vision-bots/h264_qsv', other])
  const s3 = await encodeFilm({ master: master2, mixed: audio, out: other, frames: FRAMES, fps: FPS, dirty: { from: 5, to: 9 } })
  ok('换过编码器的上一版不硬拼', s3.mode === 'full', s3.mode)
  ok('重编后回到自己这套参数', (await readEncoderTag(other)) === plan.tag)

  console.log('— 没有栅格关键帧的上一版：必须整条重编')
  const plain = join(dir, 'plain.mp4')
  ff(['-y', '-i', master1, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', plain])
  const plainGrid = await gridIsCuttable(plain, FRAMES, FPS, { plan })
  ok('认得出老成片不能切', plainGrid.ok === false, plainGrid.reason || '')
  const s2 = await encodeFilm({ master: master2, mixed: audio, out: plain, frames: FRAMES, fps: FPS, dirty })
  ok('不能切时老实整条重编', s2.mode === 'full', s2.mode)
  ok('重编后仍然是 ' + FRAMES + ' 帧', (await countFrames(plain)) === FRAMES)

  console.log('— 帧数不对必须报错')
  let threw = false
  try {
    await encodeFilm({ master: master2, mixed: audio, out: join(dir, 'bad.mp4'), frames: FRAMES + 5, fps: FPS, dirty: { all: true } })
  } catch (e) { threw = /帧/.test(String(e.message)) }
  ok('帧数对不上会中止而不是交给一条错位的片子', threw)

  console.log('')
  console.log((fail ? 'FAIL ' : 'PASS ') + pass + ' 条通过，' + fail + ' 条失败')
  process.exitCode = fail ? 1 : 0
} finally {
  rmSync(dir, { recursive: true, force: true })
}
