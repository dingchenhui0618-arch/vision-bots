/**
 * 光轨 · 渲染驱动：抽帧 → 切音 → 包络 → 逐帧渲染 → 音效 → 混音 → 编码。
 * 除了渲染器本身，其它每一步都是 ffmpeg 的确定性操作，跑一次的结果可以复现。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCanvasTools, FFMPEG } from '../../src/env.mjs'
import { ff } from '../../src/ffmpeg.mjs'
import { synthCues, peaksFromPCM } from '../../src/sfx.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER = join(HERE, '..', '..', 'vendor', 'lighttrail', 'tools', 'render.mjs')
const FILM = join(HERE, 'film.js')

export async function renderLighttrail({ input, plan, scene, work, out, log = () => {}, stills = null, force = false }) {
  const { fonts, chrome } = assertCanvasTools()
  const [width, height] = scene.size
  const fps = scene.fps
  const mediaDir = join(work, 'media')
  const frameDir = join(mediaDir, 'frames', 'person')
  mkdirSync(frameDir, { recursive: true })

  // 1. 抽帧：按 EDL 的每段切，帧号连续，成片帧 → 源帧的映射写在 scene.person.ranges
  const t0 = Date.now()
  let n = 0
  for (const [i, r] of scene.person.ranges.entries()) {
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
  log('抽帧完成：' + readdirSync(frameDir).length + ' 帧 · ' + ((Date.now() - t0) / 1000).toFixed(1) + 's')

  // 2. 切音：和成片同一条时间线（trim → concat → atempo → loudnorm）
  const voice = join(work, 'voice.wav')
  await ff(['-y', '-loglevel', 'error', '-i', input, '-filter_complex', audioGraph(plan), '-map', '[ac]',
    '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1', voice])

  // 3. 声波包络：从切完的人声里量，画出来的波形和耳朵听到的一致
  const pcm = await ff(['-v', 'error', '-i', voice, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { encoding: 'buffer' })
  writeFileSync(join(work, 'peaks.json'), JSON.stringify(peaksFromPCM(pcm.stdout)), 'utf8')
  writeFileSync(join(work, 'scene.json'), JSON.stringify(scene), 'utf8')
  // 布局是模板的一部分，不是内容：引擎直接读它，画幅换了时间线一个字不动。
  writeFileSync(join(work, 'template.json'), readFileSync(join(HERE, 'template.json'), 'utf8').replace(/^\uFEFF/, ''), 'utf8')

  // 4. 逐帧渲染（无头 Chrome + ANGLE）
  const master = join(work, 'master.mkv')
  const tRender = Date.now()
  const reuseMaster = !stills && !force && existsSync(master)
  if (!reuseMaster) log('逐帧渲染 ' + scene.frames + ' 帧（' + width + '×' + height + '@' + fps + '，光轨引擎）')
  const shotDir = join(work, 'stills')
  const pick = stills
    ? ['--mode', 'stills', '--stills', stills.map(Number).join(','), '--out-dir', shotDir]
    : ['--mode', 'frames', '--from', '0', '--to', String(scene.frames - 1), '--out', master]
  if (reuseMaster) log('复用已有画面母版（master.mkv），只重做声音与编码')
  else await run(process.execPath, [
    RENDERER, '--film', FILM, '--project', work, '--media', mediaDir,
    ...pick, '--size', width + 'x' + height, '--samples', '4',
    '--fonts', fonts, '--chrome', chrome,
  ], { log })
  const renderSeconds = (Date.now() - tRender) / 1000
  log('渲染完成：' + renderSeconds.toFixed(1) + 's（' + (scene.duration / renderSeconds).toFixed(2) + '× 实时）')
  if (stills) return { stills: shotDir, renderSeconds, frames: scene.frames }

  // 5. 音效 + 混音
  const sfx = join(work, 'sfx.wav')
  const made = synthCues(scene.cues, scene.duration, sfx)
  const mixed = join(work, 'mixed.m4a')
  await ff(['-y', '-loglevel', 'error', '-i', voice, '-i', sfx, '-filter_complex',
    '[1:a]volume=1.0[s];[0:a][s]amix=inputs=2:duration=first:normalize=0[m]',
    '-map', '[m]', '-c:a', 'aac', '-b:a', '192k', mixed])

  // 6. 编码
  mkdirSync(dirname(out), { recursive: true })
  await ff(['-y', '-loglevel', 'error', '-i', master, '-i', mixed,
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-maxrate', '8M', '-bufsize', '16M',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', out])

  return { out, renderSeconds, frames: scene.frames, cues: made.cues }
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

function run(cmd, args, { log = () => {} } = {}) {
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
