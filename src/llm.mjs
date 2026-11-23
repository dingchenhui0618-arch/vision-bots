/**
 * 本机模型客户端：制片人接需求和错字治理共用一套配置、超时和失败口径。
 *
 * 这里只负责把话说给模型、把话说回来；判断合不合法是调用方的事（brief.mjs 有校验器，
 * asr-fix.mjs 有纠错校验器）。任何失败都返回 {ok:false, skipped}，绝不抛出——
 * 模型连不上不该让一条片子停在半路。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

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

export const LLM = {
  base: env.DSH_MEDIA_LLM_BASE || local.base || 'http://127.0.0.1:10100/v1',
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
  return { model: LLM.model, models: LLM.models, base: LLM.base, key: Boolean(readKey()), thinking: LLM.thinking, source: LLM.source }
}

/**
 * 一次纯文本调用。返回 {ok, content, ms, tokens, model} 或 {ok:false, skipped, detail, ms}。
 * skipped: no-key / http-<code> / timeout / unreachable / empty
 */
export async function chat({ prompt, system = null, messages: given = null, maxTokens = 700, timeoutMs = LLM.timeoutMs, model = null, tools = null, toolChoice = null } = {}) {
  const key = readKey()
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
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs))
  try {
    const res = await fetch(LLM.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: model || LLM.model,
        messages,
        max_tokens: maxTokens,
        // 这个网关（TokenRouter / vLLM 系）认 enable_thinking；不认的服务器会忽略这个字段
        ...(LLM.thinking ? {} : { enable_thinking: false }),
        // 给 bot 用的函数调用：模型只能选工具和传参，不能自己写时间码
        ...(tools && tools.length ? { tools, tool_choice: toolChoice || 'auto' } : {}),
      }),
      signal: ctl.signal,
    })
    const text = await res.text()
    const ms = Date.now() - t0
    if (!res.ok) return { ok: false, skipped: 'http-' + res.status, detail: text.slice(0, 200), ms }
    const j = JSON.parse(text)
    const msg = j.choices?.[0]?.message || {}
    const content = msg.content || ''
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    const finishReason = j.choices?.[0]?.finish_reason || null
    // 只调工具不回话是合法的一步（finish_reason=tool_calls），不能当空回复
    if (!content.trim() && !toolCalls.length) return { ok: false, skipped: 'empty', ms, finishReason }
    return { ok: true, content, toolCalls, finishReason, ms, tokens: j.usage?.total_tokens ?? null, model: j.model || model || LLM.model }
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

/** 一次 JSON 调用：{ok, value, ms, tokens, model} 或 {ok:false, skipped}。value 解析不出来时 skipped='bad-json'。 */
export async function chatJSON(opts = {}) {
  const r = await chat(opts)
  if (!r.ok) return r
  const value = extractJSON(r.content)
  if (value === null || typeof value !== 'object') return { ...r, ok: false, skipped: 'bad-json', content: r.content.slice(0, 200) }
  return { ...r, value }
}
