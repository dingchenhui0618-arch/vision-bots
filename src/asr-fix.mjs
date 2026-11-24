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
 *   4. 本机没有拼音校验能力时进保守模式：只做术语表和数字，模型提的同音/近音修正不采纳。
 *
 * 两种「改法」都支持：
 *   - 单词改字：{"i": 162, "to": "天"}，字数必须与原词一致。
 *   - 跨词重排：{"i": 160, "n": 3, "to": "花一天"}，几个相邻词的文字合起来重排，
 *     总字数不变、按原词字长重新分配。ASR 把词切错了位置时（「视频/频」这种）只能这么改。
 *
 * 四类允许的错：同音（拼音全等）、近音（韵母+声调一致、声母不同）、专有名词（命中术语表）、
 * 数字（只修阿拉伯数字写错）。近音最危险——「千」和「天」本来就不同音，凭什么说它错？
 * 所以近音要多一条独立证据：改动范围前后 3 个词里必须有低置信词（ASR 自己就在犯嘀咕），
 * 而且全片最多 2 处。没有这条证据，近音一律打回。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chat, LLM } from './llm.mjs'

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
// 近音纠错：韵母+声调一致、声母不同。证据要求见文件头。
const NEAR_WINDOW = 3
const NEAR_CAP = 2
const NEAR_P = 0.65
// 整段纠错（第二遍，按句子读）：ASR 的真错常常是一整段
// （「指纹住在做内容」实际说的是「真正在做内容」），按词一个个看永远看不出来。
// 约束不放松：字数不变、词数不变、时间码不动；全片最多 SPAN_CAP 处，逐条写进交付报告。
const SPAN_CAP = 3
const SPAN_P = 0.85
// 标点字符集（不带 g，避免 test() 的 lastIndex 状态）
const PUNCT_CH = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/u
const KINDS = ['homophone', 'term', 'number', 'near', 'span', 'punct']

// 模型配置、凭证和超时统一在 llm.mjs：制片人和错字治理不能各配一套。

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

/** 拼音原始查询，一次批量。返回 {ok, items} 或 null。 */
async function runPinyin(items) {
  if (!items.length) return { ok: true, items: [] }
  const payload = JSON.stringify({ items })
  try {
    const stdout = await runStdin(existsSync(UV) ? UV : 'python', [
      ...(existsSync(UV) ? ['run', '--python', '3.12', '--with', 'pypinyin', 'python'] : []),
      PY,
    ], payload)
    const j = JSON.parse(String(stdout).trim().split('\n').at(-1))
    return j && j.ok ? j : null
  } catch {
    return null
  }
}

/** 不带声调的全拼（同音校验）。本机没有 pypinyin 就返回 null，由调用方降级。 */
export async function pinyinOf(items) {
  const j = await runPinyin(items)
  if (!j) return null
  return j.items.map(x => (x.known ? x.py : null))
}

/** 声母 + 韵母带声调（近音校验）。返回 [{py, ini, fin}] 或 null。 */
export async function phoneticOf(items) {
  const j = await runPinyin(items)
  if (!j) return null
  return j.items.map(x => (x.known
    ? { py: x.py, ini: j0(x.ini), fin: j0(x.fin) }
    : null))

  function j0(v) { return Array.isArray(v) ? v : [...String(v ?? '')] }
}

// ── 词文本的切分与重排：标点留在原位，只动字 ──
function splitAffixes(text) {
  const s = String(text ?? '')
  let a = 0
  let b = s.length
  while (a < b && PUNCT_CH.test(s[a])) a++
  while (b > a && PUNCT_CH.test(s[b - 1])) b--
  return { lead: s.slice(0, a), core: s.slice(a, b), trail: s.slice(b) }
}

/**
 * 把 n 个相邻词的文字按「原词字长」重新分配 to。
 * 总字数必须不变——字幕卡宽度、断行、时间码都靠这个不变式。
 */
