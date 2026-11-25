/**
 * 本机模型客户端：制片人接需求和错字治理共用一套配置、超时和失败口径。
 *
 * 这里只负责把话说给模型、把话说回来；判断合不合法是调用方的事（brief.mjs 有校验器，
 * asr-fix.mjs 有纠错校验器）。任何失败都返回 {ok:false, skipped}，绝不抛出——
 * 模型连不上不该让一条片子停在半路。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { botConfig } from './bots/config.mjs'
import { proposalKey, cacheRead, cacheWrite } from './proposal-cache.mjs'

/**
 * 本机配置文件：config/llm.local.json（.gitignore 排除，密钥只落在这里和我们自己的环境变量）。
 * 优先级：环境变量 > 配置文件 > 默认值。所以在客户机器上换模型只改这个文件，不动代码。
 */
const LOCAL = fileURLToPath(new URL('../config/llm.local.json', import.meta.url))

function readLocal() {
  if (!existsSync(LOCAL)) return {}
  try { return JSON.parse(readFileSync(LOCAL, 'utf8').replace(/^\uFEFF/, '')) || {} } catch { return {} }
}

const local = readLocal()
const env = process.env

/**
 * 多路网关：模型名可以带路由前缀，形如 "codesome:claude-opus-5-5"。
 *
 * 为什么要有它（2026-11-25 接 Opus 时定的）：本机网关（qwen3.8）和外部网关（codesome 上的
 * claude-opus-5-5）是两家服务——base 不同、凭证不同、请求体允许的字段也不同。把 base 写死在
 * LLM.base 里就只能整条产线一起换；而用户要的是「提案侧换 Opus，规则、音频证据、时间码都不变」。
 * 所以让模型名自带路由：不带前缀走默认网关（行为与以前逐字节一致），带了就走那家网关。
 *
 * 每家网关多几个开关，都是被实测打回来的：
 *   noTemperature  —— Opus 5.5 开着 thinking 时 temperature 只许是 1，传 0 直接 400；
 *   noThinkingFlag —— 它没有 enable_thinking 这个字段，是 vLLM 系网关的方言；
 *   minMaxTokens / minTimeoutMs —— 思考与回答共用预算、单次 25–49s；
 *   extraBody      —— 网关方言（output_config.effort），只许加字段，不许改产线硬约束。
 */
const ROUTES = (() => {
  const raw = local.routes || {}
  const out = {}
  for (const [name, r] of Object.entries(raw)) {
    if (!r || typeof r !== 'object' || !r.base) continue
    const up = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
    out[name] = {
      base: String(env['DSH_MEDIA_LLM_BASE_' + up] || r.base).replace(/\/$/, ''),
      key: env['DSH_MEDIA_LLM_KEY_' + up] ? String(env['DSH_MEDIA_LLM_KEY_' + up]) : (r.key ? String(r.key) : null),
      models: r.models || {},
      noTemperature: Boolean(r.noTemperature),
      noThinkingFlag: Boolean(r.noThinkingFlag),
      minTimeoutMs: Number(r.minTimeoutMs) || 0,
      // 思考模型的 max_tokens 是「思考 + 回答」共用的预算：任务只要 700 token 的输出，
      // 但思考能吃光 1200，返回空 content（自测30 第一次接 Opus 就是这样：asks=0 / skipped=empty）。
      // 所以路由可以给一个下限——不是改任务预算，而是保证任务预算之上还有思考的空间。
      minMaxTokens: Number(r.minMaxTokens) || 0,
      // 这家网关自己的方言（比如 Anthropic 的 output_config.effort）原样带过去。
      // 只许加减字段，不许改 model / messages / max_tokens / temperature / tools——那几样是产线的硬约束。
      extraBody: r.extraBody && typeof r.extraBody === 'object' ? r.extraBody : null,
    }
  }
  return out
})()

