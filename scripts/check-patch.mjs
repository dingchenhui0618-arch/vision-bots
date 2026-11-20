/**
 * 分段缓存自检：改一句 → 只重渲那一段 → 拼回去，必须和整条重渲是同一张画。
 *
 *   node scripts/check-patch.mjs [--group talk-0hqfc]
 *
 * 四条都要过：
 *   1. 帧数不变
 *   2. 改动之外的帧：和旧母版逐帧一致（真的是切出来的，不是重渲的）
 *   3. 改动之内的帧：和整条重渲逐帧一致（拼出来的画面是对的；按 PSNR 判，
 *      因为 GPU 着色器有 ±1 级舍入，同一帧两次渲染偶尔就差一个最低位）
 *   4. 改动区间真的变了，且分段重渲比整条重渲快
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ff } from '../src/ffmpeg.mjs'
import { hashOf, planPatch, spliceMaster } from '../src/render-cache.mjs'
import { renderFrames } from '../templates/lighttrail/render.mjs'

const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const ROOT = process.cwd()
const group = arg('group', 'talk-0hqfc')
const workBase = join(ROOT, 'groups', group, 'work')

function findWork() {
  for (const d of readdirSync(workBase)) {
    const w = join(workBase, d)
    if (existsSync(join(w, 'master.mkv')) && existsSync(join(w, 'scene.json')) && existsSync(join(w, 'peaks.json'))) return w
  }
  return null
}

async function framemd5(file) {
  const r = await ff(['-v', 'error', '-i', file, '-f', 'framemd5', '-'], { encoding: 'utf8' })
  return r.stdout.trim().split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').pop().trim())
}

async function clip(src, from, to, out) {
  await ff(['-y', '-loglevel', 'error', '-i', src,
    '-vf', 'trim=start_frame=' + from + ':end_frame=' + (to + 1) + ',setpts=PTS-STARTPTS',
    '-an', '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', '-pix_fmt', 'gbrp', out])
  return out
}

/** 逐帧 PSNR：同一张画 = 高 PSNR；画面不同 = PSNR 掉到 30 上下 */
let psnrSeq = 0
async function framePsnr(a, b) {
  // stats_file 走相对路径 + 正斜杠：Windows 的盘符冒号会被当成分隔符，滤镜串直接解析失败
  const stats = '.test/seg/psnr-' + (psnrSeq++) + '.log'
  mkdirSync('.test/seg', { recursive: true })
  await ff(['-hide_banner', '-loglevel', 'error', '-i', a, '-i', b, '-lavfi', 'psnr=stats_file=' + stats, '-f', 'null', '-'])
  const lines = readFileSync(stats, 'utf8').trim().split('\n')
  return lines.map(l => {
    const m = l.match(/psnr_avg:(\S+)/)
    return m ? (m[1] === 'inf' ? Infinity : Number(m[1])) : NaN
  })
}

const work = findWork()
if (!work) {
  console.log('没有可用母版（需要 groups/' + group + '/work/<run>/master.mkv）')
  process.exit(1)
}
const scene = JSON.parse(readFileSync(join(work, 'scene.json'), 'utf8'))
const fps = scene.fps
const master = join(work, 'master.mkv')
const mediaDir = join(work, 'media')
const proj = join(work, 'patchcheck')
mkdirSync(proj, { recursive: true })
for (const f of ['template.json', 'peaks.json']) copyFileSync(join(work, f), join(proj, f))

// 挑一章改一个字：把「划走」改成「溜走」，长度一样，只动这一章
const idx = scene.bigs.findIndex(b => /划走/.test(b.text))
const pick = idx >= 0 ? idx : scene.bigs.length - 1
const target = scene.bigs[pick]
const next = JSON.parse(JSON.stringify(scene))
const nb = next.bigs[pick]
const fixed = nb.text.replace('划走', '溜走')
nb.text = fixed
nb.words = nb.words.map(w => w.replace('划', '溜'))
for (const k of nb.chars || []) if (k.ch === '划') k.ch = '溜'
for (const b of next.beats || []) {
  if (b.f0 >= nb.f0 - 0.01 && b.f0 <= nb.f1 + 0.01) {
    b.text = b.text.replace('划走', '溜走')
    for (const k of b.chars || []) if (k.ch === '划') k.ch = '溜'
  }
}
writeFileSync(join(proj, 'scene.json'), JSON.stringify(next), 'utf8')

