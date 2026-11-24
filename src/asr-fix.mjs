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
// 标点字符集（不带 g，避免 test() 的 lastIndex 状态）
const PUNCT_CH = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/u
const KINDS = ['homophone', 'term', 'number', 'near', 'punct']

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
    if (touched) { rejected.push({ i, from: w.w, to, why: '这一段里有词已被术语表改过' }); continue }
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
    ms: Date.now() - t0,
  }
  const aiAccepted = report.applied.length - g.hits.length
  log(`错字治理：术语表 ${g.hits.length} 处 · 模型 ${report.model && report.model.ok ? report.model.proposals + ' 提案 / ' + aiAccepted + ' 采纳' : '未接'} · 打回 ${report.rejected.length} · 待确认 ${report.pending.length}`)
  return { words: current, report }
}