export const LLM = {
  base: env.DSH_MEDIA_LLM_BASE || local.base || 'http://127.0.0.1:10100/v1',
  routes: ROUTES,
  model: env.DSH_MEDIA_LLM_MODEL || local.model || (local.models && local.models.smart) || 'gpt-6-luna--fast',
  // 两档就够：fast 用在每片必经的检查（错字、语义审读），smart 用在要判断力的地方（读需求、写标题）
  models: {
    fast: env.DSH_MEDIA_LLM_FAST || (local.models && local.models.fast) || env.DSH_MEDIA_LLM_MODEL || local.model || 'gpt-6-luna--fast',
    smart: env.DSH_MEDIA_LLM_SMART || (local.models && local.models.smart) || env.DSH_MEDIA_LLM_MODEL || local.model || 'gpt-6-luna--fast',
  },
  timeoutMs: Number(env.DSH_MEDIA_LLM_TIMEOUT_MS || local.timeoutMs || 45000),
  /**
   * 是否允许模型先思考。默认 false，原因是实测：deepseek-flash / MiniMax-M3 这类思考模型
   * 会把 max_tokens 全部烧在 reasoning_content 上，content 返回空字符串，finish_reason=length。
   * 我们的活都是「按格式输出 JSON」，不需要长思考；真要思考就把这个开关打开并给足 4000+ 预算。
   */
  thinking: String(env.DSH_MEDIA_LLM_THINKING || (local.thinking === true ? 'on' : 'off')) === 'on',
  source: env.DSH_MEDIA_LLM_BASE ? 'env' : (local.base ? 'config/llm.local.json' : 'default'),
}

/**
 * 把一个模型名解成「问哪家网关、用哪个 key、允不允许温度/思考字段」。
 * 纯函数，routes 可注入——离线断言不许联网，也不该依赖本机的 config/llm.local.json。
 */
export function resolveModel(model, routes = LLM.routes) {
  const s = String(model || '')
  const k = s.indexOf(':')
  if (k > 0) {
    const name = s.slice(0, k)
    const mid = s.slice(k + 1)
    const r = routes && routes[name]
    if (r && mid && r.base) {
      return {
        model: mid,
        base: r.base,
        key: r.key || null,
        noTemperature: Boolean(r.noTemperature),
        noThinkingFlag: Boolean(r.noThinkingFlag),
        minTimeoutMs: Number(r.minTimeoutMs) || 0,
        minMaxTokens: Number(r.minMaxTokens) || 0,
        extraBody: r.extraBody && typeof r.extraBody === 'object' ? r.extraBody : null,
        route: name,
      }
    }
  }
  return { model: s || LLM.model, base: LLM.base, key: null, noTemperature: false, noThinkingFlag: false, minTimeoutMs: 0, minMaxTokens: 0, extraBody: null, route: null }
}

/**
 * 这个 bot 这一轮用什么模型、什么温度、多少步。
 *
 * 每个 bot 一份配置（config/bots/<id>.json）：model 可以写别名 fast / smart（映射到
 * llm.local.json 的两档），也可以写完整模型名。四个 bot 各走各的，改一个不影响另一个。
 * 连 base/key 都不用动——那是「这家网关怎么连」，不是「这个 bot 怎么想」。
 */
export function callProfile(botId) {
  const cfg = botConfig(botId)
  if (!cfg) return { model: LLM.model, temperature: null, maxTokens: 700, maxSteps: 8, timeoutMs: LLM.timeoutMs, source: 'fallback' }
  const alias = cfg.model
  return {
    model: LLM.models[alias] || alias || LLM.model,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    maxSteps: cfg.maxSteps,
    timeoutMs: cfg.timeoutMs,
    source: cfg.source,
  }
}

/** 界面上显示用：这个 bot 实际连的是哪个模型。 */
export function modelFor(botId) {
  return callProfile(botId).model
}

/**
 * 界面上的模型名：去掉路由前缀。
 * "codesome:claude-opus-5-5" 是「哪家网关 + 哪个模型」，客户要看的只是「claude-opus-5-5」；
 * 路由是接线细节，露在名册上只会让人以为模型叫 codesome。
 */
export function modelLabel(botId) {
  return resolveModel(callProfile(botId).model).model
}

