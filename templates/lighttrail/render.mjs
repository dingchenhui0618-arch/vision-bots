/**
 * 光轨 · 渲染驱动：抽帧 → 切音 → 包络 → 逐帧渲染 → 音效 → 混音 → 编码。
 * 除了渲染器本身，其它每一步都是 ffmpeg 的确定性操作，跑一次的结果可以复现。
 *
 * 分段缓存：母版放在群目录的 cache/ 下，下次改一句只重渲那一章覆盖的帧，
 * 其余帧从母版里切出来无损拼回去（src/render-cache.mjs）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCanvasTools, FFMPEG } from '../../src/env.mjs'
import { ff } from '../../src/ffmpeg.mjs'
import { synthCues, peaksFromPCM } from '../../src/sfx.mjs'
import { hashOf, planPatch, spliceMaster } from '../../src/render-cache.mjs'
import { encodeFilm } from '../../src/encode-film.mjs'
import { subjectBand, grabSourcePairs } from '../../src/frame-audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER = join(HERE, '..', '..', 'vendor', 'lighttrail', 'tools', 'render.mjs')
const FILM = join(HERE, 'film.js')

/** 渲染任意帧区间（闭区间）。patch 与整条渲染走同一条路，参数一模一样。 */
export async function renderFrames({ work, mediaDir, size, fps, from, to, out, log = () => {} }) {
  const { fonts, chrome } = assertCanvasTools()
  await run(process.execPath, [
    RENDERER, '--film', FILM, '--project', work, '--media', mediaDir,
    '--mode', 'frames', '--from', String(from), '--to', String(to), '--out', out,
    '--size', size[0] + 'x' + size[1], '--samples', '4', '--fonts', fonts, '--chrome', chrome,
  ], { log })
  return out
}

/** 在保留段里均匀取几个源时间点，用来量人物在哪。 */
function sampleTimes(plan, n = 9) {
  const total = plan.keep.reduce((s, [a, b]) => s + (b - a), 0)
  const out = []
  for (let i = 0; i < n; i++) {
    let target = ((i + 0.5) / n) * total
    for (const [a, b] of plan.keep) {
      const d = b - a
      if (target <= d) { out.push(a + Math.min(Math.max(0.05, target), Math.max(0.05, d - 0.05))); break }
      target -= d
    }
  }
  return out
}

/**
 * 问一遍渲染器：这版画面把字和轨道画在哪（含这版几何）。
 * 不逐帧跑——盒子是按内容布局的，每 0.4 秒取一帧就够覆盖每张字幕和每段大字。
 */
export async function qaBoxes({ work, mediaDir, size, frames, fps, out, log = () => {} }) {
  const { fonts, chrome } = assertCanvasTools()
  const step = Math.max(1, Math.round(fps * 0.4))
  try {
    await runQa(work, mediaDir, size, frames, fps, out, step, fonts, chrome, log)
  } catch (e) {
    writeFileSync(out + '.error.txt', String(e.message || e) + '\n' + String(e.stack || ''), 'utf8')
    throw e
  }
  const lines = readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
  const boxes = []
  let layout = null
  for (const row of lines) {
    if (row.layout) layout = row.layout
    for (const b of row.boxes || []) boxes.push({ ...b, frame: row.f, t0: row.f / fps, t1: row.f / fps })
  }
  return { boxes, layout, samples: lines.length }
}

function runQa(work, mediaDir, size, frames, fps, out, step, fonts, chrome, log) {
  return run(process.execPath, [
    RENDERER, '--film', FILM, '--project', work, '--media', mediaDir,
    '--mode', 'qa', '--from', '0', '--to', String(frames - 1), '--q-step', String(step),
    '--out', out, '--size', size[0] + 'x' + size[1], '--fonts', fonts, '--chrome', chrome,
  ], { log })
}

