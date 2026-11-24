/**
 * 每个 bot 一份配置：模型、采样参数、步数和这行的专业参数。
 *
 * 为什么按 bot 分文件（config/bots/<id>.json）：四个 bot 是四个长驻会话，模型可以不同、
 * 温度可以不同、剪辑的阈值和质检的门槛本来就不是同一个数。合在一份配置里，改剪辑的
 * 阈值要碰所有人；分开之后改谁只碰谁。
 *
 * 优先级：环境变量 > config/bots/<id>.json > 这里的默认值。
 * 文件缺了或某字段写坏了，就用默认值顶上并记一条 problem —— 一个坏配置不该让整条片子
 * 停住，但也不能静默吞掉（自检脚本 check-bots 会把 problems 打出来）。
 *
 * 这里只管「这个 bot 怎么说话、怎么说判断标准」；它能调哪些工具在 agent/tools.mjs 里，
 * 身份和红线在 bots/roster.mjs 里。三件事分开，改一件不牵连另外两件。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BOTS } from './roster.mjs'

// 配置目录可覆盖（VISION_BOTS_CONFIG_DIR）：自检写临时目录，客户也可以把配置放到别处
const DIR_OVERRIDE = process.env.VISION_BOTS_CONFIG_DIR || null
const DIR = DIR_OVERRIDE ? DIR_OVERRIDE.replace(/[\\/]+$/, '') + '/' : fileURLToPath(new URL('../../config/bots/', import.meta.url))

/** 默认值就是「文件全丢了也能跑」的那一份。改口味改 config/bots/*.json，别改这里。 */
export const DEFAULTS = {
  producer: {
    model: 'smart',
    temperature: null,
    maxTokens: 700,
    maxSteps: 10,
    timeoutMs: 60000,
    params: { warnAfterDispatch: 2, maxDispatches: 4 },
  },
  cutter: {
    model: 'smart',
    temperature: 0,
    maxTokens: 700,
    maxSteps: 6,
    timeoutMs: 90000,
    params: {
      pauseThreshold: 0.45,
      keepHead: 0.1,
      keepTail: 0.14,
      minSegment: 0.6,
      leadIn: 0.15,
      tailOut: 0.3,
      gap: { period: 0.3, comma: 0.22, cut: 0.08, none: 0.2 },
      seam: { searchMs: 250, quietMs: 25, thresholdDb: -34, nudge: 0.012 },
      dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 },
      maxDeleteShare: 0.3,
      filler: {
        enabled: true,
        minGapSec: 0.12,
        words: ['嗯', '啊', '呃', '哎', '哦', '唉'],
        markers: ['那个', '就是说', '你知道吧', '然后就是', '这个这个'],
      },
    },
  },
  packer: {
    model: 'fast',
    temperature: 0,
    maxTokens: 700,
    maxSteps: 6,
    timeoutMs: 90000,
    params: { reuseMaster: true, patchMaxShare: 0.45 },
  },
  qc: {
    model: 'fast',
    temperature: 0,
    maxTokens: 700,
    maxSteps: 6,
    timeoutMs: 90000,
    params: { tolerance: 0.12, minWordConfidence: 0.25, maxLowConfidenceShare: 0.08 },
  },
}

const MODEL_ALIASES = new Set(['fast', 'smart'])
const KNOWN = new Set(['model', 'temperature', 'maxTokens', 'maxSteps', 'timeoutMs', 'params'])

const isObj = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const clone = v => (Array.isArray(v) ? v.map(clone) : isObj(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) : v)

/** 深合并：后者的标量覆盖前者，两边的对象逐键合。数组整体替换，不做拼接。 */
export function deepMerge(a, b) {
  const out = clone(a)
  for (const [k, v] of Object.entries(b || {})) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v)
    else out[k] = clone(v)
  }
  return out
}

function readFile(id) {
  const p = DIR + id + '.json'
  if (!existsSync(p)) return { file: null, data: null }
  try {
    const raw = readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    const data = JSON.parse(raw)
    if (!isObj(data)) return { file: p, data: null, problem: id + '.json 的最外层不是对象，整份没用' }
    return { file: p, data }
  } catch (err) {
    return { file: p, data: null, problem: id + '.json 解析不了：' + err.message }
  }
}

