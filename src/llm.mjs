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

export const LLM = {
  base: process.env.DSH_MEDIA_LLM_BASE || 'http://127.0.0.1:10100/v1',
  model: process.env.DSH_MEDIA_LLM_MODEL || 'gpt-6-luna--fast',
  timeoutMs: Number(process.env.DSH_MEDIA_LLM_TIMEOUT_MS || 45000),
}

/** OpenCodex 的凭证：环境变量优先，其次是本机 codex 登录态。不入库、不打印。 */
export function readKey() {
  if (process.env.DSH_MEDIA_LLM_KEY) return process.env.DSH_MEDIA_LLM_KEY
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
  return { model: LLM.model, base: LLM.base, key: Boolean(readKey()) }
}

/**
 * 一次纯文本调用。返回 {ok, content, ms, tokens, model} 或 {ok:false, skipped, detail, ms}。
 * skipped: no-key / http-<code> / timeout / unreachable / empty
 */
export async function chat({ prompt, system = null, maxTokens = 700, timeoutMs = LLM.timeoutMs } = {}) {
  const key = readKey()
  if (!key) return { ok: false, skipped: 'no-key' }
  const messages = []
  if (system) messages.push({ role: 'system', content: String(system) })
  messages.push({ role: 'user', content: String(prompt) })

  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, timeoutMs))
  try {
    const res = await fetch(LLM.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: LLM.model, messages, max_completion_tokens: maxTokens }),
      signal: ctl.signal,
    })
    const text = await res.text()
    const ms = Date.now() - t0
    if (!res.ok) return { ok: false, skipped: 'http-' + res.status, detail: text.slice(0, 200), ms }
    const j = JSON.parse(text)
    const content = j.choices?.[0]?.message?.content || ''
    if (!content.trim()) return { ok: false, skipped: 'empty', ms }
    return { ok: true, content, ms, tokens: j.usage?.total_tokens ?? null, model: j.model || LLM.model }
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
