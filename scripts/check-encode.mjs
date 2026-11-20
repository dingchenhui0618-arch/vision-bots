/**
 * 分段编码自检：改一处只重编那一格，拼回去必须帧级对得上。
 *
 * 用合成素材跑，不依赖客户资产：
 *   1. 造一条 90 帧的无损母版 + 同长音轨，整条编码，检查栅格关键帧确实落下了
 *   2. 换一条母版（只改 30–59 帧），按 35–40 帧的改动做一次拼接编码
 *   3. 逐帧比：窗口外的帧必须和上一版一模一样，窗口内的必须真的变了
 *   4. 上一版没有栅格关键帧时，必须老实整条重编，不许硬切
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG, FFPROBE } from '../src/env.mjs'
import { encodeFilm, gridIsCuttable, countFrames, expandWindow, KEY_EVERY } from '../src/encode-film.mjs'

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
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 256 << 20, ...opts })
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-800))
  return r
}

/** variant=0 原样；variant=1 把 30–59 帧刷成红色，模拟「改了一处」 */
function makeMaster(file, dir, variant) {
  const src = 'testsrc2=size=' + SIZE + ':rate=' + FPS + ':duration=' + (FRAMES / FPS)
  const vf = variant ? "drawbox=x=0:y=0:w=" + W + ":h=" + H + ":color=red@0.7:t=fill:enable='between(n,30,59)'" : null
  const args = ['-y', '-f', 'lavfi', '-i', src]
  if (vf) args.push('-vf', vf)
  args.push('-frames:v', String(FRAMES), '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-pix_fmt', 'gbrp', file)
  ff(args)
  return file
}

/** 每个解码帧的 md5：比「像素一样」更硬，一样就是一样 */
function frameHashes(file) {
  const r = ff(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-'], { encoding: 'buffer' })
  const size = W * H * 3 / 2
  const buf = r.stdout
  const out = []
  for (let i = 0; i + size <= buf.length; i += size) out.push(createHash('md5').update(buf.subarray(i, i + size)).digest('hex'))
  return out
}

const dir = mkdtempSync(join(tmpdir(), 'enc-check-'))
try {
  const audio = join(dir, 'a.m4a')
  ff(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + (FRAMES / FPS), '-c:a', 'aac', '-b:a', '96k', audio])

  console.log('— 首出：整条编码')
  const master1 = makeMaster(join(dir, 'm1.mkv'), dir, 0)
  const film = join(dir, 'film.mp4')
  const full = await encodeFilm({ master: master1, mixed: audio, out: film, frames: FRAMES, fps: FPS, dirty: { all: true } })
  ok('首出是整条重编', full.mode === 'full', full.mode)
  ok('首出帧数对', (await countFrames(film)) === FRAMES)
  const grid = await gridIsCuttable(film, FRAMES, FPS)
  ok('首出在栅格位置有关键帧', grid.ok === true, grid.reason || '')
  ok('关键帧数量对', grid.ok && grid.keyframes === Math.ceil(FRAMES / KEY_EVERY), String(grid.keyframes))

  console.log('— 改一处：只重编那一格')
  const before = frameHashes(film)
  ff(['-y', '-i', film, '-c', 'copy', dir + '/before.mp4'])
  const master2 = makeMaster(join(dir, 'm2.mkv'), dir, 1)
  const dirty = { from: 35, to: 40 }
  const win = expandWindow(dirty, FRAMES)
  const sp = await encodeFilm({ master: master2, mixed: audio, out: film, frames: FRAMES, fps: FPS, dirty })
  ok('有栅格关键帧时走拼接', sp.mode === 'splice', sp.mode)
  ok('拼接帧数对', (await countFrames(film)) === FRAMES)
  ok('改动窗口扩到了整格', !!win && win.from % KEY_EVERY === 0 && (win.to + 1) % KEY_EVERY === 0, JSON.stringify(win))
  const after = frameHashes(film)
  if (process.env.DBG_ENC) {
    const pk = JSON.parse((spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,dts_time', '-show_packets', '-print_format', 'json', dir + '/before.mp4'], { encoding: 'utf8' })).stdout).packets
    const t = pk.map(x => Number(x.pts_time)).sort((a, b) => a - b)
    console.log('    before 首末:', t[0], t[t.length - 1], 'n=' + pk.length)
    console.log('    after 前 70 帧:', after.slice(60, 70).join(' '))
    console.log('    before 前 70 帧:', before.slice(60, 70).join(' '))
  }
  const outsideDiff = after.map((h, i) => (h === before[i] ? -1 : i)).filter(i => i >= 0 && (i < win.from || i > win.to))
  ok('窗口外的帧和上一版逐帧一致', outsideDiff.length === 0, '窗口外变了 ' + outsideDiff.length + ' 帧：' + outsideDiff.slice(0, 8).join(' '))
  const insideChanged = after.slice(win.from, win.to + 1).filter((h, k) => h !== before[win.from + k]).length
  ok('窗口内的帧确实变了', insideChanged > 0, '变了 ' + insideChanged + ' 帧')
  ok('只重编了窗口内的帧', sp.window && (sp.window.to - sp.window.from + 1) < FRAMES, JSON.stringify(sp.window))

  console.log('— 没有栅格关键帧的上一版：必须整条重编')
  const plain = join(dir, 'plain.mp4')
  ff(['-y', '-i', master1, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', plain])
  const plainGrid = await gridIsCuttable(plain, FRAMES, FPS)
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
