/**
 * ASR 错字治理：热词注入 + 受约束纠错层。
 *
 * 第一层在转写前——术语表塞进 initial_prompt，让它一开始就别写错。
 * 第二层在转写后——术语表确定性命中，再加模型按「词位索引」提修改，全部过校验器才落地。
 *
 * 硬约束（这是这个模块存在的理由，破了就退回原样报错，绝不静默）：
 *   1. 只改词文本。词数不变，每个词的 start/end 一个字节都不许动。
 *   2. 每条改动必须能验：同音字查拼音一致，专有名词命中术语表，数字必须是数字，标点只加不换字。
 *   3. 校验不过的一律打回并记账，模型说的「我已改好」不作数。
 *   4. 本机没有拼音校验能力时进保守模式：只做术语表和数字，模型提的同音修正不采纳。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** execFile 不收 stdin，拼音查询要喂 JSON，所以自己开管道。 */
function runStdin(cmd, args, input, { timeout = 120000, maxBuffer = 4 << 20 } = {}) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { ch.kill(); reject(new Error('timeout')) }, timeout)
    ch.stdout.setEncoding('utf8').on('data', d => { if (out.length < maxBuffer) out += d })
    ch.stderr.setEncoding('utf8').on('data', d => { if (err.length < 8192) err += d })
    ch.on('error', e => { clearTimeout(timer); reject(e) })
    ch.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err || 'exit ' + code))
    })
    ch.stdin.end(input)
  })
}

const UV = join(homedir(), '.local', 'bin', 'uv.exe')
const PY = fileURLToPath(new URL('../tools/pinyin.py', import.meta.url))
const ROOT = fileURLToPath(new URL('../', import.meta.url))

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
const strip = s => String(s ?? '').replace(PUNCT, '')
const LOW_P = 0.6
const MAX_FIXES = words => Math.max(4, Math.ceil(words.length * 0.08))

export const LLM = {
  base: process.env.DSH_MEDIA_LLM_BASE || 'http://127.0.0.1:10100/v1',
  model: process.env.DSH_MEDIA_LLM_MODEL || 'gpt-6-luna--fast',
  timeoutMs: 45000,
}

