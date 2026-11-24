/**
 * 看门狗自检：静默必须判成卡死、真的把进程树杀掉、半成品清掉再重跑，
 * 而一条正常的慢渲染不许被误杀。
 *
 * 光轨那次实况是无头 Chrome 停在第 1830 帧、进程还在、日志不动，挂了 12 分钟。
 * 这些用例就用「打两行进度然后永远不动」的假渲染器复现那个状态；
 * 最后一条用真的 vendor 渲染器（给它一个起不来的 Chrome）验证真实进程链会被杀掉。
 *
 * 跑：node scripts/check-watchdog.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGuarded, isStall, StallError } from '../src/watchdog.mjs'
import { FFMPEG } from '../src/env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const dir = mkdtempSync(join(tmpdir(), 'watchdog-check-'))

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  PASS  ' + name) } else { fail++; console.log('  FAIL  ' + name + (extra ? '  ← ' + extra : '')) }
}

// 假子进程：用同一个脚本演不同故障，免得为每个用例写一个文件
const FAKE = join(dir, 'fake-child.mjs')
writeFileSync(FAKE, `import { appendFileSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
const [mode, a, b] = process.argv.slice(2)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
if (mode === 'chatty') {
  for (let i = 0; i < 6; i++) { console.log('  ' + (i * 30) + '/180 frames'); await wait(200) }
  process.exit(0)
} else if (mode === 'grow') {
  for (let i = 0; i < 12; i++) { appendFileSync(a, 'x'.repeat(1024)); await wait(200) }
  process.exit(0)
} else if (mode === 'hang') {
  console.log('  60/2052 frames')
  console.log('  1830/2052 frames')
  setInterval(() => {}, 1000)
} else if (mode === 'hang-pid') {
  writeFileSync(a, String(process.pid))
  console.log('  1830/2052 frames')
  setInterval(() => {}, 1000)
} else if (mode === 'flaky') {
  const n = existsSync(a) ? Number(readFileSync(a, 'utf8')) : 0
  writeFileSync(a, String(n + 1))
  if (n === 0) { console.log('  60/2052 frames'); setInterval(() => {}, 1000) } else { console.log('  2052/2052 frames'); process.exit(0) }
} else if (mode === 'flaky-clean') {
  const n = existsSync(a) ? Number(readFileSync(a, 'utf8')) : 0
  writeFileSync(a, String(n + 1))
  if (n === 0) { appendFileSync(b, 'half-written-master'); console.log('  60/2052 frames'); setInterval(() => {}, 1000) }
  else { console.log(existsSync(b) ? 'DIRTY' : 'CLEAN'); process.exit(0) }
} else if (mode === 'fail') {
  appendFileSync(a, '1')
  console.error('boom: renderer exploded')
  process.exit(3)
}
`)
const fake = (args) => ({ cmd: process.execPath, args: [FAKE, ...args] })

console.log('看门狗自检')

// 1. 正常在跑：不许杀
{
  const t0 = Date.now()
  await runGuarded({ ...fake(['chatty']), label: '正常渲染', stallMs: 2000 })
  const ms = Date.now() - t0
  ok('正常在跑不误杀', ms >= 1000 && ms < 8000, ms + 'ms')
}

// 2. 没有一行日志，但母版在长大：也算活着（光轨 60 帧才打一行，只看日志会误杀）
{
  const master = join(dir, 'master.mkv')
  const t0 = Date.now()
  await runGuarded({ ...fake(['grow', master]), label: '安静但在长大', stallMs: 1000, progressFiles: [master] })
  const ms = Date.now() - t0
  ok('只看日志会误杀、看产物在长就放行', ms >= 2000, ms + 'ms')
}

// 3. 静默即杀 + 重跑一次成功
{
  const counter = join(dir, 'flaky.count')
  const t0 = Date.now()
  await runGuarded({ ...fake(['flaky', counter]), label: '第一次卡死', stallMs: 600, retries: 1 })
  const n = Number(readFileSync(counter, 'utf8'))
  ok('卡死后自动重跑并跑完', n === 2, '跑了 ' + n + ' 次')
  ok('总耗时没被拖死', Date.now() - t0 < 15000, (Date.now() - t0) + 'ms')
}

// 4. 两次都卡：报 StallError，带停在哪一帧、试了几次
{
  let err = null
  try { await runGuarded({ ...fake(['hang']), label: '逐帧渲染 0–2051', stallMs: 500, retries: 1 }) } catch (e) { err = e }
  ok('两次都卡要报错，不能静默收工', isStall(err), err && err.name)
  ok('报错里带停住的帧位置', !!(err && /1830\/2052/.test(err.message)), err && err.message.slice(0, 120))
  ok('报错里带尝试次数', !!(err && /2 次尝试/.test(err.message)), err && err.message.slice(0, 160))
  ok('报错说清不是慢', !!(err && /这不是慢/.test(err.message)))
}

// 5. 卡死之后进程真的没了（只杀父进程会留孤儿）
{
  const pidFile = join(dir, 'hang.pid')
  let err = null
  try { await runGuarded({ ...fake(['hang-pid', pidFile]), label: '孤儿检查', stallMs: 500, retries: 0 }) } catch (e) { err = e }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  ok('卡死的是被真杀掉（不是放着不管）', isStall(err) && !alive, 'pid ' + pid + (alive ? ' 还活着' : ' 已退出'))
}

// 6. 半成品必须在重跑前清掉，不然下一轮把半截母版当成结果
{
  const counter = join(dir, 'clean.count')
  const marker = join(dir, 'half.mkv')
  const lines = []
  await runGuarded({ ...fake(['flaky-clean', counter, marker]), label: '半成品', stallMs: 600, retries: 1, clean: [marker], log: (m) => lines.push(m) })
  const saw = lines.join('\n')
  ok('重跑前清掉半截母版', /CLEAN/.test(saw) && !/DIRTY/.test(saw), saw.split('\n').filter((l) => /CLEAN|DIRTY/.test(l)).join(' / '))
}

// 7. 不是卡死的失败不重跑（退出码 3 原样报，掩盖真错更糟）
{
  const counter = join(dir, 'fail.count')
  let err = null
  try { await runGuarded({ ...fake(['fail', counter]), label: '真失败', stallMs: 2000, retries: 2 }) } catch (e) { err = e }
  const n = Number(readFileSync(counter, 'utf8'))
  ok('退出码非 0 不重跑，原样报错', n === 1 && /boom/.test(String(err && err.message)), '跑了 ' + n + ' 次')
}

// 8. 阈值可调：给它 3 秒就等满 3 秒再判，不早杀
{
  const t0 = Date.now()
  let err = null
  try { await runGuarded({ ...fake(['hang']), label: '阈值', stallMs: 3000, retries: 0 }) } catch (e) { err = e }
  const ms = Date.now() - t0
  ok('阈值按传入的算', ms >= 2800 && ms < 9000, ms + 'ms')
}

// 9. 真的 vendor 渲染器 + 起不来的 Chrome：/frame 永远不来，进程链必须被杀掉
{
  const proj = join(dir, 'proj')
  const media = join(dir, 'media')
  mkdirSync(proj, { recursive: true })
  mkdirSync(media, { recursive: true })
  const out = join(dir, 'real.mkv')
  const t0 = Date.now()
  let err = null
  try {
    await runGuarded({
      cmd: process.execPath,
      args: [join(ROOT, 'vendor', 'lighttrail', 'tools', 'render.mjs'),
        '--film', join(ROOT, 'templates', 'lighttrail', 'film.js'), '--project', proj, '--media', media,
        '--mode', 'frames', '--from', '0', '--to', '9', '--out', out,
        '--size', '160x120', '--chrome', process.execPath],
      // 渲染器自己按这个环境变量找 ffmpeg，不给它就会一出生就 ENOENT
      env: { ...process.env, LIGHTTRAIL_FFMPEG: FFMPEG },
      label: '真渲染器等帧', stallMs: 4000, retries: 0, progressFiles: [out],
    })
  } catch (e) { err = e }
  const ms = Date.now() - t0
  ok('真渲染器等不到帧时被判卡死', isStall(err), err && err.message.slice(0, 100))
  ok('真渲染器没有一直挂着', ms >= 3900 && ms < 30000, ms + 'ms')
}

rmSync(dir, { recursive: true, force: true })
console.log('\n' + pass + ' 条通过，' + fail + ' 条不通过')
process.exit(fail ? 1 : 0)