export async function renderLighttrail({ input, plan, scene, work, out, log = () => {}, stills = null, force = false, cacheDir = null }) {
  const { fonts, chrome } = assertCanvasTools()
  const [width, height] = scene.size
  const size = scene.size
  const fps = scene.fps

  // 0. 人物在哪：轨道要按它让位，质检也要拿它判「字有没有压到人」。
  // 这一步只读素材像素，不依赖模型；量不出来就记 ok:false，绝不静默当"没问题"。
  // 默认不开：纯运动差分在近景口播上量不准（人占画面一大半，帽子和裤子都会误判），
  // 与其拿一个错的头部区间把轨道推到脸上，不如先按版式契约走——所有文字只占画面下 38%，
  // 这个契约由质检从盒子里逐帧验。人物蒙版接上（docs/MATTE.md）之后换成 alpha 轮廓判定。
  if (process.env.VISION_BOTS_HEADBAND === '1' && !scene.person.headBand) {
    const band = subjectBand(await grabSourcePairs({ input, times: sampleTimes(plan, 9), gap: 0.25, size: [108, 192] }))
    scene.person.headBand = band
    log(band.ok ? '人物头部实测：' + (band.band.top * 100).toFixed(0) + '%–' + (band.band.bottom * 100).toFixed(0) + '%' : '人物位置没量出来：' + band.reason)
  } else if (!scene.person.headBand) {
    log('人物蒙版未接入：按版式契约排（文字只在下 38% 的带子里）')
  }

  const sceneStamp = hashOf(JSON.stringify(scene))
  const tplJSON0 = readFileSync(join(HERE, 'template.json'), 'utf8').replace(/^\uFEFF/, '')
  const hash0 = hashOf(tplJSON0, readFileSync(FILM, 'utf8'))
  const cached = cacheDir ? readCacheMeta(cacheDir) : null

  // 0. 什么都没变、成片也还在：连抽帧和编码都不用做
  if (!force && !stills && cacheDir && cached && cached.sceneStamp === sceneStamp && cached.hash === hash0 && existsSync(out)) {
    // 就算复用成片，也要把这一版的项目文件落到工作目录：
    // 质检要拿同一份 scene/peaks/template 回放画面（不然盒子采样直接 404）
    writeProjectFiles(work, scene, tplJSON0, cached.peaksJSON)
    log('画面、声音、模板都没变，成片直接复用')
    return { out, renderSeconds: 0, frames: scene.frames, decision: { mode: 'reuse', reason: '整条没变，成片复用' } }
  }

  const stamp = statSync(input)
  const assetStamp = stamp.size + ':' + Math.round(stamp.mtimeMs)
  const personHash = hashOf(JSON.stringify(scene.person), String(fps), assetStamp)
  const voiceHash = hashOf(JSON.stringify(plan.keep), JSON.stringify(plan.options || {}), assetStamp)

  const mediaDir = cacheDir ? join(cacheDir, 'media') : join(work, 'media')
  const frameDir = join(mediaDir, 'frames', 'person')
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  mkdirSync(frameDir, { recursive: true })

  // 1. 抽帧：按 EDL 的每段切，帧号连续，成片帧 → 源帧的映射写在 scene.person.ranges
  const t0 = Date.now()
  const haveFrames = cacheDir && cached && cached.person === personHash && existsSync(join(frameDir, 'f_000000.jpg'))
  if (haveFrames) log('复用上次抽好的 ' + (scene.person.count) + ' 帧')
  let n = 0
  for (const [i, r] of (haveFrames ? [] : scene.person.ranges).entries()) {
    const count = r.outF1 - r.outF0
    log('抽帧 ' + (i + 1) + '/' + scene.person.ranges.length + '：源 ' + r.srcSec.toFixed(2) + 's 起 ' + r.durSec.toFixed(2) + 's → ' + count + ' 帧')
    await ff([
      '-y', '-loglevel', 'error',
      '-ss', r.srcSec.toFixed(3), '-t', r.durSec.toFixed(3), '-i', input,
      '-vf', 'fps=' + fps + ',scale=' + width + ':' + height + ':force_original_aspect_ratio=increase,crop=' + width + ':' + height + ',setsar=1',
      '-frames:v', String(r.srcCount), '-q:v', '3', '-start_number', String(n), join(frameDir, 'f_%06d.jpg'),
    ])
    n += count
  }
  if (!haveFrames) log('抽帧完成：' + readdirSync(frameDir).length + ' 帧 · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')

  // 2. 切音：和成片同一条时间线（trim → concat → atempo → loudnorm）
  const workVoice = join(work, 'voice.wav')
  const voice = cacheDir ? join(cacheDir, 'voice.wav') : workVoice
  const haveVoice = cacheDir && cached && cached.voice === voiceHash && existsSync(voice)
  if (haveVoice) {
    log('复用上次切好的声音')
  } else {
    await ff(['-y', '-loglevel', 'error', '-i', input, '-filter_complex', audioGraph(plan), '-map', '[ac]',
      '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', voice])
  }

  // 3. 声波包络：从切完的人声里量，画出来的波形和耳朵听到的一致
  const peaksJSON = haveVoice && cached.peaksJSON
    ? cached.peaksJSON
    : JSON.stringify(peaksFromPCM((await ff(['-v', 'error', '-i', voice, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { encoding: 'buffer' })).stdout))
  // 布局是模板的一部分，不是内容：引擎直接读它，画幅换了时间线一个字不动。
  const tplJSON = readFileSync(join(HERE, 'template.json'), 'utf8').replace(/^\uFEFF/, '')
  writeProjectFiles(work, scene, tplJSON, peaksJSON)

  // 4. 逐帧渲染（无头 Chrome + ANGLE）——有缓存就只渲变化的那一段
  const hash = hashOf(tplJSON, readFileSync(FILM, 'utf8'))
  const peaks = hashOf(peaksJSON)
  const workMaster = join(work, 'master.mkv')
  const cacheMaster = cacheDir ? join(cacheDir, 'master.mkv') : null
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })

  let decision = { mode: 'full', reason: '没有缓存目录' }
  if (cacheDir && !stills && !force) {
    const prev = readCacheMeta(cacheDir)
    decision = planPatch({ prev, next: { scene, hash, peaks }, fps })
  }
  if (stills || force) decision = { mode: 'full', reason: stills ? '只要静帧' : '强制重渲' }

  const tRender = Date.now()
  let master = workMaster
  let renderSeconds = 0
  if (stills) {
    log('逐帧渲染静帧 ' + stills.length + ' 张（' + width + '×' + height + '@' + fps + '，光轨引擎）')
    const shotDir = join(work, 'stills')
    await run(process.execPath, [
      RENDERER, '--film', FILM, '--project', work, '--media', mediaDir,
      '--mode', 'stills', '--stills', stills.map(Number).join(','), '--out-dir', shotDir,
      '--size', width + 'x' + height, '--samples', '4', '--fonts', fonts, '--chrome', chrome,
    ], { log })
    renderSeconds = (Date.now() - tRender) / 1000
    log('静帧完成：' + renderSeconds.toFixed(1) + 's')
    return { stills: shotDir, renderSeconds, frames: scene.frames, decision }
  }

  if (decision.mode === 'reuse') {
    log('画面没有任何变化，直接复用母版（' + decision.reason + '）')
    master = cacheMaster
  } else if (decision.mode === 'patch') {
    const patchPath = join(work, 'patch.mkv')
    log('分段重渲：' + decision.reason + '（' + (decision.to - decision.from + 1) + '/' + scene.frames + ' 帧）')
    await renderFrames({ work, mediaDir, size, fps, from: decision.from, to: decision.to, out: patchPath, log })
    const next = join(cacheDir, 'master.next.mkv')
    await spliceMaster({ master: cacheMaster, patch: patchPath, from: decision.from, to: decision.to, frames: scene.frames, fps, out: next, log })
    renameSync(next, cacheMaster)
    master = cacheMaster
  } else {
    log('逐帧渲染 ' + scene.frames + ' 帧（' + width + '×' + height + '@' + fps + '，光轨引擎）' + (decision.mode === 'full' && decision.reason ? '——' + decision.reason : ''))
    const tmp = cacheMaster ? join(cacheDir, 'master.next.mkv') : workMaster
    await renderFrames({ work, mediaDir, size, fps, from: 0, to: scene.frames - 1, out: tmp, log })
    if (cacheMaster) {
      renameSync(tmp, cacheMaster)
      master = cacheMaster
    }
  }
  renderSeconds = (Date.now() - tRender) / 1000
  if (cacheDir) {
    writeCacheMeta(cacheDir, {
      hash, peaks, scene, frames: scene.frames, createdAt: Date.now(),
      // 抽帧与切音的指纹：EDL 和素材没变就不用重做这两步
      person: personHash, voice: voiceHash, sceneStamp, peaksJSON,
    })
  }
  log('渲染完成：' + renderSeconds.toFixed(1) + 's（' + (scene.duration / Math.max(0.1, renderSeconds)).toFixed(2) + '× 实时）')

  // 5. 音效 + 混音
  const sfx = join(work, 'sfx.wav')
  const made = synthCues(scene.cues, scene.duration, sfx)
  const mixed = join(work, 'mixed.m4a')
  await ff(['-y', '-loglevel', 'error', '-i', voice, '-i', sfx, '-filter_complex',
    '[1:a]volume=1.0[s];[0:a][s]amix=inputs=2:duration=first:normalize=0[m]',
    '-map', '[m]', '-c:a', 'aac', '-b:a', '192k', mixed])

  // 6. 编码：按帧栅格分段，脏段新编、干净段沿用上一版（src/encode-chunks.mjs）
  mkdirSync(dirname(out), { recursive: true })
  const enc = await encodeFilm({
    master, out, mixed, frames: scene.frames, fps, log,
    dirty: decision.mode === 'patch' ? { from: decision.from, to: decision.to } : decision.mode === 'reuse' ? { none: true } : { all: true },
  })
  const encodeSeconds = enc.encodeSeconds
  return { out, renderSeconds, encodeSeconds, frames: scene.frames, cues: made.cues, decision, encode: { mode: enc.mode, window: enc.window, encoder: enc.encoder } }
}