function readKey() {
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

/** 术语表：仓库默认 + 群级覆盖。 */
export function loadTerms(groupDir = null) {
  const out = []
  const sources = []
  for (const p of [join(ROOT, 'config', 'terms.json'), groupDir ? join(groupDir, 'terms.json') : null]) {
    if (!p || !existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      for (const t of j.terms || []) if (t && t.to && Array.isArray(t.from) && t.from.length) out.push(t)
      out.hotwords = [...(out.hotwords || []), ...(j.hotwords || [])]
      sources.push(p)
    } catch { /* 术语表坏了不阻断出片 */ }
  }
  out.hotwords = [...new Set(out.hotwords || [])]
  out.sources = sources
  return out
}

/** 转写用的热词串。 */
export function hotwordPrompt(terms, max = 180) {
  const words = [...new Set([...(terms.hotwords || []), ...terms.map(t => t.to)])].filter(Boolean)
  let s = ''
  for (const w of words) {
    if (s.length + w.length + 1 > max) break
    s += (s ? '、' : '') + w
  }
  return s
}

function replaceIn(word, from, to) {
  const i = word.indexOf(from)
  if (i < 0) return null
  const before = word.slice(0, i)
  const after = word.slice(i + from.length)
  return { text: before + to + after, at: i }
}

/**
 * 术语表确定性替换：只换词内文本，长度变了就不换（避免字幕回流和字位错位）。
 */
export function applyTerms(words, terms) {
  const out = words.map(w => ({ ...w }))
  const hits = []
  const skipped = []
  for (const t of terms) {
    for (const from of t.from) {
      for (let i = 0; i < out.length; i++) {
        const w = out[i]
        if (w.fixed) continue
        // 带 next 的条目只在「下一个词以其中之一开头」时生效：
        // ASR 常把「划走」拆成「化」+「走」两个词，单字条目得靠后一个词定位。
        if (t.next) {
          const nx = strip(out[i + 1]?.w ?? '')
          const want = Array.isArray(t.next) ? t.next : [t.next]
          if (!want.some(x => nx.startsWith(x))) continue
        }
        const r = replaceIn(String(w.w), from, t.to)
        if (!r) continue
        if (t.onlyIfLowConfidence && typeof w.p === 'number' && w.p >= 0.85) {
          skipped.push({ i, at: +w.start.toFixed(2), from, to: t.to, why: '识别置信度够高，术语表不覆盖' })
          continue
        }
        if (strip(r.text).length !== strip(w.w).length) {
          skipped.push({ i, at: +w.start.toFixed(2), from, to: t.to, why: '字数不一致，会撑破字幕卡' })
          continue
        }
        out[i] = { ...w, w: r.text, w0: w.w0 || w.w, fixed: true }
        hits.push({
          i, at: +w.start.toFixed(2), from, to: t.to, kind: t.kind || 'term', why: '术语表命中',
          verified: t.next ? `术语表命中（后接「${[].concat(t.next).join('/')}」）` : '术语表命中',
        })
      }
    }
  }
  return { words: out, hits, skipped }
}

/** 拼音校验（一次性批量）。本机没有 pypinyin 就返回 null，由调用方降级。 */
export async function pinyinOf(items) {
  if (!items.length) return []
  const payload = JSON.stringify({ items })
  try {
    const stdout = await runStdin(existsSync(UV) ? UV : 'python', [
      ...(existsSync(UV) ? ['run', '--python', '3.12', '--with', 'pypinyin', 'python'] : []),
      PY,
    ], payload)
    const j = JSON.parse(String(stdout).trim().split('\n').at(-1))
    if (!j.ok) return null
    return j.items.map(x => (x.known ? x.py : null))
  } catch {
    return null
  }
}

function wordsForPrompt(words) {
  const lines = []
  for (let i = 0; i < words.length; i++) {
    const p = typeof words[i].p === 'number' && words[i].p < 0.8 ? `?(${words[i].p.toFixed(2)})` : ''
    lines.push(`${i}:${words[i].w}${p}`)
  }
  return lines.join(' ')
}

const PROMPT = (wordList) => `你是中文口播字幕的错字校对。下面是 ASR 原始词序列，格式「词位:词」，低置信词后面跟着 ?(概率)。

${wordList}

只找这四类错：同音字（如「画走」应为「划走」）、专有名词（如「斗音」应为「抖音」）、数字（如「三分之一」写成「3分之一」）、标点缺失。
每条修改必须是：
1. 只换一个词的文本，字数与原词相同；
2. 不许改写、润色、调顺序、合并或拆分词；
3. 没把握就不要改——漏一个错字可以忍，改错一个字是事故。

输出 JSON 数组，元素为 {"i": 词位数字, "to": "改正后的词", "kind": "homophone|term|number|punct", "why": "不超过 12 字的理由"}。
没有要改的输出 []。不要输出任何其他文字。`

async function callModel(wordList) {
  const key = readKey()
  if (!key) return { skipped: 'no-key' }
  const t0 = Date.now()
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), LLM.timeoutMs)
  try {
    const res = await fetch(LLM.base.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: LLM.model,
        messages: [{ role: 'user', content: PROMPT(wordList) }],
        max_completion_tokens: 900,
      }),
      signal: ctl.signal,
    })
    const text = await res.text()
    if (!res.ok) return { skipped: `http-${res.status}`, detail: text.slice(0, 200) }
    const j = JSON.parse(text)
    const content = j.choices?.[0]?.message?.content || ''
    const m = content.match(/\[[\s\S]*\]/)
    const proposals = m ? JSON.parse(m[0]) : []
    return { proposals, ms: Date.now() - t0, model: j.model || LLM.model, tokens: j.usage?.total_tokens ?? null }
  } catch (err) {
    return { skipped: err.name === 'AbortError' ? 'timeout' : 'unreachable', detail: String(err.message).slice(0, 160) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 校验模型提的修改。返回 {accepted, rejected}，每条都带原因。
 */
export async function validate(proposals, words, { terms, pinyin }) {
  const accepted = []
  const rejected = []
  const cap = MAX_FIXES(words)
  const seen = new Set()
  const list = Array.isArray(proposals) ? proposals : []

  const pairs = []
  for (const p of list) {
    const i = Number(p && p.i)
    if (!Number.isInteger(i) || i < 0 || i >= words.length) { rejected.push({ ...p, why: '词位越界' }); continue }
    const w = words[i]
    const to = String(p.to ?? '').trim()
    const kind = String(p.kind || '').trim()
    if (!to) { rejected.push({ i, from: w.w, why: '改成空词' }); continue }
    if (/\s/.test(to)) { rejected.push({ i, from: w.w, to, why: '一个词位里塞了空格' }); continue }
    if (seen.has(i)) { rejected.push({ i, from: w.w, to, why: '同一个词位改了两次' }); continue }
    if (strip(to) === strip(w.w)) { rejected.push({ i, from: w.w, to, why: '改完和原来一样' }); continue }
    if (strip(to).length !== strip(w.w).length) { rejected.push({ i, from: w.w, to, why: '字数变了，会撑破字幕卡' }); continue }
    if (!['homophone', 'term', 'number', 'punct'].includes(kind)) { rejected.push({ i, from: w.w, to, why: '不在允许的四类里：' + (kind || '空') }); continue }
    if (kind === 'punct') { rejected.push({ i, from: w.w, to, why: '标点类被字幕层统一剥掉，无需改' }); continue }
    if (kind === 'number') {
      if (!/^[0-9一二三四五六七八九十百千万零两几半.]+$/.test(strip(to))) {
        rejected.push({ i, from: w.w, to, why: '声称是数字但不是数字' }); continue
      }
      // 数字类只修「本来就是阿拉伯数字、但写错了」的情况，两个方向都拦：
      // 把「三秒」改成「3秒」不是纠错是改写；把「3」改成「三」同理。
      // 不统一数字写法是有意的——「一个人」绝不能变成「1个人」。
      if (!/[0-9]/.test(strip(w.w)) || !/[0-9]/.test(strip(to))) {
        rejected.push({ i, from: w.w, to, why: '不是阿拉伯数字写错，属于改写，不动' }); continue
      }
    }
    if (kind === 'term') {
      const known = terms.some(t => t.to === strip(to))
      if (!known) { rejected.push({ i, from: w.w, to, why: '术语表里没有这个词，专有名词改不了自证' }); continue }
    }
    pairs.push({ p, i, w, to, kind })
  }

  // 同音字要验拼音：一个字都不能差
  const needPinyin = pairs.filter(x => x.kind === 'homophone')
  // pinyin 传 null 表示「本机已知不可用」；传 undefined / 其他表示待探测
  let pyOk = pinyin !== null
  const originals = needPinyin.map(x => strip(x.w.w))
  const targets = needPinyin.map(x => strip(x.to))
  const py = pyOk && needPinyin.length ? await pinyinOf([...originals, ...targets]) : null
  if (needPinyin.length && !py) pyOk = false

  for (const x of pairs) {
    if (accepted.length >= cap) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: `超过本轮上限 ${cap} 处` }); continue }
    if (x.kind === 'homophone') {
      if (!pyOk) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '本机没有拼音校验，保守模式不采纳同音改动' }); continue }
      const k = needPinyin.indexOf(x)
      const a = py[k]
      const b = py[needPinyin.length + k]
      if (!a || !b) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '拼音查不到，无法验证同音' }); continue }
      if (a !== b) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: `不同音：${a} vs ${b}` }); continue }
      accepted.push({ i: x.i, at: +x.w.start.toFixed(2), from: x.w.w, to: x.to, kind: x.kind, why: String(x.p.why || '').slice(0, 40), verified: `拼音 ${a} 一致` })
    } else {
      accepted.push({ i: x.i, at: +x.w.start.toFixed(2), from: x.w.w, to: x.to, kind: x.kind, why: String(x.p.why || '').slice(0, 40), verified: x.kind === 'term' ? '命中术语表' : '数字位数未变' })
    }
    seen.add(x.i)
  }
  return { accepted, rejected, pinyinMode: pyOk ? 'on' : 'off' }
}