const tplJSON = readFileSync(join(work, 'template.json'), 'utf8')
const hash = hashOf(tplJSON, readFileSync(join(ROOT, 'templates', 'lighttrail', 'film.js'), 'utf8'))
const peaks = hashOf(readFileSync(join(work, 'peaks.json'), 'utf8'))
const decision = planPatch({ prev: { scene, hash, peaks }, next: { scene: next, hash, peaks }, fps })

console.log('素材：' + group + '  ' + scene.frames + ' 帧 · ' + scene.duration + 's')
console.log('改了第 ' + (pick + 1) + ' 章：「' + target.text + '」→「' + fixed + '」')
console.log('判定：' + decision.mode + '（' + decision.reason + '）')
if (decision.mode !== 'patch') {
  console.log('FAIL · 这种改动应该走分段重渲，判定成了 ' + decision.mode)
  process.exit(1)
}

const patchPath = join(proj, 'patch.mkv')
const tPatch = Date.now()
await renderFrames({ work: proj, mediaDir, size: scene.size, fps, from: decision.from, to: decision.to, out: patchPath })
const patched = join(proj, 'patched.mkv')
await spliceMaster({ master, patch: patchPath, from: decision.from, to: decision.to, frames: scene.frames, fps, out: patched, log: (m) => console.log('  ' + m) })
const patchSeconds = (Date.now() - tPatch) / 1000

const tFull = Date.now()
const full = join(proj, 'full.mkv')
await renderFrames({ work: proj, mediaDir, size: scene.size, fps, from: 0, to: scene.frames - 1, out: full })
const fullSeconds = (Date.now() - tFull) / 1000
console.log('分段重渲：' + patchSeconds.toFixed(1) + 's（' + (decision.to - decision.from + 1) + ' 帧）')
console.log('整条重渲：' + fullSeconds.toFixed(1) + 's（' + scene.frames + ' 帧）')

const [oldM, patchedM] = await Promise.all([framemd5(master), framemd5(patched)])
let fail = 0
const check = (name, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (detail ? '：' + detail : ''))
  if (!ok) fail++
}

check('帧数不变', patchedM.length === scene.frames, patchedM.length + '/' + scene.frames)
let outsideBad = []
let changed = 0
for (let i = 0; i < scene.frames; i++) {
  const inWindow = i >= decision.from && i <= decision.to
  if (!inWindow && patchedM[i] !== oldM[i]) outsideBad.push(i)
  if (inWindow && patchedM[i] !== oldM[i]) changed++
}
check('改动之外的帧没被碰过', outsideBad.length === 0, outsideBad.length ? '前几个：' + outsideBad.slice(0, 5).join(',') : (scene.frames - (decision.to - decision.from + 1)) + ' 帧和旧母版逐帧一致')

const winOld = await clip(master, decision.from, decision.to, join(proj, 'win-old.mkv'))
const winNew = await clip(patched, decision.from, decision.to, join(proj, 'win-new.mkv'))
const psnrPatched = await framePsnr(winNew, await clip(full, decision.from, decision.to, join(proj, 'win-full.mkv')))
const psnrOld = await framePsnr(winNew, winOld)
const minP = Math.min(...psnrPatched)
check('改动区间 === 整条重渲（逐帧 PSNR）', minP >= 50, '最低 ' + (minP === Infinity ? '∞' : minP.toFixed(1)) + ' dB（' + psnrPatched.length + ' 帧）')
// 改一个字只动画面上一小块，PSNR 不会掉很低；判「变了没有」看的是「有没有帧和旧画面完全一样」
const same = psnrOld.filter(p => p === Infinity).length
check('改动区间确实变了', same === 0 && changed >= psnrOld.length * 0.9,
  changed + '/' + psnrOld.length + ' 帧换过，' + same + ' 帧和旧画面完全相同')
check('分段重渲比整条重渲快', patchSeconds < fullSeconds, patchSeconds.toFixed(1) + 's vs ' + fullSeconds.toFixed(1) + 's（省 ' + Math.round((1 - patchSeconds / fullSeconds) * 100) + '%）')

console.log(fail ? 'FAIL · ' + fail + ' 项没过' : 'PASS · 改一句只重渲那一句，其余帧从母版切，画面等于整条重渲')
process.exit(fail ? 1 : 0)
