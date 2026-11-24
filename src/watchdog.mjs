/**
 * 长任务看门狗：静默 ≠ 慢。
 *
 * 光轨逐帧渲染实跑过一次「停在第 1830 帧、进程还在、日志不动」，挂了 12 分钟才被人发现。
 * 渲染器不报错，它只是安静地等一批永远不来的帧——这种错没法用一刀切的超时兜住
 * （正常一次整条渲染就要 6–7 分钟），只能靠「还有没有在动」来判断。
 *
 * 判活的两个信号：
 *   1. 子进程 stdout / stderr 有输出
 *   2. 产物文件（母版 mkv / 采样 json）在长大——渲染器 60 帧才打一行日志，
 *      只看日志会把一条正常的片误杀
 *
 * 两个都不动、且已静默 stallMs：判卡死。之后的动作是确定的：
 * 杀掉整个进程树（node 渲染器 + 无头 Chrome + ffmpeg；只杀父进程会留下孤儿 Chrome），
 * 删掉这一次的半成品，再按调用方给的次数重跑。重跑还卡就把「静默多久、
 * 最后一行输出是什么、试了几次」原样报上去，绝不静默收工。
 */
import { spawn, spawnSync } from 'node:child_process'
import { rmSync, statSync } from 'node:fs'

/** 默认 90s：逐帧渲染每 60 帧打一行，1080×1920 下约 12s 一行；文件还在长的话另算。 */
export const STALL_MS = Number(process.env.VISION_BOTS_STALL_MS) || 90_000

export class StallError extends Error {
  constructor({ label, silentMs, attempts = 1, lastLine = '' }) {
    const where = lastLine ? '，最后一行输出是「' + lastLine + '」' : '，全程没有任何输出'
    super((label || '任务') + '卡住了：' + Math.max(1, Math.round(silentMs / 1000)) + 's 没有输出、产物也不再增长' +
      where + '。已杀掉进程树' +
      (attempts > 1 ? '，' + attempts + ' 次尝试都卡在同一步' : '') +
      '。这不是慢，是没有新帧再产生——重跑一次；还卡就查无头 Chrome 和显存。')
    this.name = 'StallError'
    this.stalled = true
    this.label = label
    this.silentMs = silentMs
    this.attempts = attempts
    this.lastLine = lastLine
  }
}

export function isStall(e) {
  return !!(e && e.name === 'StallError')
}

function sizeOf(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

/** 杀掉整个进程树：Windows 用 taskkill /T，POSIX 靠进程组（spawn 时 detached）。 */
export function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* 已经退了 */ }
  }
}

function attempt({ cmd, args, env, log, label, stallMs, progressFiles }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      windowsHide: true,
      // POSIX 要独立进程组才杀得掉整棵树
      detached: process.platform !== 'win32',
    })
    let lastActivity = Date.now()
    let lastLine = ''
    let err = ''
    let settled = false
    const seen = new Map(progressFiles.map((p) => [p, sizeOf(p)]))
    const alive = () => { lastActivity = Date.now() }

    child.stdout.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) {
        const t = line.trim()
        if (!t) continue
        lastLine = t
        log('  ' + t)
      }
      alive()
    })
    child.stderr.on('data', (d) => {
      const s = d.toString()
      err += s
      const t = s.trim().split(/\r?\n/).filter(Boolean).pop()
      if (t) lastLine = t
      alive()
    })

    const timer = setInterval(() => {
      for (const p of progressFiles) {
        const now = sizeOf(p)
        if (now !== seen.get(p)) { seen.set(p, now); alive() }
      }
      if (settled) return
      const silent = Date.now() - lastActivity
      if (silent < stallMs) return
      settled = true
      clearInterval(timer)
      killTree(child.pid)
      reject(new StallError({ label, silentMs: silent, lastLine }))
    }, 1000)

    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      reject(e)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearInterval(timer)
      if (code === 0) resolve({ code })
      else reject(new Error(err.trim().slice(-600) || (cmd + ' 退出 ' + code)))
    })
  })
}

/**
 * 跑一个可能卡住的长任务。
 *
 * @param stallMs     静默多久判卡死
 * @param retries     卡死之后重跑几次（只有卡死才重跑；退出码非 0 原样报错，不重跑）
 * @param progressFiles 产物文件：它在长大就算活着
 * @param clean       重跑前要删掉的半成品
 */
export async function runGuarded({
  cmd, args, env = process.env, log = () => {}, label = '',
  stallMs = STALL_MS, retries = 0, progressFiles = [], clean = [],
}) {
  const total = retries + 1
  let last = null
  for (let i = 1; i <= total; i++) {
    try {
      return await attempt({ cmd, args, env, log, label, stallMs, progressFiles })
    } catch (e) {
      last = e
      if (!isStall(e)) throw e
      if (i === total) break
      for (const p of clean) {
        try { rmSync(p, { force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* 占着就让它被覆盖 */ }
      }
      log('（第 ' + i + ' 次）' + (label || '任务') + '静默 ' + Math.round(e.silentMs / 1000) + 's 卡死' +
        (e.lastLine ? '（停在「' + e.lastLine + '」）' : '') + '，进程树已杀，半成品已清，重跑。')
    }
  }
  throw new StallError({
    label: last.label || label, silentMs: last.silentMs, attempts: total, lastLine: last.lastLine,
  })
}