export function applySpan(words, i, n, to) {
  if (!Number.isInteger(n) || n < 1) return { error: '跨词数目不对' }
  if (i < 0 || i + n > words.length) return { error: '跨词区间越界' }
  const cores = []
  const affixes = []
  for (let k = 0; k < n; k++) {
    const p = splitAffixes(words[i + k].w)
    if (!p.core.length) return { error: '要改的片段里有空词' }
    affixes.push({ lead: p.lead, trail: p.trail })
    cores.push(p.core)
  }
  const want = String(to ?? '')
  if (PUNCT_CH.test(want)) return { error: '要改的内容里带了标点，标点由字幕层统一处理' }
  const chars = [...want]
  const total = cores.reduce((a, c) => a + [...c].length, 0)
  if (chars.length !== total) return { error: `字数变了：原 ${total} 字，改成 ${chars.length} 字，会撑破字幕卡` }
  const parts = []
  let at = 0
  for (let k = 0; k < n; k++) {
    const len = [...cores[k]].length
    parts.push(affixes[k].lead + chars.slice(at, at + len).join('') + affixes[k].trail)
    at += len
  }
  return { parts, cores, total, text: chars.join('') }
}

/** 近音的证据：改动范围前后 3 个词里有没有 ASR 自己没把握的词。 */
function nearWitness(words, i, n) {
  const from = Math.max(0, i - NEAR_WINDOW)
  const to = Math.min(words.length - 1, i + n - 1 + NEAR_WINDOW)
  for (let k = from; k <= to; k++) {
    if (typeof words[k].p === 'number' && words[k].p < NEAR_P) {
      return { i: k, w: words[k].w, p: Number(words[k].p.toFixed(2)) }
    }
  }
  return null
}

// ── 第二遍：句子视图 ──
// 只保留能被词完整覆盖的句子（词落在段的时间范围内），句子文本用词的核心字拼，
// 标点留在 affix 里不参与替换——和 applySpan 的口径一致。

export function sentenceView(words, segments) {
  const out = []
  for (const s of segments || []) {
    const ws = []
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (w.start >= s.start - 0.02 && w.end <= s.end + 0.02) {
        ws.push({ i, core: splitAffixes(w.w).core, p: w.p })
      }
    }
    if (!ws.length) continue
    const text = ws.map(x => x.core).join('')
    if (text.length < 4) continue
    out.push({ s, ws, text })
  }
  return out
}

/** from 在句子里定位到词区间；切在词中间就不认（那会把半个词改成别的字）。 */
function locateInSentence(v, from) {
  const at = v.text.indexOf(from)
  if (at < 0) return { error: 'from 不在这句里逐字出现' }
  if (v.text.indexOf(from, at + 1) >= 0) return { error: 'from 在这句里出现两次以上，定位不了' }
  const bounds = [0]
  for (const w of v.ws) bounds.push(bounds[bounds.length - 1] + w.core.length)
  if (!bounds.includes(at)) return { error: 'from 起点切在词中间' }
  const end = at + from.length
  if (!bounds.includes(end)) return { error: 'from 终点切在词中间' }
  const a = bounds.indexOf(at)
  const b = bounds.indexOf(end) - 1
  if (b < a) return { error: 'from 是空的' }
  return { a, b }
}

async function callSentenceReview(view) {
  const lines = view.map((v, k) => `${k + 1}|${v.text}`).join('\n')
  const t0 = Date.now()
  try {
    const r = await chat({ prompt: SENT_PROMPT(lines), maxTokens: 1200, model: LLM.models.fast, temperature: 0 })
    if (!r.ok) return { skipped: r.skipped, detail: r.detail || null }
    const m = r.content.match(/\[[\s\S]*\]/)
    const proposals = m ? JSON.parse(m[0]) : []
    return { proposals, ms: Date.now() - t0, model: r.model, tokens: r.tokens }
  } catch (err) {
    return { skipped: 'unreachable', detail: String(err.message).slice(0, 160) }
  }
}

/**
 * 整段替换的校验。证据分三档，从强到弱：
 *
 *   1. 整段同音（逐字拼音全等，声调、声母、韵母都不管）——「直到」→「知道」、「网道」→「王道」。
 *      这一档不需要置信度证据。whisper 对这种错恰恰很自信（实测 0.90–0.99），
 *      拿「低置信」当门槛等于把对的改法挡在门外（自测07 实测：对的 5 处全被这条挡掉）。
 *   2. 改出来的是术语表里的词（GDP → GPT）。
 *   3. 整段都是 ASR 自己没把握的词（语义型：捡→搞、指纹住在→真正在做）。
 *      这一档最弱：能改对也能改坏，所以全片最多 SPAN_CAP 处，逐条写进交付报告让人能复核。
 *
 * 硬约束一条都不放松：等字数、词数不变、时间码不动、from 必须逐字出现且落在词边界上。
 */