/**
 * 产线里的一次模型调用用哪套参数。**分镜、大字、整句删、错字治理、语义审读都必须走这里。**
 *
 * 为什么要有它（自测 19–21 的根因之一）：四个 bot 的配置（config/bots/<id>.json）里写着
 * 「剪辑 smart、温度 0」「包装 fast、温度 0、''同一个数不许报两遍''」，可真正产出片子的那几次
 * 调用一直绕开这份配置：各自硬写 LLM.models.fast、不传温度。于是——
 *   · 同一素材连跑五次，分镜 13/9/9/11/12 段、整句删时有时无（温度用了服务端默认，不是 0）；
 *   · 客户把剪辑换成更强的模型（比如接 Opus）时，改字和选句这些真正决定成败的调用根本没换。
 * 配置是声明，产线是执行；声明不落到执行上，就是两句空话。
 *
 * 语义（三条，别加第四条）：
 *   · model / temperature 听 bot 配置——换模型、钉温度只改 config/bots/<id>.json；
 *   · maxTokens / timeoutMs 由任务决定（调用点给了就用它的）：一次调用要多少 token 是输出格式
 *     定的（24 张字幕卡压不进 700 token），超时是这一步愿意等多久（读需求只等 15 秒）。
 *     调用点没给才用 bot 的配置。这两样跟着任务走，配置不会悄悄改掉某一步的预算和耐心；
 *   · temperature = null 表示这个 bot 用服务端默认（producer.json 明确这么写：判断可以有点随机，
 *     只有需要复现的地方才钉死）。
 */
export function taskCall(botId, { maxTokens = null, timeoutMs = null } = {}) {
  const p = callProfile(botId)
  const tok = Number(maxTokens) || Number(p.maxTokens) || 700
  const to = Number(timeoutMs) || Number(p.timeoutMs) || LLM.timeoutMs
  return {
    bot: botId,
    model: p.model,
    temperature: p.temperature === undefined ? null : p.temperature,
    maxTokens: tok,
    timeoutMs: to,
    source: p.source,
  }
}

/**
 * 证据对：第一只模型出提案，第二只模型逐字同意才算证据。
 * 同一只模型问两遍不构成第二条独立事实，所以两个位置**必须是不同的模型**。
 * 换模型（比如接 Opus）只换第一只，第二只自动退到另一档；两只一样时返回 distinct:false，
 * 调用方据此跳过第二意见并照实说「凑不出第二意见」，绝不能拿同一只模型自己同意自己。
 */
export function pairFor(primary, models = LLM.models) {
  const fast = models && models.fast
  const smart = models && models.smart
  const auditor = primary === smart ? fast : smart
  return { primary, auditor, distinct: Boolean(auditor) && auditor !== primary }
}

/** 凭证：环境变量 > 本机配置文件 > codex 登录态。不入库、不打印。 */
export function readKey() {
  if (env.DSH_MEDIA_LLM_KEY) return env.DSH_MEDIA_LLM_KEY
  if (local.key) return String(local.key)
  const p = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(p)) return null
  try {
    const a = JSON.parse(readFileSync(p, 'utf8'))
    return a.tokens?.access_token || a.OPENAI_API_KEY || null
  } catch {
    return null
  }
}

/** 给「模型到底通没通」这类报错和自检用，不含密钥。 */
export function llmStatus() {
  const routes = {}
  for (const [k, v] of Object.entries(LLM.routes || {})) routes[k] = { base: v.base, models: v.models, key: Boolean(v.key), noTemperature: v.noTemperature }
  return { model: LLM.model, models: LLM.models, base: LLM.base, key: Boolean(readKey()), routes, thinking: LLM.thinking, source: LLM.source }
}

/**
 * 请求体：路由决定了哪些字段能给、哪些绝不能给。
 *
 * 抽成纯函数是为了「离线断言不许联网」：调用方给一份假的 target，就能验
 * 「Opus 这类网关不会被塞 temperature / enable_thinking」「思考预算下限生效」
 * 「工具表照常传」，不用真的花钱问一次模型。
 */
export function requestBody({ target, messages, maxTokens = 700, temperature = null, thinking = LLM.thinking, tools = null, toolChoice = null } = {}) {
  return {
    model: target.model,
    messages,
    // 思考模型的下限不是改任务预算，而是在任务预算之上留出思考空间（见 routes 的 minMaxTokens）
    max_tokens: Math.max(Number(maxTokens) || 0, Number(target.minMaxTokens) || 0) || maxTokens,
    // 抽取类任务（纠错、读需求）要可复现：不给温度就用服务端默认，同一句话两次结果不一样
    ...(temperature === null || target.noTemperature ? {} : { temperature }),
    // 这个网关（TokenRouter / vLLM 系）认 enable_thinking；Opus 那类网关没有这个字段
    ...(target.noThinkingFlag ? {} : (thinking ? {} : { enable_thinking: false })),
    // 给 bot 用的函数调用：模型只能选工具和传参，不能自己写时间码
    ...(tools && tools.length ? { tools, tool_choice: toolChoice || 'auto' } : {}),
    // 路由自带的方言字段：只许加，不许盖掉上面这几样硬约束
    ...extraOf(target),
  }
}

