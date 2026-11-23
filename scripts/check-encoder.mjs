/**
 * 编码器选型自检：参数映射、选型规则、失败翻译、成片标签、切片起点。
 *
 * 不联网、不依赖客户资产；真跑的部分只用 96 帧小图（1 秒级）。
 * 真片拼接的对错不在这里验——那是 check-encode.mjs 的事（那里逐帧比）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FFMPEG } from '../src/env.mjs'
import {
  candidates, candidateById, videoArgs, pickBest, explain, resolveEncoder, rememberEncoder,
  verify, readEncoderTag, seekCopy, seekEncode, KEY_EVERY, SIZE_SLACK, DEFAULT_ID,
} from '../src/encoder.mjs'

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

function ff(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', ...args], { maxBuffer: 128 << 20 })
  if (r.status !== 0) throw new Error(String(r.stderr).slice(-500))
  return r
}

const dir = mkdtempSync(join(tmpdir(), 'enc-pick-'))
const savedCache = process.env.VISION_BOTS_CACHE
const savedEnv = process.env.VISION_BOTS_ENCODER
try {
  process.env.VISION_BOTS_CACHE = join(dir, 'cache')

  console.log('— 候选表')
  const win = candidates('win32')
  ok('win32 有 QuickSync', win.some(c => c.id === 'h264_qsv'))
  ok('win32 有 NVENC', win.some(c => c.id === 'h264_nvenc'))
  ok('win32 有 AMF', win.some(c => c.id === 'h264_amf'))
  ok('win32 三档 x264 都在', ['veryfast', 'fast', 'medium'].every(p => win.some(c => c.id === 'libx264/' + p)))
  ok('硬编排在软编前面', win.findIndex(c => c.encoder === 'libx264') === win.length - 3)
  ok('darwin 走 VideoToolbox', candidates('darwin').some(c => c.id === 'h264_videotoolbox'))
  ok('linux 不列 AMF', !candidates('linux').some(c => c.id === 'h264_amf'))
  ok('id 不重复', new Set(win.map(c => c.id)).size === win.length)
  ok('每档都有给人看的名字', win.every(c => c.label && c.label !== c.id))
  ok('默认 id 在候选表里', Boolean(candidateById(DEFAULT_ID)))
  ok('不认识的 id 返回 null', candidateById('libx264/ultra') === null)

  console.log('— 参数映射（栅格参数必须显式给）')
  const qsv = candidateById('h264_qsv')
  const nv = candidateById('h264_nvenc')
  const amf = candidateById('h264_amf')
  const vt = candidates('darwin').find(c => c.id === 'h264_videotoolbox')
  const x264vf = candidateById('libx264/veryfast')
  const gridOf = a => a.join(' ')
  ok('x264 用 keyint=32:min-keyint=32:scenecut=0', gridOf(videoArgs(x264vf)).includes('keyint=32:min-keyint=32:scenecut=0'))
  ok('x264 带自己的 preset', gridOf(videoArgs(x264vf)).includes('-preset veryfast'))
  ok('QSV 用 -g 32 与 -keyint_min 32', gridOf(videoArgs(qsv)).includes('-g 32') && gridOf(videoArgs(qsv)).includes('-keyint_min 32'))
  ok('QSV 关掉场景切换', gridOf(videoArgs(qsv)).includes('-sc_threshold 0'))
  ok('NVENC 强制 IDR（不然非 IDR 的 I 帧拼不了）', gridOf(videoArgs(nv)).includes('-forced-idr 1'))
  ok('NVENC 关掉场景切换', gridOf(videoArgs(nv)).includes('-no-scenecut 1'))
  ok('AMF 也给栅格', gridOf(videoArgs(amf)).includes('-g 32'))
  ok('VideoToolbox 也给栅格', gridOf(videoArgs(vt)).includes('-g 32'))
  ok('每种候选的切片参数都带 -bf 0', [qsv, nv, amf, vt, x264vf].every(c => gridOf(videoArgs(c, { piece: true })).includes('-bf 0')))
  ok('每种候选的切片参数都从 pts 0 起', [qsv, nv, amf, vt, x264vf].every(c => gridOf(videoArgs(c, { piece: true })).includes('setts=pts=PTS-STARTPTS')))
  const noGrid = [qsv, nv, amf, vt, x264vf].map(c => gridOf(videoArgs(c, { every: 0 })))
  ok('every:0 时不给栅格（整条重编的路径不该多花码率）', noGrid.every(s => !s.includes('keyint') && !s.includes('-g 32')))
  ok('every:0 时也不给 -g', noGrid.every(s => !s.includes(' -g ')))
  ok('不认识的编码器直接报错', (() => { try { videoArgs({ encoder: 'h264_magic' }); return false } catch { return true } })())

  console.log('— 选型规则')
  ok('体积不能超最小体积的 ' + Math.round(SIZE_SLACK * 100) + '%', SIZE_SLACK > 1.1 && SIZE_SLACK < 1.3)
  const real = [
    { id: 'libx264/medium', seconds: 32.1, mb: 17.49 },
    { id: 'libx264/fast', seconds: 26.4, mb: 17.64 },
    { id: 'libx264/veryfast', seconds: 19.1, mb: 17.38 },
    { id: 'h264_qsv', seconds: 17.9, mb: 32.21 },
  ]
  ok('本机这张真表选出 veryfast（不是最快的那个）', pickBest(real).chosen.id === 'libx264/veryfast', JSON.stringify(pickBest(real)))
  ok('硬编体积超线被排除', !pickBest(real).pool.includes('h264_qsv'))
  ok('体积最小的进池', pickBest(real).pool.includes('libx264/medium'))
  ok('空表返回 null', pickBest([]) === null)
  ok('全失败返回 null', pickBest([{ id: 'a', ok: false }, { id: 'b', mb: 0, seconds: 0 }]) === null)
  const fastBig = [{ id: 'hw', seconds: 1, mb: 100 }, { id: 'sw', seconds: 40, mb: 20 }]
  ok('快 40 倍但体积 5 倍的不要', pickBest(fastBig).chosen.id === 'sw', JSON.stringify(pickBest(fastBig)))
  const sameSize = [{ id: 'a', seconds: 10, mb: 20 }, { id: 'b', seconds: 9, mb: 20.5 }]
  ok('同体积取快的', pickBest(sameSize).chosen.id === 'b')

  console.log('— 失败翻译')
  ok('NVENC 驱动太老翻成人话，原文保留',
    explain('Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0').includes('NVIDIA 驱动太老')
    && explain('Driver does not support the required nvenc API version').includes('13.1'))
  ok('AMD 那个 DLL 也翻', explain('DLL amfrt64.dll failed to open').includes('AMD'))
  ok('不认识的错误原样返回', explain('something odd happened') === 'something odd happened')

  console.log('— 选型入口')
  delete process.env.VISION_BOTS_ENCODER
  ok('没配置时就是默认 x264 veryfast', resolveEncoder().id === DEFAULT_ID)
  process.env.VISION_BOTS_ENCODER = 'h264_qsv'
  ok('环境变量能指定', resolveEncoder().id === 'h264_qsv')
  ok('环境变量记在 source 上', resolveEncoder().source === 'env')
  delete process.env.VISION_BOTS_ENCODER
  ok('参数能指定', resolveEncoder({ id: 'libx264/medium' }).id === 'libx264/medium')
  let listedErr = ''
  try { resolveEncoder({ id: 'libx264/ultra' }) } catch (e) { listedErr = String(e.message) }
  ok('写错编码器直接报错并列可选', listedErr.includes('可选') && listedErr.includes('libx264/veryfast'), listedErr)
  const file = rememberEncoder('libx264/fast', '自检')
  ok('rememberEncoder 落盘', existsSync(file))
  ok('落盘不带临时文件', !existsSync(file + '.tmp'))
  ok('下次开片用记下的那个', resolveEncoder().id === 'libx264/fast' && resolveEncoder().source === 'cache')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  ok('记录里写明是谁选的', saved.chosen === 'libx264/fast' && saved.note === '自检')

  console.log('— 切片起点（差一帧在静态画面里看不出来）')
  const fps = 30
  ok('流拷贝的 -ss 落在目标帧之后（取到关键帧）', Number(seekCopy(480, fps)) > 480 / fps, seekCopy(480, fps))
  ok('重编码的 -ss 落在目标帧之前（保住第一帧）', Number(seekEncode(480, fps)) < 480 / fps, seekEncode(480, fps))
  ok('两者都落在上一帧之后', Number(seekEncode(480, fps)) > 479 / fps, seekEncode(480, fps))
  ok('两者都不到半帧的差距', Math.abs(seekCopy(480, fps) - 480 / fps) < 1 / fps, seekCopy(480, fps))

  console.log('— 契约自检真跑')
  const v = await verify(candidateById('libx264/veryfast'))
  ok('x264 veryfast 通过三条契约', v.ok === true, v.why || '')
  ok('自检帧数是 96', v.ok && v.checks.frames === 96, JSON.stringify(v.checks))
  ok('自检关键帧落 0/32/64', v.ok && v.checks.keyframes === 3, JSON.stringify(v.checks))
  ok('自检比对窗口外 64 帧', v.ok && v.checks.spliceOutsideFrames === 64)
  const bad = await verify({ id: 'not-a-codec', encoder: 'not_a_real_codec', preset: null, label: '假的' })
  ok('假编码器不过，并且带原因', bad.ok === false && bad.stage === 'encode' && bad.why.length > 0, JSON.stringify(bad))

  console.log('— 成片上的编码器标签')
  const plain = join(dir, 'plain.mp4')
  ff(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=30:duration=1', '-frames:v', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', plain])
  ok('没写标签的片子读出来是 null', (await readEncoderTag(plain)) === null)
  const tagged = join(dir, 'tagged.mp4')
  ff(['-y', '-i', plain, '-c', 'copy', '-metadata:s:v:0', 'encoder=vision-bots/libx264/veryfast', tagged])
  ok('写了标签读得回来', (await readEncoderTag(tagged)) === 'vision-bots/libx264/veryfast', String(await readEncoderTag(tagged)))
  const foreign = join(dir, 'foreign.mp4')
  ff(['-y', '-i', plain, '-c', 'copy', '-metadata:s:v:0', 'encoder=Lavc63 libx264', foreign])
  ok('别人的编码器标签不算我们的', (await readEncoderTag(foreign)) === null, String(await readEncoderTag(foreign)))

  console.log('— 关键帧栅格常量')
  ok('栅格是 32 帧', KEY_EVERY === 32)
  ok('自检小样正好三格', 96 === KEY_EVERY * 3)

  console.log('')
  console.log((fail ? 'FAIL ' : 'PASS ') + pass + ' 条通过，' + fail + ' 条失败')
  process.exitCode = fail ? 1 : 0
} finally {
  if (savedCache === undefined) delete process.env.VISION_BOTS_CACHE
  else process.env.VISION_BOTS_CACHE = savedCache
  if (savedEnv === undefined) delete process.env.VISION_BOTS_ENCODER
  else process.env.VISION_BOTS_ENCODER = savedEnv
  rmSync(dir, { recursive: true, force: true })
}