export async function validateSpans(proposals, words, view, { skip = new Set(), cap = SPAN_CAP, terms = [], pinyin, strongOnly = false } = {}) {
  const accepted = []
  const rejected = []
  const seen = new Set(skip)
  const cand = []
  for (const p of Array.isArray(proposals) ? proposals : []) {
    const k = Number(p && p.s)
    if (!Number.isInteger(k) || k < 1 || k > view.length) { rejected.push({ ...p, why: '句子序号越界' }); continue }
    const from = String((p && p.from) ?? '')
    const to = String((p && p.to) ?? '').trim()
    if (!from || !to) { rejected.push({ s: k, why: 'from / to 是空的' }); continue }
    if (/\s/.test(to)) { rejected.push({ s: k, from, to, why: '改成的内容里有空格' }); continue }
    const v = view[k - 1]
    const loc = locateInSentence(v, from)
    if (loc.error) { rejected.push({ s: k, from, to, why: loc.error }); continue }
    const i = v.ws[loc.a].i
    const n = loc.b - loc.a + 1
    let clash = false
    for (let j = 0; j < n; j++) if (seen.has(i + j)) clash = true
    if (clash) { rejected.push({ s: k, from, to, why: '这一段已经改过（术语表或第一遍）' }); continue }
    const span = applySpan(words, i, n, to)
    if (span.error) { rejected.push({ s: k, from, to, why: span.error }); continue }
    if (span.text === span.cores.join('')) { rejected.push({ s: k, from, to, why: '改完和原来一样' }); continue }
    // 证据只对「真正改掉的那几个字」提要求，不对整段提。
    // 「花一千的时间」→「花一天的时间」只改了「千→天」，其余七个字原样，
    // 拿「花/的/时间」的置信度来拦这条改法是错的口径（自测07 实测：对的改法就这么被挡掉的）。
    const bounds = [0]
    for (const w of v.ws.slice(loc.a, loc.b + 1)) bounds.push(bounds[bounds.length - 1] + w.core.length)
    const changed = new Set()
    for (let c = 0; c < from.length; c++) if (from[c] !== to[c]) changed.add(c)
    const sure = []
    for (const c of changed) {
      let j = 0
      while (j < bounds.length - 1 && !(c >= bounds[j] && c < bounds[j + 1])) j++
      const w = v.ws[loc.a + j]
      if (w && typeof w.p === 'number' && w.p >= SPAN_P) sure.push(w)
    }
    const uniqSure = [...new Map(sure.map(w => [w.i, w])).values()]
    cand.push({ s: k, from, to, i, n, span, v, a: loc.a, b: loc.b, sure: uniqSure, why: String((p && p.why) || '').slice(0, 40) })
    for (let j = 0; j < n; j++) seen.add(i + j)
  }

  // 同音证据一次查完（本机没有拼音能力就退到第 2、3 档）
  let pyOk = pinyin !== null
  let vals = null
  if (pyOk && cand.length) {
    vals = await phoneticOf(cand.flatMap(x => [x.from, x.to]))
    if (!vals) pyOk = false
  }

  for (let idx = 0; idx < cand.length; idx++) {
    const x = cand[idx]
    let verified = ''
    if (pyOk && vals) {
      const a = vals[idx * 2]
      const b = vals[idx * 2 + 1]
      if (a && b && a.py === b.py) verified = '整段同音：' + a.py + ' 逐字一致'
    }
    if (!verified && terms.length && terms.some(t => t.to === x.to)) verified = '命中术语表：' + x.to
    if (!verified && strongOnly) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '复核这一遍只认同音/术语证据，低置信推断不改' }); continue }
    if (!verified && !x.sure.length) verified = '整段都是低置信词，等字数替换'
    if (!verified) {
      rejected.push({
        s: x.s, from: x.from, to: x.to,
        why: '证据不够：不是同音、不是术语，被改掉的字所在的词识别得很确定（' +
          x.sure.map(w => '「' + words[w.i].w + '」' + w.p.toFixed(2)).join('、') + '），不改',
      })
      continue
    }
    if (accepted.length >= cap) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '整段纠错全片最多 ' + cap + ' 处' }); continue }
    accepted.push({
      i: x.i, n: x.n, at: +words[x.i].start.toFixed(2), from: x.from, to: x.to,
      parts: x.span.parts, kind: 'span', why: x.why, verified,
    })
  }
  return { accepted, rejected }
}