const CORE_FIELDS = ['model', 'messages', 'max_tokens', 'temperature', 'enable_thinking', 'tools', 'tool_choice']
function extraOf(target) {
  const raw = target && target.extraBody
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(raw)) if (!CORE_FIELDS.includes(k)) out[k] = v
  return out
}

/**
 * 一次纯文本调用。返回 {ok, content, ms, tokens, model} 或 {ok:false, skipped, detail, ms}。
 * skipped: no-key / http-<code> / timeout / unreachable / empty
 *
 * 思考型路由多一层重试（2026-11-25 接 Opus 实测）：思考与回答共用 max_tokens，
 * 29 句的选句题一次思考要 2200–3000 token，偶尔直接把预算烧光——HTTP 200、finish_reason=length、
 * 正文空白。这不是模型说「没什么可删」，是它还没开口就被掐断了；不重试就等于把这一票丢了，
 * 而选句要靠多票过半。所以只对「声明了思考下限的路由」重试一次、预算翻倍。
 * 重试是基础设施行为：不改变问题、不改变答案的含义，也不替模型下结论。
 */
export function shouldRetryEmpty(result, target) {
  if (!result || result.ok) return false
  if (result.skipped !== 'empty' || result.finishReason !== 'length') return false
  return Boolean(target && Number(target.minMaxTokens) > 0)
}

export async function chat(opts = {}) {
  const first = await chatOnce(opts)
  if (shouldRetryEmpty(first, resolveModel(opts.model || LLM.model))) {
    const budget = Math.max(700, Number(opts.maxTokens) || 0) * 2
    const again = await chatOnce({ ...opts, maxTokens: budget, timeoutMs: (Number(opts.timeoutMs) || LLM.timeoutMs) * 2 })
    return { ...again, retried: true, firstMs: first.ms }
  }
  return first
}