/** 渲染项目目录：scene / peaks / template 三件套，渲染器和质检都从这儿读。 */
function writeProjectFiles(work, scene, tplJSON, peaksJSON) {
  mkdirSync(work, { recursive: true })
  if (peaksJSON) writeFileSync(join(work, 'peaks.json'), peaksJSON, 'utf8')
  writeFileSync(join(work, 'scene.json'), JSON.stringify(scene), 'utf8')
  writeFileSync(join(work, 'template.json'), tplJSON, 'utf8')
}

function readCacheMeta(cacheDir) {
  try {
    const meta = JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8'))
    if (!existsSync(join(cacheDir, 'master.mkv'))) return null
    return meta
  } catch {
    return null
  }
}

function writeCacheMeta(cacheDir, meta) {
  writeFileSync(join(cacheDir, 'meta.json'), JSON.stringify(meta), 'utf8')
}


function audioGraph(plan) {
  const speed = plan.options.speed
  const parts = []
  const ctx = []
  plan.keep.forEach(([a, b], i) => {
    parts.push('[0:a]atrim=start=' + a.toFixed(3) + ':end=' + b.toFixed(3) + ',asetpts=PTS-STARTPTS,atempo=' + speed.toFixed(3) + '[a' + i + ']')
    ctx.push('[a' + i + ']')
  })
  parts.push(ctx.join('') + 'concat=n=' + plan.keep.length + ':v=0:a=1[acc]')
  parts.push('[acc]loudnorm=I=-14:TP=-1.5:LRA=11[ac]')
  return parts.join(';')
}

export function run(cmd, args, { log = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LIGHTTRAIL_FFMPEG: FFMPEG } })
    let err = ''
    p.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log('  ' + line.trim())
    })
    p.stderr.on('data', (d) => { err += d.toString() })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim().slice(-600) || (cmd + ' 退出 ' + code)))))
  })
}