function wordsForPrompt(words) {
  const lines = []
  for (let i = 0; i < words.length; i++) {
    const p = typeof words[i].p === 'number' && words[i].p < 0.8 ? `?(${words[i].p.toFixed(2)})` : ''
    lines.push(`${i}:${words[i].w}${p}`)
  }
  return lines.join(' ')
}

export const PROMPT = (wordList, nudge = '') => `你是中文口播字幕的错字校对。下面是 ASR 原始词序列，格式「词位:词」，低置信词后面跟着 ?(概率)。

${wordList}

先把词序列连起来读一遍（标点就在词里，按原样连着读），把读不通的句子挑出来：搭配不对、
数字后面缺量词、明显不是人话。只在读不通的句子里找错，重点看低置信词附近；读得通的句子不要动。

只找这四类错：
1. 同音字（如「画走」应为「划走」），kind=homophone；
2. 近音字：韵母和声调相同、声母不同（如「一千的时间」应为「一天的时间」，千 qiān → 天 tiān）。
   这类只有在旁边确实有低置信词（?(…) 标记）时才报，kind=near；没有低置信词就别报。
3. 专有名词（如「斗音」应为「抖音」），kind=term；
4. 数字写错（必须是阿拉伯数字写错），kind=number。

例：词序列是「花」「一」「千」「的」「时间」而实际说的是「花一天的时间」，
要报 {"i": 162, "to": "天", "kind": "near"}（千→天，韵母都是 ian、声调都是一声），
不要报 "to": "一天"——那会让这个词变成两个字，字幕卡会撑破。

每条修改必须是：
1. 默认只换一个词的文本，字数与原词相同：{"i": 词位, "to": "改好的词"}；
2. 如果错误横跨相邻的两个或更多词（ASR 把词切错了位置），用 {"i": 起始词位, "n": 词数, "to": "改好的连续文字"}，
   这段文字的总字数必须等于原来这些词的字数总和（每个词会按原字数重新分配）；
3. 不许改写、润色、调顺序；跨词时只允许把字重新分到这几个词里，不许增删字；
4. 没把握就不要改——漏一个错字可以忍，改错一个字是事故。

${nudge}

输出 JSON 数组，元素为 {"i": 词位数字, "n": 词数(可省略), "to": "改好的文字", "kind": "homophone|near|term|number", "why": "不超过 12 字的理由"}。
没有要改的输出 []。不要输出任何其他文字。`

/**
 * 第二遍：把词连成句子再读一遍。
 *
 * 为什么要第二遍：第一遍喂给模型的是「词位:词」的流水，它只能一个词一个词地改，
 * 看到的永远是碎片；真正的错往往是整段（「指纹住在做内容」→「真正在做内容」、
 * 「捡内容生产力才是网道」→「搞内容生产力才是王道」）。质检的语义审读能看到这类错，
 * 但它只有报告权、没有回写通道，所以错字照样出厂。这一遍就是补上那条通道：
 * 用句子视图重读，允许整段等字数替换，校验不过照样打回。
 */
export const SENT_PROMPT = (lines, nudge = '') => `你是中文口播的校对。下面是转写并纠正过一轮的句子，每行「序号|句子」。把每句当人话读一遍，只挑读不通的。

${lines}

对每个读不通的地方报一个整段替换：
{"s": 句子序号, "from": "句子里逐字抄下来的原片段", "to": "改好的片段", "why": "不超过 12 字的理由"}

规则：
1. from 必须在这一句里逐字出现、只出现一次，首尾落在词的边界上（不能切在词的中间）；
2. to 的字数必须和 from 完全一样，不许带标点或空格；
3. 只改错的地方，不许顺句子、换说法、加字删字；
4. 读得通的句子不要动；没把握就不要报——漏一个错字可以忍，改错一个字是事故。

${nudge}

输出 JSON 数组。没有要改的输出 []。不要输出任何其他文字。`