async function chatOnce({ prompt, system = null, messages: given = null, maxTokens = 700, timeoutMs = LLM.timeoutMs, model = null, tools = null, toolChoice = null, temperature = null } = {}) {
  // 模型名自带路由（"codesome:claude-opus-5-5"）：base / key / 允许的字段都跟着它走。
  // 不带前缀时 target.base 就是 LLM.base、key 为 null 再退回 readKey()——老路径一个字节没变。
  const target = resolveModel(model || LLM.model)
  const key = target.key || readKey()
  if (!key) return { ok: false, skipped: 'no-key' }
  // 两种用法：给 prompt 一次性问完（读需求、纠错），或给 messages 自己管多轮（bot 的会话）
  let messages = []
  if (Array.isArray(given) && given.length) messages = given.map(m => ({ ...m }))
  else {
    if (system) messages.push({ role: 'system', content: String(system) })
    messages.push({ role: 'user', content: String(prompt) })
  }

  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, Number(timeoutMs) || 0, target.minTimeoutMs))
  try {
    const res = await fetch(target.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify(requestBody({ target, messages, maxTokens, temperature, thinking: LLM.thinking, tools, toolChoice })),
      signal: ctl.signal,
    })
    const text = await res.text()
    const ms = Date.now() - t0
    // 出问题时要能看见「网关到底回了什么」：只在显式打开时落一份到文件，平时零成本。
    // 为什么不打印到日志：里面是完整请求体和模型原话，日志是给人看的，不是给排查用的。
    if (env.VISION_BOTS_LLM_TRACE) {
      try {
        appendFileSync(env.VISION_BOTS_LLM_TRACE, JSON.stringify({ at: new Date().toISOString(), route: target.route, model: target.model, status: res.status, ms, request: requestBody({ target, messages, maxTokens, temperature, thinking: LLM.thinking, tools, toolChoice }), response: text.slice(0, 20000) }) + '\n', 'utf8')
      } catch { /* 记账失败不影响调用 */ }
    }
    if (!res.ok) return { ok: false, skipped: 'http-' + res.status, detail: text.slice(0, 200), ms }
    const j = JSON.parse(text)
    const msg = j.choices?.[0]?.message || {}
    const content = msg.content || ''
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const finishReason = j.choices?.[0]?.finish_reason || null
    // 只调工具不回话是合法的一步（finish_reason=tool_calls），不能当空回复
    if (!content.trim() && !toolCalls.length) return { ok: false, skipped: 'empty', ms, finishReason }
    return { ok: true, content, toolCalls, finishReason, ms, tokens: j.usage?.total_tokens ?? null, model: j.model || target.model, route: target.route }
  } catch (err) {
    const ms = Date.now() - t0
    return { ok: false, skipped: err.name === 'AbortError' ? 'timeout' : 'unreachable', detail: String(err.message).slice(0, 160), ms }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从模型输出里抠出第一段完整的 JSON。模型偶尔会包一层 ```json 或加一句客套话，
 * 所以不用 JSON.parse 硬吃全文：从第一个 { 或 [ 开始做括号配对，字符串里的括号不算。
 */
export function extractJSON(text) {
  const s = String(text || '')
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== '{' && c !== '[') continue
    const open = c
    const close = c === '{' ? '}' : ']'
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < s.length; j++) {
      const ch = s[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === open) depth++
      else if (ch === close) {
        depth--
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, j + 1)) } catch { break }
        }
      }
    }
  }
  return null
}

/**
 * 提案缓存：模型不保证可复现（同一输入连问两次会给出两套分镜——温度钉 0 也一样，
 * 详见 src/proposal-cache.mjs 的头注），所以产线要「问过一次就记住」。
 * 由 handler 在开跑前指定目录（groups/<id>/proposals）；没指定就退回直连模型。
 */
let PROPOSAL_DIR = null
export function useProposalCache(dir) {
  PROPOSAL_DIR = dir || null
  return PROPOSAL_DIR
}
export function proposalCacheDir() {
  return PROPOSAL_DIR
}
const cacheKeyFor = (opts, kind) => proposalKey({
  prompt: opts.prompt || '', system: opts.system || '', messages: opts.messages || null,
  model: opts.model || LLM.model, temperature: opts.temperature === undefined ? null : opts.temperature,
  maxTokens: opts.maxTokens === undefined ? null : opts.maxTokens, kind, salt: opts.salt || '',
})

/**
 * 带缓存的纯文本调用（错字治理的提案走这条）：命中就交回上次那份原文，不再问模型。
 * 返回值多一个 cached:true 和 askedAt（这份是哪天问出来的）。
 */
export async function chatCached(opts = {}) {
  const key = cacheKeyFor(opts, 'text')
  const hit = cacheRead(PROPOSAL_DIR, key)
  if (hit && typeof hit.content === 'string') {
    return { ok: true, content: hit.content, toolCalls: [], model: hit.model || opts.model || LLM.model, ms: 0, tokens: null, cached: true, askedAt: hit.at || null }
  }
  const r = await chat(opts)
  if (r.ok) cacheWrite(PROPOSAL_DIR, key, { kind: 'text', content: r.content, model: r.model, askedAt: new Date().toISOString() })
  return r
}

/**
 * 带缓存的 JSON 调用（分镜 / 大字 / 整句删 / 语义审读走这条）。
 * 只缓存解析成功的那份：模型输出坏了不记，下次还会重问。
 */
export async function chatJSONCached(opts = {}) {
  const key = cacheKeyFor(opts, 'json')
  const hit = cacheRead(PROPOSAL_DIR, key)
  if (hit && hit.value && typeof hit.value === 'object') {
    return { ok: true, value: hit.value, model: hit.model || opts.model || LLM.model, ms: 0, tokens: null, cached: true, askedAt: hit.at || null }
  }
  const r = await chatJSON(opts)
  if (r.ok) cacheWrite(PROPOSAL_DIR, key, { kind: 'json', value: r.value, model: r.model, askedAt: new Date().toISOString() })
  return r
}

/** 一次 JSON 调用：{ok, value, ms, tokens, model} 或 {ok:false, skipped}。value 解析不出来时 skipped='bad-json'。 */
export async function chatJSON(opts = {}) {
  const r = await chat(opts)
  if (!r.ok) return r
  const value = extractJSON(r.content)
  if (value === null || typeof value !== 'object') return { ...r, ok: false, skipped: 'bad-json', content: r.content.slice(0, 200) }
  return { ...r, value }
}