/** 一个字段一个字段地查：类型不对就用默认值，并说清是哪一条。 */
function sanitize(id, data, problems) {
  const d = DEFAULTS[id]
  const out = { model: d.model, temperature: d.temperature, maxTokens: d.maxTokens, maxSteps: d.maxSteps, timeoutMs: d.timeoutMs, params: clone(d.params) }

  for (const key of Object.keys(data || {})) {
    if (key.startsWith('_') || KNOWN.has(key)) continue
    problems.push(id + '.json 里有不认识的字段「' + key + '」，没用上')
  }

  if (data && data.model !== undefined) {
    const m = data.model
    if (typeof m === 'string' && (MODEL_ALIASES.has(m) || m.trim().length)) out.model = m.trim()
    else problems.push(id + '.json 的 model 不是字符串，用默认 ' + d.model)
  }
  if (data && data.temperature !== undefined) {
    const t = data.temperature
    if (t === null) out.temperature = null
    else if (typeof t === 'number' && t >= 0 && t <= 2) out.temperature = t
    else problems.push(id + '.json 的 temperature 要在 0–2 之间（或 null 表示用服务端默认），用默认 ' + d.temperature)
  }
  for (const [key, min, max] of [['maxTokens', 64, 8000], ['maxSteps', 1, 20], ['timeoutMs', 2000, 600000]]) {
    if (!data || data[key] === undefined) continue
    const v = data[key]
    if (Number.isInteger(v) && v >= min && v <= max) out[key] = v
    else problems.push(id + '.json 的 ' + key + ' 要是 ' + min + '–' + max + ' 的整数，用默认 ' + d[key])
  }
  if (data && data.params !== undefined) {
    if (!isObj(data.params)) problems.push(id + '.json 的 params 不是对象，整份 params 用默认')
    else out.params = deepMerge(d.params, data.params)
  }
  return out
}

/** 环境变量覆盖：VISION_BOTS_<ID>_MODEL / _TEMPERATURE / _MAX_STEPS。只影响这一个 bot。 */
function fromEnv(id, cfg, problems) {
  const p = 'VISION_BOTS_' + id.toUpperCase() + '_'
  const out = { ...cfg, params: clone(cfg.params) }
  const raw = process.env
  if (raw[p + 'MODEL']) out.model = String(raw[p + 'MODEL']).trim()
  if (raw[p + 'TEMPERATURE'] !== undefined && raw[p + 'TEMPERATURE'] !== '') {
    const t = Number(raw[p + 'TEMPERATURE'])
    if (Number.isFinite(t) && t >= 0 && t <= 2) out.temperature = t
    else problems.push(p + 'TEMPERATURE 不是 0–2 的数，忽略')
  }
  if (raw[p + 'MAX_STEPS']) {
    const n = Number(raw[p + 'MAX_STEPS'])
    if (Number.isInteger(n) && n >= 1 && n <= 20) out.maxSteps = n
    else problems.push(p + 'MAX_STEPS 不是 1–20 的整数，忽略')
  }
  return out
}

const cache = new Map()
let problems = []

/** 读盘一次，之后走内存。测试改完配置调 resetBotConfig()。 */
export function resetBotConfig() {
  cache.clear()
  problems = []
}

/**
 * 这个 bot 的完整配置。返回冻结对象：拿到之后不许就地改，改了会影响别的调用方。
 * 未知 bot 返回 null（不抛——调用方要先能用 byId 判）。
 */
export function botConfig(id) {
  if (cache.has(id)) return cache.get(id)
  if (!DEFAULTS[id]) return null
  const { data, problem } = readFile(id)
  if (problem) problems.push(problem)
  let cfg = sanitize(id, data, problems)
  cfg = fromEnv(id, cfg, problems)
  const name = (BOTS.find(b => b.id === id) || {}).name || id
  const frozen = Object.freeze({ id, name, ...cfg, source: problem ? 'default' : data ? 'file' : 'default' })
  cache.set(id, frozen)
  return frozen
}

/** 全四个。给自检和资产页用。 */
export function allBotConfigs() {
  return BOTS.map(b => botConfig(b.id)).filter(Boolean)
}

/** 这个 bot 的专业参数（剪辑阈值、质检门槛……） */
export function paramsOf(id) {
  const c = botConfig(id)
  return c ? c.params : {}
}

/** 配置读盘时遇到的问题（缺字段、写坏、不认识的键）。空数组 = 干净。 */
export function configProblems() {
  for (const b of BOTS) botConfig(b.id)
  return [...problems]
}