/** 纠错层版本：进了转写缓存的键。改了规则就该重新纠错，不许静默复用旧结果。 */
export const FIXER_VERSION = createHash('sha1')
  .update([PROMPT('x'), SENT_PROMPT('x'), KINDS.join(','), String(SPAN_CAP), String(SPAN_P), String(NEAR_CAP), String(NEAR_P)].join('|'))
  .digest('hex').slice(0, 12)

/**
 * 只问模型要提案，接不接受由 validate 说了算。
 * 走 llm.mjs 的统一客户端，失败口径和制片人那边一致：no-key / http-4xx / timeout / unreachable。
 */
async function callModel(wordList, { nudge = '' } = {}) {
  const t0 = Date.now()
  try {
    const r = await chat({ prompt: PROMPT(wordList, nudge), maxTokens: 1200, model: LLM.models.fast, temperature: 0 })
    if (!r.ok) return { skipped: r.skipped, detail: r.detail || null }
    const m = r.content.match(/\[[\s\S]*\]/)
    const proposals = m ? JSON.parse(m[0]) : []
    return { proposals, ms: Date.now() - t0, model: r.model, tokens: r.tokens }
  } catch (err) {
    return { skipped: 'unreachable', detail: String(err.message).slice(0, 160) }
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
    const n = p && p.n !== undefined ? Number(p.n) : 1
    if (!Number.isInteger(i) || i < 0 || i >= words.length) { rejected.push({ ...p, why: '词位越界' }); continue }
    const w = words[i]
    const to = String(p.to ?? '').trim()
    const kind = String(p.kind || '').trim()
    if (!to) { rejected.push({ i, from: w.w, why: '改成空词' }); continue }
    if (/\s/.test(to)) { rejected.push({ i, from: w.w, to, why: '改成的内容里有空格' }); continue }
    if (!KINDS.includes(kind)) { rejected.push({ i, from: w.w, to, why: '不在允许的四类里：' + (kind || '空') }); continue }
    if (kind === 'punct') { rejected.push({ i, from: w.w, to, why: '标点类被字幕层统一剥掉，无需改' }); continue }
    if (seen.has(i)) { rejected.push({ i, from: w.w, to, why: '同一个词位改了两次' }); continue }
    // 区间里已经有词被术语表改过，就不再动，避免两套改法打架
    let touched = false
    for (let k = 0; k < n; k++) if (words[i + k] && words[i + k].fixed) touched = true
    if (touched) { rejected.push({ i, from: w.w, to, why: '这一段里有词已被术语表或整句纠错改过' }); continue }
    const span = applySpan(words, i, n, to)
    if (span.error) { rejected.push({ i, from: w.w, to, why: span.error }); continue }
    if (span.text === span.cores.join('')) { rejected.push({ i, from: w.w, to, why: '改完和原来一样' }); continue }
    if (kind === 'term' && n > 1) { rejected.push({ i, from: w.w, to, why: '专有名词改动不许跨词' }); continue }
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
    pairs.push({ p, i, n, w, to, kind, span })
  }

  // 同音要拼音全等；近音要比声母/韵母。两类都要一次性查完。
  const needPhon = pairs.filter(x => x.kind === 'homophone' || x.kind === 'near')
  // pinyin 传 null 表示「本机已知不可用」；传 undefined / 其他表示待探测
  let pyOk = pinyin !== null
  let vals = null
  if (pyOk && needPhon.length) {
    vals = await phoneticOf(needPhon.flatMap(x => [x.span.cores.join(''), x.span.text]))
    if (!vals) pyOk = false
  }

  let nearUsed = 0
  for (const x of pairs) {
    if (accepted.length >= cap) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '超过本轮上限 ' + cap + ' 处' }); continue }
    // 同一个词位只认第一条：seen 在上一轮建候选时还没填，必须在这儿再拦一次，
    // 否则同一词位两条提案都会「采纳」，报告说改了 2 处、实际只落地 1 处。
    let clash = false
    for (let k = 0; k < x.n; k++) if (seen.has(x.i + k)) clash = true
    if (clash) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: x.n > 1 ? '这一段和别的提案重叠' : '同一个词位改了两次' }); continue }
    const base = {
      i: x.i, n: x.n, at: +x.w.start.toFixed(2), from: x.w.w, to: x.to,
      parts: x.span.parts, kind: x.kind, why: String(x.p.why || '').slice(0, 40),
    }
    if (x.kind === 'homophone') {
      if (!pyOk || !vals) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '本机没有拼音校验，保守模式不采纳同音改动' }); continue }
      const k = needPhon.indexOf(x) * 2
      const a = vals[k]
      const b = vals[k + 1]
      if (!a || !b) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '拼音查不到，无法验证同音' }); continue }
      if (a.py !== b.py) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '不同音：' + a.py + ' vs ' + b.py }); continue }
      accepted.push({ ...base, verified: '拼音 ' + a.py + ' 一致' })
    } else if (x.kind === 'near') {
      if (!pyOk || !vals) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '本机没有拼音校验，保守模式不采纳近音改动' }); continue }
      if (nearUsed >= NEAR_CAP) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '近音改动全片最多 ' + NEAR_CAP + ' 处' }); continue }
      const k = needPhon.indexOf(x) * 2
      const a = vals[k]
      const b = vals[k + 1]
      if (!a || !b) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '拼音查不到，无法验证近音' }); continue }
      if (a.py === b.py) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '本来就是同音，应该报同音类' }); continue }
      const finA = a.fin.join('|')
      const finB = b.fin.join('|')
      if (finA !== finB) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '韵母或声调不同：' + finA + ' vs ' + finB }); continue }
      if (a.ini.join('|') === b.ini.join('|')) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '声母也一致但不同音，无法自证' }); continue }
      const wit = nearWitness(words, x.i, x.n)
      if (!wit) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '近音要有独立证据：前后 ' + NEAR_WINDOW + ' 个词里没有低置信词' }); continue }
      nearUsed++
      accepted.push({
        ...base,
        verified: '近音：韵母 ' + finA + ' 一致、声母 ' + a.ini.join('') + '→' + b.ini.join('') + '；同段「' + wit.w + '」置信 ' + wit.p,
      })
    } else {
      accepted.push({ ...base, verified: x.kind === 'term' ? '命中术语表' : '数字位数未变' })
    }
    for (let k = 0; k < x.n; k++) seen.add(x.i + k)
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
export async function correct({ words, terms, log = () => {}, askModel = true, segments = null }) {
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
    sentence: null,
    review: null,
    applied: [...g.hits],
    rejected: [],
    pending: [],
    assertion: null,
  }

  // 先按整句改，再按词位补。
  //
  // 顺序反过来会出事：逐词同音规则会把「直到」改成「只到」——每个字都对、整句更糟，
  // 它只看一个词，没有能力判断整句。整句视图先落地，被改过的词逐词层就不许再碰（validate 里 fixed 检查）。
  if (askModel && segments && segments.length) {
    const touched = new Set()
    for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) touched.add(a.i + k)
    const view = sentenceView(current, segments)
    if (view.length) {
      const r2 = await callSentenceReview(view)
      if (r2.skipped) {
        report.sentence = { skipped: r2.skipped, detail: r2.detail || null }
        log('整句纠错：模型没接上（' + r2.skipped + '），只做了第一遍')
      } else {
        const v2 = await validateSpans(r2.proposals || [], current, view, { skip: touched, terms })
        report.sentence = { ok: true, model: r2.model, ms: r2.ms, tokens: r2.tokens, proposals: (r2.proposals || []).length, sentences: view.length }
        report.applied.push(...v2.accepted)
        report.rejected.push(...v2.rejected)
        const by2 = new Map()
        for (const a of v2.accepted) {
          const parts = a.parts || [a.to]
          for (let k = 0; k < (a.n || 1); k++) by2.set(a.i + k, parts[k])
        }
        current = current.map((w, i) => by2.has(i) ? { ...w, w: by2.get(i), w0: w.w0 || w.w, fixed: true } : w)
        log('整句纠错：' + view.length + ' 句，' + (r2.proposals || []).length + ' 提案 / ' + v2.accepted.length + ' 采纳 / ' + v2.rejected.length + ' 打回')
      }
    }
  }

  if (askModel) {
    const wordList = wordsForPrompt(current)
    let r = await callModel(wordList)
    // 模型有时一句「没有要改的」就收工。只要有低置信词，就再读一遍——
    // 这不是放宽标准：第二遍的提案照样要过校验器，过不了还是打回。
    const lowCount = current.filter(w => typeof w.p === 'number' && w.p < LOW_P).length
    if (!r.skipped && !(r.proposals || []).length && lowCount) {
      log('错字纠错：第一次没报错，但还有 ' + lowCount + ' 个词听不清，再读一遍')
      const r2 = await callModel(wordList, { nudge: '注意：标了 ?(…) 的词我确实听不清，请再读一遍这些词所在的句子。' })
      if (!r2.skipped && (r2.proposals || []).length) r = { ...r2, ms: (r.ms || 0) + (r2.ms || 0), retried: true }
    }
    if (r.skipped) {
      report.model = { skipped: r.skipped, detail: r.detail || null }
      log('错字纠错：模型没接上（' + r.skipped + '），只做了术语表')
    } else {
      // 拼音可用性由 validate 内部按需探测，这里不预判
      const v = await validate(r.proposals || [], current, { terms })
      report.model = { ok: true, model: r.model, ms: r.ms, tokens: r.tokens, proposals: (r.proposals || []).length, pinyinMode: v.pinyinMode }
      report.applied.push(...v.accepted)
      report.rejected.push(...v.rejected)
      // 跨词提案落地：一个提案可能占 2 个以上词位，按 parts 逐位写回
      const byIndex = new Map()
      for (const a of v.accepted) {
        const parts = a.parts || [a.to]
        for (let k = 0; k < (a.n || 1); k++) byIndex.set(a.i + k, parts[k])
      }
      current = current.map((w, i) => byIndex.has(i) ? { ...w, w: byIndex.get(i), w0: w.w0 || w.w, fixed: true } : w)
    }
  }

  // 第三遍：改完之后再按句子读一遍。
  // 逐词层只看得见一个词，它可以把「直到」改成「只到」、「时代」改成「是代」——
  // 每个字都同音、整句却更糟。人改完会回读一遍，这里也一样：允许把上一步改坏的整段改回来，
  // 但这一遍只认同音 / 术语这种硬证据，不再用「低置信」去推断。
  if (askModel && segments && segments.length) {
    const termIdx = new Set()
    for (const a of g.hits) for (let k = 0; k < (a.n || 1); k++) termIdx.add(a.i + k)
    const view3 = sentenceView(current, segments)
    if (view3.length) {
      const r3 = await callSentenceReview(view3)
      if (r3.skipped) {
        report.review = { skipped: r3.skipped, detail: r3.detail || null }
        log('回读：模型没接上（' + r3.skipped + '）')
      } else {
        const v3 = await validateSpans(r3.proposals || [], current, view3, { skip: termIdx, terms, strongOnly: true })
        report.review = { ok: true, model: r3.model, ms: r3.ms, tokens: r3.tokens, proposals: (r3.proposals || []).length, sentences: view3.length }
        report.applied.push(...v3.accepted)
        report.rejected.push(...v3.rejected)
        const by3 = new Map()
        for (const a of v3.accepted) {
          const parts = a.parts || [a.to]
          for (let k = 0; k < (a.n || 1); k++) by3.set(a.i + k, parts[k])
        }
        current = current.map((w, i) => by3.has(i) ? { ...w, w: by3.get(i), w0: w.w0 || w.w, fixed: true } : w)
        log('回读：' + view3.length + ' 句，' + (r3.proposals || []).length + ' 提案 / ' + v3.accepted.length + ' 回改 / ' + v3.rejected.length + ' 打回')
      }
    }
  }

  const appliedIdx = new Set()
  for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) appliedIdx.add(a.i + k)
  report.pending = current
    .map((w, i) => ({ i, at: +w.start.toFixed(2), w: w.w, p: w.p }))
    .filter(x => typeof x.p === 'number' && x.p < LOW_P && !appliedIdx.has(x.i))

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
    spans: report.applied.filter(a => (a.n || 1) > 1).length,
    near: report.applied.filter(a => a.kind === 'near').length,
    span: report.applied.filter(a => a.kind === 'span').length,
    ms: Date.now() - t0,
  }
  const aiAccepted = report.applied.length - g.hits.length
  log(`错字治理：术语表 ${g.hits.length} 处 · 整句 ${report.sentence && report.sentence.ok ? report.sentence.proposals + ' 提案' : '未接'} · 逐词 ${report.model && report.model.ok ? report.model.proposals + ' 提案' : '未接'} · 采纳 ${aiAccepted}（整段 ${report.stats.span}） · 打回 ${report.rejected.length} · 待确认 ${report.pending.length}`)
  return { words: current, report }
}