/**
 * 纠错只改词，但章节和字幕用的是句子文本：句子也得跟着改。
 * 不跟着改的话，画面上大字还是错的（第一版就踩了这个坑——字幕对了，片子里还是「化走」）。
 */
export function applyToSegments(words, segments) {
  return (segments || []).map(s => {
    const inside = words.filter(w => w.start >= s.start - 0.02 && w.end <= s.end + 0.02)
    const text = inside.map(w => w.w).join('')
    return text && text.length ? { ...s, text } : { ...s }
  })
}

/**
 * 主入口。返回 {words, report}。
 */
export async function correct({ words, terms, log = () => {}, askModel = true }) {
  const t0 = Date.now()
  const baseline = JSON.stringify(words.map(w => [w.start, w.end]))

  const g = applyTerms(words, terms)
  let current = g.words
  const report = {
    at: new Date().toISOString(),
    hotwords: hotwordPrompt(terms),
    termSources: terms.sources || [],
    glossary: { applied: g.hits, skipped: g.skipped },
    model: null,
    applied: [...g.hits],
    rejected: [],
    pending: [],
    assertion: null,
  }

  if (askModel) {
    const wordList = wordsForPrompt(current)
    const r = await callModel(wordList)
    if (r.skipped) {
      report.model = { skipped: r.skipped, detail: r.detail || null }
      log('错字纠错：模型没接上（' + r.skipped + '），只做了术语表')
    } else {
      // 拼音可用性由 validate 内部按需探测，这里不预判
      const v = await validate(r.proposals || [], current, { terms })
      report.model = { ok: true, model: r.model, ms: r.ms, tokens: r.tokens, proposals: (r.proposals || []).length, pinyinMode: v.pinyinMode }
      report.applied.push(...v.accepted)
      report.rejected.push(...v.rejected)
      const byIndex = new Map(v.accepted.map(a => [a.i, a]))
      current = current.map((w, i) => byIndex.has(i) ? { ...w, w: byIndex.get(i).to, w0: w.w0 || w.w } : w)
    }
  }

  report.pending = current
    .map((w, i) => ({ i, at: +w.start.toFixed(2), w: w.w, p: w.p }))
    .filter(x => typeof x.p === 'number' && x.p < LOW_P && !report.applied.some(a => a.i === x.i))

  const after = JSON.stringify(current.map(w => [w.start, w.end]))
  report.assertion = {
    wordCount: words.length === current.length,
    timingUntouched: baseline === after,
  }
  if (!report.assertion.wordCount || !report.assertion.timingUntouched) {
    throw new Error('纠错层动了时间码或词数，已中止（这是硬约束）')
  }
  report.stats = {
    words: current.length,
    changed: report.applied.length,
    rejected: report.rejected.length,
    pending: report.pending.length,
    ms: Date.now() - t0,
  }
  const aiAccepted = report.applied.length - g.hits.length
  log(`错字治理：术语表 ${g.hits.length} 处 · 模型 ${report.model && report.model.ok ? report.model.proposals + ' 提案 / ' + aiAccepted + ' 采纳' : '未接'} · 打回 ${report.rejected.length} · 待确认 ${report.pending.length}`)
  return { words: current, report }
}
