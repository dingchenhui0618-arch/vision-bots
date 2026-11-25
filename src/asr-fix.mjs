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
 *
 * 还有一类「文本两头都不成立」的错：同声母、同声调、韵母只差一个元音（捡 jiǎn / 卷 juǎn）。
 * 拼音不全等→不算同音；韵母不同→不算近音；可快语流里这两个音节本来就难分。
 * 自测18 交付的片子里「别再卷技术了」被写成「别再捡技术了」，模型报了、规则按「不同音」打回，
 * 错字就这么出了厂。文本判不了的事只能交给音频：这类提案一律转听音复核，
 * 要强耳朵两个窗口都听到「卷」才算数（实测 medium 两次都听到「卷」）。全片最多 PHON_CAP 处进重听。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { chat, chatCached, LLM, taskCall, pairFor } from './llm.mjs'
import { R as RELISTEN, alignCrop, charDiff, enabled as relistenEnabled, hanNumbers, modelAvailable as relistenModel, planRepair, relistenSentence, silentGaps, slotAnomaly } from './relisten.mjs'

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
// 「同声母同声调、韵母只差一个元音」（捡 jiǎn / 卷 juǎn）：文本层判不了，交听音复核，别占近音预算。
const PHON_CAP = 3
// 整段纠错（第二遍，按句子读）：ASR 的真错常常是一整段
// （「指纹住在做内容」实际说的是「真正在做内容」），按词一个个看永远看不出来。
// 约束不放松：字数不变、词数不变、时间码不动；全片最多 SPAN_CAP 处，逐条写进交付报告。
const SPAN_CAP = 3
const SPAN_P = 0.85
// 第二意见（双模型一致）：语义型错没有音韵证据（指纹住在 → 真正在做 差得很远），
// whisper 对它还很自信（实测 0.97），「一个模型说这句话读不通」不够当证据。
// 两个不同的模型各自独立给出逐字相同的改法，才算第二条独立事实。全片最多 DUAL_CAP 处。
const DUAL_CAP = 2
// 删字（ASR 多吐字）全片最多 2 处，同样要有第二个模型逐字同意
const DEL_CAP = 2
const isAsciiWord = s => /^[A-Za-z0-9]+$/.test(String(s ?? ''))

/**
 * 这条改动会不会把一个**分词器认可的整词**切碎。实测踩到：ASR 原判是对的「AI时代」
 * （「时」置信度只有 0.23），逐词层把它改成同音的「是」，于是交付字幕变成「AI是代」——
 * 每个字的拼音都对，整句却不成立了。同音规则只看一个字，看不见「时代」是个词。
 *
 * 判据用 ICU 分词（和断行用的是同一套）：改前窗口里是一个词、改后变成几个单字，
 * 就说明改坏了。反方向（把两个单字改成整词，如「画走」→「划走」）永远放行——
 * 这一层只拦「改碎」，不拦「改对」。
 */
export function breaksWord(before, after) {
  const b = strip(before)
  const a = strip(after)
  if (!b || !a) return false
  try {
    const seg = s => [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(s)].length
    return seg(a) > seg(b) && seg(b) < [...b].length
  } catch {
    return false
  }
}
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
      // from 允许是空数组：那种条目只当「证据 + 转写热词」，不做确定性替换。
      // 用来登记本领域专有名词（GPT / Claude）：让它们成为校验器认得的词，
      // 但不许无条件改写——用户真说 GDP 的时候，「GDP→GPT」这种替换会当场改坏片子。
      for (const t of j.terms || []) if (t && t.to && Array.isArray(t.from)) out.push(t)
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
 * 英文碎片合并：ASR 常把一个专有名词拆成几段（实测「Codex」→「C」+「ode」+「x」，
 * 其中「ode」的时长为 0；「GPT」→「G」+「PT」）。碎片在字幕里拼起来看着没问题，
 * 但词级时间码里多出零时长词，逐字跟读和大字挂点都会错位。
 *
 * 规则：连续 2–4 个纯英文/数字碎片，拼起来（忽略大小写）正好等于术语表里的词，
 * 而且这一段里确实有碎片 ASR 自己没把握（p<0.65）或是零时长 → 合成一个词：
 * 文本用术语表的写法，时间取这一段的起止。字符一个不增不减，变的只是词边界。
 */
export function mergeAsciiRuns(words, terms) {
  const tos = (terms || []).map(t => String(t.to || '')).filter(isAsciiWord)
  const out = []
  const hits = []
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (!isAsciiWord(strip(w.w))) { out.push(w); i++; continue }
    let best = null
    let acc = ''
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const seg = words[i + n - 1]
      const c = strip(seg.w)
      if (!isAsciiWord(c)) break
      acc += c
      const term = tos.find(t => t.toLowerCase() === acc.toLowerCase())
      if (!term || n < 2) continue
      const group = words.slice(i, i + n)
      const weak = group.some(x => (typeof x.p === 'number' && x.p < 0.65) || !(x.end > x.start))
      if (weak) best = { n, term, group }
    }
    if (!best) { out.push(w); i++; continue }
    const { n, term, group } = best
    const first = splitAffixes(group[0].w)
    const lastAf = splitAffixes(group[group.length - 1].w)
    const merged = {
      ...group[0],
      w: first.lead + term + lastAf.trail,
      start: group[0].start,
      end: Math.max(group[group.length - 1].end, group[0].end),
      p: Math.min(...group.map(x => (typeof x.p === 'number' ? x.p : 1))),
      w0: group[0].w0 || group.map(x => x.w).join(''),
      fixed: true,
    }
    out.push(merged)
    hits.push({
      i: out.length - 1, at: +merged.start.toFixed(2), start: merged.start, end: merged.end,
      from: group.map(x => x.w).join(''), to: term,
      kind: 'term', why: '术语表命中（英文碎片合并）', verified: '术语表命中（' + n + ' 段合成一个词）', merged: n,
    })
    i += n
  }
  return { words: out, hits, delta: out.length - words.length }
}

/**
 * 术语表确定性替换：只换词内文本，中文字数变了就不换（避免字幕回流和字位错位）。
 * 纯拉丁词例外（Cloud→Claude）：一个词就是一个词槽，字母数不占音节，见下面的 latin 分支。
 */
export function applyTerms(words, terms) {
  const seeded = mergeAsciiRuns(words, terms)
  const out = seeded.words.map(w => ({ ...w }))
  const hits = [...seeded.hits]
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
        // 中文字幕的「等字数」是因为一字一个音节、字数决定字幕卡会不会撑破；
        // 拉丁词不是这样：一个词就是一个词槽，字母多一个不占时间（实测 Cloud→Claude
        // 被这条规则拦了整整三轮，最后只能靠模型提案，而模型提不提是随机的）。
        // 所以纯拉丁词允许 ±2 个字母，但只在 from/to 都是纯拉丁时放开。
        const latin = isAsciiWord(strip(from)) && isAsciiWord(strip(r.text)) && isAsciiWord(strip(w.w)) &&
          Math.abs(strip(r.text).length - strip(w.w).length) <= 2
        if (strip(r.text).length !== strip(w.w).length && !latin) {
          skipped.push({ i, at: +w.start.toFixed(2), from, to: t.to, why: '字数不一致，会撑破字幕卡' })
          continue
        }
        out[i] = { ...w, w: r.text, w0: w.w0 || w.w, fixed: true }
        hits.push({
          i, at: +w.start.toFixed(2), from, to: t.to, kind: t.kind || 'term', latin: latin || undefined,
          why: latin ? '术语表命中（拉丁词按词槽走，字母数不占音节）' : '术语表命中',
          verified: t.next ? `术语表命中（后接「${[].concat(t.next).join('/')}」）` : (latin ? '术语表命中（拉丁词）' : '术语表命中'),
        })
      }
    }
  }
  return { words: out, hits, skipped, merged: seeded.hits, delta: seeded.delta }
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

/**
 * 「同声母、同声调、韵母只差一个元音」——文本层的证据到这里就到头了。
 *
 * 捡 jiǎn 与 卷 juǎn：拼音不全等（不是同音），韵母 ian/uan 不同（不是近音，
 * 近音要求韵母一致、声母不同）。可这两个音节在快语流里本来就难分，
 * 区别只在韵头 i/u —— 唯一能判的是音频，不是拼音表。
 *
 * 所以这里只回答「值不值得去听」：值得就返回韵母差异，由听音复核用强耳朵定生死。
 * 判据刻意窄：声母一致、声调一致、韵母等长且只差一个字母。差两个字母的（盆 pén / 瓶 píng）
 * 声学上差得远，不值得花一次重听预算。
 */
export function phonOnly(a, b) {
  if (!a || !b) return null
  if (a.py === b.py) return null
  const ia = a.ini.join('')
  const ib = b.ini.join('')
  if (!ia || ia !== ib) return null
  const fa = String(a.fin[0] ?? '')
  const fb = String(b.fin[0] ?? '')
  if (fa.length < 2 || fa.length !== fb.length) return null
  const toneA = fa[fa.length - 1]
  const toneB = fb[fb.length - 1]
  if (toneA !== toneB) return null
  const ra = fa.slice(0, -1)
  const rb = fb.slice(0, -1)
  let d = 0
  for (let k = 0; k < ra.length; k++) if (ra[k] !== rb[k]) d++
  return d === 1 ? { ini: ia, rimeA: ra, rimeB: rb, tone: toneA } : null
}

/**
 * 两段等长文字是不是「只差一个字」。返回 { at, from, to }，否则 null。
 * 听音复核拿它当闸门：只差一个元音的那类改法（捡/卷）只允许音频在这一处换一个字，
 * 多一个字都不算「这一个音节听清了」——那就不是证据，是另一次转写。
 */
export function oneCharSwap(a, b) {
  const A = [...strip(a)]
  const B = [...strip(b)]
  if (!A.length || A.length !== B.length) return null
  let at = -1
  for (let k = 0; k < A.length; k++) {
    if (A[k] === B[k]) continue
    if (at >= 0) return null
    at = k
  }
  if (at < 0) return null
  return { at, from: A[at], to: B[at] }
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
 *
 * 字数必须不变——字幕卡宽度、断行、时间码都靠这个不变式。两个例外，都是实测逼出来的：
 *   · latinOk：纯字母数字的词（Cloud → Claude），多一个字母不占时间（词层要求术语证据）。
 *   · allowDelete：**删字**。ASR 会多吐一个字（「指纹住在做内容」实际是「真正在做内容」，
 *     多了个「在」），模型两次都正确地提议「指纹住在」→「真正在」，被等字数规则挡回来了。
 *     删字不动时间码、不动词数，只让这一段最后一个词变成空词（它那 130ms 本来就不该有字），
 *     字幕卡只会变窄，不会撑破。所以「减字」可以放，前提是第二个模型逐字同意这一处删法。
 */
export function applySpan(words, i, n, to, { latinOk = false, allowDelete = false } = {}) {
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
  if (chars.length !== total) {
    // 等字数这条不变量的依据是「中文一个字 ≈ 0.1 秒、字幕卡按字数排宽」。
    // 对纯字母数字的词它不成立：Cloud → Claude 多的那一个字母不占时间，卡也放得下。
    // 所以只对「一个词、两边都是字母数字、差不超过 2」放宽，而且要不要采纳由调用方定
    // （词层要求 kind: term 命中术语表，句层要求术语/同音证据）。
    const latin = latinOk && n === 1 && isAsciiWord(cores[0]) && isAsciiWord(want) && Math.abs(want.length - cores[0].length) <= 2
    if (!latin && allowDelete && chars.length > 0 && chars.length < total) {
      // 删字：按原词字长从左往右装，装完的位置留空词，标点跟着前一个词走
      const parts = []
      let at = 0
      for (let k = 0; k < n; k++) {
        const len = [...cores[k]].length
        const take = chars.slice(at, at + len).join('')
        at += len
        const lead = parts.length ? affixes[k].lead : affixes[k].lead
        if (!take) {
          // 这个词被删空了：把它的标点并到前一个词尾部（第一个词就并到自己的 lead）
          if (parts.length) parts[parts.length - 1] += affixes[k].lead + affixes[k].trail
          else parts.push(affixes[k].lead + affixes[k].trail)
          continue
        }
        parts.push(lead + take + affixes[k].trail)
      }
      while (parts.length < n) parts.push('')
      return { parts, cores, total, text: chars.join(''), deleted: total - chars.length }
    }
    if (!latin) return { error: `字数变了：原 ${total} 字，改成 ${chars.length} 字，会撑破字幕卡` }
    return { parts: [affixes[0].lead + want + affixes[0].trail], cores, total, text: want, latin: true }
  }
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

/**
 * 这一轮错字治理用哪只模型出提案、用哪只模型做第二意见。
 *
 * 提案跟着剪辑 bot 的配置走（换模型只改 config/bots/cutter.json——接 Opus 也只改这里，
 * 以前这里硬写 fast，所以客户把剪辑换成什么模型，改字这一步都不动，等于白换）。
 * 第二意见必须是**另一只**模型：同一只模型问两遍不构成第二条独立事实。
 * 两只撞成同一只时 distinct:false，调用方跳过第二意见并照实说明。
 *
 * 温度不跟配置走：证据层的三遍（整句 / 逐词 / 字数回问）恒为 0。这不是口味，
 * 是「同一个输入必须给同一批提案」的前提——温度一抖，同一段素材两次跑改的字就不一样。
 */
export function proposerCall() {
  const p = taskCall('cutter', { maxTokens: 1200 })
  return { ...p, ...pairFor(p.model, LLM.models) }
}

async function callSentenceReview(view, { model = null } = {}) {
  const lines = view.map((v, k) => `${k + 1}|${v.text}`).join('\n')
  const c = proposerCall()
  const t0 = Date.now()
  try {
    const r = await chatCached({ prompt: SENT_PROMPT(lines), maxTokens: 1200, model: model || c.primary, temperature: 0, timeoutMs: c.timeoutMs })
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
export async function validateSpans(proposals, words, view, { skip = new Set(), cap = SPAN_CAP, terms = [], pinyin, strongOnly = false, duals = null, dualModel = '第二模型', dualCap = DUAL_CAP } = {}) {
  const accepted = []
  const rejected = []
  const seen = new Set(skip)
  const cand = []
  let dualUsed = 0
  let delUsed = 0
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
    const span = applySpan(words, i, n, to, { latinOk: true, allowDelete: true })
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
    // 两条提案粒度常常不同：一个说「一千的时间→一天的时间」，另一个说「一千→一天」，
    // 逐字比 from/to 会判成不一致，可它们改的是同一个字。所以统一归到「词位 → 改后文本」再比。
    const map = []
    for (let q = 0; q < n; q++) {
      const before = splitAffixes(words[i + q].w).core
      const after = splitAffixes(span.parts[q]).core
      if (after !== before) map.push([i + q, after])
    }
    cand.push({ s: k, from, to, i, n, span, v, a: loc.a, b: loc.b, sure: uniqSure, map, why: String((p && p.why) || '').slice(0, 40) })
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
    if (!verified && terms.length && terms.some(t => t.to === x.to || (isAsciiWord(t.to) && isAsciiWord(x.to) && String(t.to).toLowerCase() === x.to.toLowerCase()))) verified = '命中术语表：' + x.to
    // 整段同音同样要过「别把词切碎」：一个字对不代表这个词还成立。
    if (verified && /同音/.test(verified)) {
      const L = x.a > 0 ? x.v.ws[x.a - 1].core : ''
      const R = x.b < x.v.ws.length - 1 ? x.v.ws[x.b + 1].core : ''
      if (breaksWord(L + x.from + R, L + x.to + R)) {
        rejected.push({ s: x.s, from: x.from, to: x.to, why: '改完会把「' + strip(L + x.from + R) + '」这个词切碎（分词后变成几个单字），同音不等于这句成立' })
        continue
      }
    }
    // 双模型一致：这是「语义型」唯一的证据档。它比低置信推断强、比同音弱，
    // 所以既要两条独立事实，也要单独配额（全片最多 dualCap 处）。
    const dk = x.s + '|' + x.from + '|' + x.to
    const dual = Boolean(!verified && duals && duals.has(dk))
    // 删字（少字）没有同音/术语这种硬证据可用，唯一的档就是「第二个模型逐字同意同一处删法」。
    // 这条要排在「证据不够」之前，否则它会被当成普通的推断型改法打回，理由还写错。
    if (x.span.deleted && !dual) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '删字必须有第二个模型逐字同意（这一处会少 ' + x.span.deleted + ' 个字）' }); continue }
    if (dual) verified = '双模型一致（' + dualModel + '）：语义型，' + (x.span.deleted ? '删字' : '等字数替换')
    if (!verified && strongOnly) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '复核这一遍只认同音/术语证据，低置信推断不改' }); continue }
    if (!verified) {
      // need:true 表示「几何都对、只差证据」——回问和第二意见只复核这一类，
      // 字数变了、切在词中间、标点里混字的，谁来提都不认。
      //
      // 「这一段都是低置信词」曾经能单独定案。实测它两面都行：同一份素材上既靠它改对了
      // 一天的时间，也把「指纹住在」改成了「之所以在」（下一遍模型自己又改回来）。
      // 识别不确定是「可疑」，不是「证据」——所以这一档不再自动落地，只当候选，
      // 要第二个模型逐字同意才动。
      const weak = !x.sure.length
      rejected.push({
        s: x.s, from: x.from, to: x.to, need: true, ...(weak ? { weak: true } : {}), map: x.map,
        why: weak
          ? '这一段识别都不确定，但只有一个模型这么改——要第二个模型逐字同意才动'
          : '证据不够：不是同音、不是术语，被改掉的字所在的词识别得很确定（' +
            x.sure.map(w => '「' + words[w.i].w + '」' + w.p.toFixed(2)).join('、') + '），不改',
      })
      continue
    }
    // 拉丁词改了字数就必须有术语/同音证据，不能靠「低置信推断」把 Cloud 改长成 Claude
    if (x.span.latin && !/术语表|同音/.test(verified)) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '拉丁词改字数必须有术语或同音证据，推断不算' }); continue }
    if (x.span.deleted) {
      if (delUsed >= DEL_CAP) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '删字全片最多 ' + DEL_CAP + ' 处' }); continue }
      delUsed++
      verified += '（删 ' + x.span.deleted + ' 字）'
    }
    if (dual && dualUsed >= dualCap) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '双模型一致全片最多 ' + dualCap + ' 处' }); continue }
    if (dual) dualUsed++
    if (accepted.length >= cap) { rejected.push({ s: x.s, from: x.from, to: x.to, why: '整段纠错全片最多 ' + cap + ' 处' }); continue }
    accepted.push({
      i: x.i, n: x.n, at: +words[x.i].start.toFixed(2), from: x.from, to: x.to,
      parts: x.span.parts, kind: 'span', why: x.why, verified, ...(x.span.deleted ? { deleted: x.span.deleted } : {}),
    })
  }
  return { accepted, rejected, dualUsed }
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
   还有一类更细的：声母和声调都相同、韵母只差一个元音（如「别再捡技术了」应为「别再卷技术了」，
   捡 jiǎn → 卷 juǎn）。读不通就报 kind=near——这条不靠拼音自证，最终由重听音频决定，报错也不会出厂。
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
/**
 * 字数不对时的回问。模型最爱犯的错是「住在」→「在」这种合并同字：
 * 指纹住在 / 真正在做 都是 4 字，它写成「真正在」只给 3 字，然后整条被字数不变式踢掉。
 * 把具体数字摆给它看，比笼统说「字数要一样」有效；同时留退路，不许它为了凑字数乱填。
 */
export const LEN_NUDGE = bad => '注意：下面这些改法字数和原片段不一致，已经被退回（字幕卡按字数排宽，字数必须完全一样）：\n' +
  bad.slice(0, 6).map(b => '- 原片段「' + b.from + '」是 ' + [...b.from].length + ' 字，你写成「' + b.to + '」是 ' + [...b.to].length + ' 字').join('\n') +
  '\n请重新给等字数的改法；补不齐就换一个真正等字数的写法，实在没有就不要报这一处。'

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

/**
 * 纠错层版本：进了转写缓存的键。改了规则就该重新纠错，不许静默复用旧结果。
 *
 * 这里以前只 hash 提示词和几个常量——实测踩过：改了校验逻辑（没动提示词），
 * 缓存仍然命中，返工拿到的是旧规则的结果，而且一声不响。所以直接 hash 整个模块源码：
 * 改注释也会失效，代价是重跑一遍纠错（十几秒），换来「改了就一定生效」。
 */
export const FIXER_VERSION = createHash('sha1')
  .update(readFileSync(fileURLToPath(import.meta.url), 'utf8'))
  // 听音复核是纠错的一部分（第五遍），它自己的规则变了同样要重新纠错
  .update(readFileSync(fileURLToPath(new URL('./relisten.mjs', import.meta.url)), 'utf8'))
  .digest('hex').slice(0, 12)

/**
 * 只问模型要提案，接不接受由 validate 说了算。
 * 走 llm.mjs 的统一客户端，失败口径和制片人那边一致：no-key / http-4xx / timeout / unreachable。
 */
async function callModel(wordList, { nudge = '' } = {}) {
  const t0 = Date.now()
  try {
    const c = proposerCall()
    const r = await chatCached({ prompt: PROMPT(wordList, nudge), maxTokens: 1200, model: c.primary, temperature: 0, timeoutMs: c.timeoutMs })
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
  // 文本层判不了、只能由音频定生死的提案（同声母同声调、韵母只差一个元音），
  // 交听音复核；没被音频确认的，一律不改（理由照样写进报告）。
  const phon = []
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
    const span = applySpan(words, i, n, to, { latinOk: kind === 'term' })
    if (span.error) { rejected.push({ i, from: w.w, to, why: span.error }); continue }
    // 同音/近音只看一个词，看不见「这个词和旁边是一个词」。改碎的判定放在印证之后（见 accepted 前），
    // 免得把「拼音根本不同」这类更硬的原因盖掉。
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
      const want = strip(to)
      // 拉丁词的大小写是 ASR 自己的写法（cloud / Cloud / CLOUD），认词不认大小写
      const known = terms.some(t => t.to === want || (isAsciiWord(t.to) && isAsciiWord(want) && String(t.to).toLowerCase() === want.toLowerCase()))
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
  // 改碎判据：窗口 = 前一个词 + 这一段 + 后一个词，改前是一个整词、改后变成几个单字就是改坏了。
  const wordBreak = (x) => {
    const L = words[x.i - 1] ? splitAffixes(words[x.i - 1].w).core : ''
    const R = words[x.i + x.n] ? splitAffixes(words[x.i + x.n].w).core : ''
    const b = L + x.span.cores.join('') + R
    const a = L + x.span.text + R
    if (!breaksWord(b, a)) return null
    return '改完会把「' + strip(b) + '」这个词切碎（' + strip(b) + ' → ' + strip(a) + '），同音不等于这句成立'
  }
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
      if (a.py !== b.py) {
        const ph = phonOnly(a, b)
        if (!ph) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '不同音：' + a.py + ' vs ' + b.py }); continue }
        // 会把这个词改碎的照样不送听：音频再准也救不了一个本来就不成立的词形。
        const wbPh = wordBreak(x)
        if (wbPh) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: wbPh }); continue }
        rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '不同音（' + a.py + ' vs ' + b.py + '），但同声母同声调、韵母只差一个元音，已交听音复核：音频说是「' + strip(x.to) + '」才改' })
        if (phon.length < PHON_CAP) phon.push({ i: x.i, n: x.n, at: +x.w.start.toFixed(2), from: strip(x.span.cores.join('')), to: strip(x.to), why: String(x.p.why || '').slice(0, 40), pinyin: a.py + ' vs ' + b.py, rime: ph.ini + ph.rimeA + ' vs ' + ph.ini + ph.rimeB })
        continue
      }
      const wb = wordBreak(x)
      if (wb) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: wb }); continue }
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
      // 同声母同声调、韵母只差一个元音：近音证据与低置信见证都不适用，唯一的路是听音频。
      const phn = phonOnly(a, b)
      if (phn) {
        const wbPn = wordBreak(x)
        if (wbPn) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: wbPn }); continue }
        rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '不同音（' + a.py + ' vs ' + b.py + '），但同声母同声调、韵母只差一个元音，已交听音复核：音频说是「' + strip(x.to) + '」才改' })
        if (phon.length < PHON_CAP) phon.push({ i: x.i, n: x.n, at: +x.w.start.toFixed(2), from: strip(x.span.cores.join('')), to: strip(x.to), why: String(x.p.why || '').slice(0, 40), pinyin: a.py + ' vs ' + b.py, rime: phn.ini + phn.rimeA + ' vs ' + phn.ini + phn.rimeB })
        continue
      }
      if (finA !== finB) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '韵母或声调不同：' + finA + ' vs ' + finB }); continue }
      if (a.ini.join('|') === b.ini.join('|')) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '声母也一致但不同音，无法自证' }); continue }
      const wit = nearWitness(words, x.i, x.n)
      if (!wit) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: '近音要有独立证据：前后 ' + NEAR_WINDOW + ' 个词里没有低置信词' }); continue }
      const wbn = wordBreak(x)
      if (wbn) { rejected.push({ i: x.i, from: x.w.w, to: x.to, why: wbn }); continue }
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
  return { accepted, rejected, pinyinMode: pyOk ? 'on' : 'off', phon }
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

// ── 第五遍：听音复核 ──
// 四遍纠错和第二意见全在文本上推理，ASR 吞字（少吐字）这一类的错它们结构上看不见：
// 少了字的那句话照样读得通，模型不会报，语义审读只能凭语感猜——猜出来的东西没法当证据。
// 唯一能当证据的是音频本身，所以这里换一个更强的模型，把押着疑问的那一小段重新听一遍。
//
// 触发条件不是「模型说这句有问题」，而是「ASR 自己在这几个词上没把握」：
// 4 个词的窗口里出现 ≥2 个 p<0.65 的词，就是小模型在这儿卡过的实证（实测「知(0.42) 道 会(0.55)」
// 正是它把两句话并成一句的地方）。全片最多重听 RELISTEN.maxSpans 处，逐条记账。

/**
 * 孤零零一个极低置信词（不需要邻居作证）。纯函数，可单测。
 * 「扎堆」这条触发条件的盲区就在这里：它数的是**个数**，一个 p=0.10 的字单独出现时
 * 在任何 4 词窗口里都只有它自己，永远凑不满 2 个，于是那句话从没被听过。
 */
export function isolatedLow(view, cfg = RELISTEN) {
  const ws = (view && view.ws) || []
  return ws.filter(w => typeof w.p === 'number' && w.p <= cfg.isoP).map(w => ({ i: w.i, w: w.core, p: +Number(w.p).toFixed(3) }))
}

/** 句子里低置信词扎堆的位置。纯函数，可单测。 */
export function lowConfidenceClusters(view, cfg = RELISTEN) {
  const out = []
  const ws = (view && view.ws) || []
  for (let s = 0; s < ws.length; s++) {
    const win = ws.slice(s, s + cfg.lowWindow)
    const low = win.filter(w => typeof w.p === 'number' && w.p < cfg.lowP)
    if (low.length >= cfg.lowNeeded) out.push({ at: s, n: low.length, minP: Math.min(...low.map(w => w.p)) })
  }
  return out
}

/**
 * 听音复核，并把能落地的改动落到 words 上。
 * 返回新的 current、记账 section、改动涉及的源时间区间（断言用）、净词数变化。
 */
/**
 * 音频否决：这几秒我们改过字，而音频读出来的正是**改之前**那句 → 那次改动不成立，退回原话。
 * 为什么必须有这条（自测26 实测）：45.21–47.73s「一千→一天」是**两个文本模型一致同意**的
 * （qian / tian 韵母声调同、声母不同），校验器照规矩放行；但 medium 六个窗口全读成「1000」（＝一千），
 * 没有一个窗口读成「天」。两个文本模型的共识是文本证据，替代不了音频证据——
 * 这条通道既然能改字，就必须能被音频退回来，否则「音频才是事实」只是单向的。
 * 硬约束：只退等字数的改动（词数、每个词的起止一个都不动），退完必须逐字等于音频（数字写法允许差）。
 */
/** 两段话只差一个字（漏听／多听／听错一个字）。差多了说明这条窗口本身不可信，不能拿来否决。 */
export function nearEqual(a, b) {
  const A = [...String(a || '')]
  const B = [...String(b || '')]
  if (Math.abs(A.length - B.length) > 1) return false
  if (A.length === B.length) {
    let d = 0
    for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) d++
    return d <= 1
  }
  const [S, L] = A.length < B.length ? [A, B] : [B, A]
  let i = 0
  let j = 0
  let skipped = false
  while (i < S.length && j < L.length) {
    if (S[i] === L[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true
    j++
  }
  return true
}

export function vetoPlan({ current = [], ids = [], audio = '' }) {
  const core = i => splitAffixes(current[i].w).core
  const core0 = i => splitAffixes(current[i].w0 || current[i].w).core
  const now = ids.map(core).join('')
  const orig = ids.map(core0).join('')
  if (now === orig) return { ok: false, why: '这段没被改过' }
  const changed = ids.filter(i => current[i].w0 && current[i].w0 !== current[i].w && current[i].src !== 'relisten')
  if (!changed.length) return { ok: false, why: '改过的不是文字层（或这处已由音频定过）' }
  if ([...orig].length !== [...now].length) return { ok: false, why: '退回来会改字数（' + [...orig].length + '→' + [...now].length + '），时间码会跟着动' }
  // 音频读数允许一个字的噪声：实测「我现在要花一千的时间」这句，medium 三个窗口都漏听了一个「要」。
  // 差一个字以上就不认这条读数（不是「退不回」，而是这窗口本身就不可信，宁可什么都不做）。
  if (!nearEqual(hanNumbers(orig), hanNumbers(audio))) return { ok: false, why: '音频和这句差了一个字以上，这条读数不可信' }
  // 逐词核对：音频里得听得出**改之前**那个字，而且听不出**改之后**那个字。
  const A = hanNumbers(audio)
  const proof = []
  for (const i of changed) {
    const o = hanNumbers(core0(i))
    const n = hanNumbers(core(i))
    if (!A.includes(o) || (n !== o && A.includes(n))) return { ok: false, why: '音频里没有「' + o + '」这个改之前的字', word: core0(i) }
    proof.push({ i, from: core(i), to: core0(i) })
  }
  return { ok: true, ids: changed, proof, orig, backText: orig, why: '音频读的是改动之前的原话' }
}

/**
 * 整句读数不一致时的逐字判定：只有「每个窗口都听得到」的词才算被音频确认过。
 * 指纹用「这个词 + 它后面那个字」（最后一个词用「前一个字 + 它」）：单字太容易在短窗口里撞上，
 * 实测 55.29–56.55s 的「你」在三个窗口里出现的位置都不一样，单字比对会说对，双字指纹才说明是听到的。
 */
export function confirmWords(ws = [], texts = []) {
  const list = (texts || []).map(t => String(t || '')).filter(Boolean)
  if (list.length < 2) return []
  const cores = (ws || []).map(x => strip(x.core))
  const out = []
  for (let k = 0; k < cores.length; k++) {
    const a = cores[k]
    if (!a) continue
    const pair = cores[k + 1] ? a + cores[k + 1] : (cores[k - 1] || '') + a
    if ([...pair].length < 2) continue
    if (list.every(t => t.includes(pair))) out.push({ i: ws[k].i, w: a, pair })
  }
  return out
}

async function relistenRepair({ words, current, segments, media, envelope, relistenDir, hotwords = '', hints = [], phon = [], log }) {
  const base = { model: RELISTEN.model, ran: true, candidates: 0, spans: [], applied: 0, vetoed: 0, phonProposals: phon.length, phonApplied: 0 }
  const startLen = current.length
  const off = (why, detail) => {
    if (phon.length) log('听音复核没跑（' + why + '）：' + phon.length + ' 处只能靠听音频的改法（' + phon.map(p => p.from + '→' + p.to).join('、') + '）没被确认，一律不改')
    return { current, section: { ...base, ran: false, why, detail: detail || null }, ranges: [], confirmed: [], delta: 0 }
  }
  if (!relistenEnabled()) return off('disabled', 'VISION_BOTS_RELISTEN=0')
  if (!relistenModel(RELISTEN.model)) {
    log('听音复核没跑：本机没有 faster-whisper ' + RELISTEN.model + '（要一个比 small 更强的耳朵；small 就是犯错的那个）')
    return off('no-strong-model', '本机没有 faster-whisper ' + RELISTEN.model)
  }
  if (!media) return off('no-media', '没拿到源素材路径')
  if (!segments || !segments.length) return off('no-segments', '没有句级时间戳')

  // 候选按**文字**记，不按词下标：改一处会插/删词，后面几条的下标就全歪了。
  // 处理每条时再按文字在当前的词表里重新定位，改完前面一条也不影响后面。
  // 把词表拼成字符流再找引用的位置：这样得到的区间**正好覆盖**那句话，
  // 不会把前一句的字也圈进来（第一版从每个词往后累加，找到含引用的位置就返回，
  // 结果区间起点常常偏早——实测「知道会做」的区间变成 36.46–44.58，把前面 6 秒也带上了，
  // 两个窗口的读数因此不一致，本该补的字反而没补）。
  const findRange = (needle) => {
    const q = strip(needle)
    if (!q) return null
    let s = ''
    const owner = []
    for (let i = 0; i < current.length; i++) {
      for (const ch of splitAffixes(current[i].w).core) { s += ch; owner.push(i) }
    }
    const locate = (sub) => {
      const at = s.indexOf(sub)
      if (at < 0) return null
      const a = owner[at]
      const b = owner[at + sub.length - 1]
      if (a === undefined || b === undefined) return null
      return { a, b }
    }
    // 先按整条找；找不到就逐字收窄两头。质检线索引用的是**交付字幕**里的那句话，
    // 与当前词表可能差一两个字（实测线索「AI是带最赚钱的不是技术」而词表已是「AI时代…」），
    // 整条找不到就白写了一条线索。收到 4 字还找不到才算没这句。
    const tries = [q]
    for (let k = 1; k <= 2 && q.length - k >= 4; k++) tries.push(q.slice(k), q.slice(0, q.length - k))
    for (const t of tries) { const hit = locate(t); if (hit) return { ...hit, approx: t !== q } }
    return null
  }

  // 质检报出来「音频与字幕不一致」的地方排最前：那是上一轮跑完质检留下的线索，
  // 剪辑返工时第一件该做的事就是把它听清楚（不靠猜，靠重听）。
  const hintCands = []
  const auditCands = []
  const seen = new Set()
  for (const h of hints || []) {
    const q = strip(h && h.quote)
    if (!q || seen.has(q)) continue
    seen.add(q)
    hintCands.push({ text: q, hint: h, lowN: 0, minP: 1, slot: null })
  }
  // 紧跟质检线索之后的第三档：文本层判不了、只能听音频的改法（捡 jiǎn / 卷 juǎn）。
  // 这类候选自带「应该听到哪个字」，重听后只允许那一个字被换过去，别处一个字都不许变；
  // 听到的是别的，就说明确实不是那个字，原样交回并把理由写进报告。
  const phonNotes = []
  const phonCands = []
  for (const p of phon) {
    const hit = current.findIndex(w => Math.abs(w.start - p.at) <= 0.05)
    if (hit < 0) { phonNotes.push({ from: p.from, to: p.to, skipped: '词已不在原位' }); continue }
    const v = sentenceView(current, segments).find(s => s.ws.some(x => x.i === hit))
    if (!v) { phonNotes.push({ from: p.from, to: p.to, skipped: '找不到这句' }); continue }
    if (!v.text.includes(p.from)) { phonNotes.push({ from: p.from, to: p.to, skipped: '这句已被改过：' + v.text.slice(0, 16) }); continue }
    if (seen.has(v.text)) { phonNotes.push({ from: p.from, to: p.to, skipped: '这句已在待听名单里' }); continue }
    seen.add(v.text)
    phonCands.push({ text: v.text, phon: p, lowN: 0, minP: 1, slot: null })
  }
  for (const v of sentenceView(current, segments)) {
    if (seen.has(v.text)) continue
    seen.add(v.text)
    const lowN = v.ws.filter(w => typeof w.p === 'number' && w.p < RELISTEN.lowP).length
    const minP = Math.min(...v.ws.map(w => (typeof w.p === 'number' ? w.p : 1)))
    // 词槽吞静音的迹象：一个词的时长远超它字数该占的时间、里面还压着一段静音。
    // 这是「丢了字」最直接的证据，而且与模型无关——比「低置信词多」更能说明问题。
    let slot = null
    for (const w of v.ws) {
      const ww = current[w.i]
      const an = slotAnomaly({ start: ww.start, end: ww.end, chars: [...splitAffixes(ww.w).core].length, gaps: silentGaps(envelope, ww.start, ww.end) })
      if (an.anomaly && (!slot || an.ratio > slot.ratio)) slot = { ratio: an.ratio, i: w.i, gap: an.gap }
    }
    // 第三个触发条件：句子里有没有孤零零一个极低置信词（自测26 的「时」0.23、「OP」0.254、「现在」0.358 都在这里）
    const iso = isolatedLow(v)
    if (!lowConfidenceClusters(v).length && !slot && !iso.length) continue
    auditCands.push({ text: v.text, lowN, minP, slot, iso: iso.length })
  }
  // 采集顺序：先看词槽有没有吞字的迹象（结构证据），再按**最不可信那个字有多不可信**排。
  // 原来是先比个数（b.lowN - a.lowN）：三个 p=0.5 会排在两个 p=0.1 前面，最可疑的句子反而最后才听，
  // 预算一紧就被截掉——自测25 那一版被挤掉的第一句就在成片开头。
  auditCands.sort((a, b) => (b.slot ? b.slot.ratio : 0) - (a.slot ? a.slot.ratio : 0) || a.minP - b.minP || b.lowN - a.lowN)
  // 质检线索**不占**采集预算。以前线索和采集共用 maxSpans：上一轮 17 句待查只听了 5 句，
  // 其中 3 句是线索，真正的错句（25.4s「指纹住在」）排在后面，一次都没轮到听过。
  // 线索是上一轮质检实测出来的疑点，必须听；预算只在「ASR 自己卡过」的句子里挑。
  // 只能靠音频定的那几处不占采集预算（和线索同理：它们是已知疑点，不是猜的）
  const pickedCands = [...hintCands, ...phonCands, ...auditCands.slice(0, RELISTEN.maxSpans)]
  const section = {
    ...base, candidates: hintCands.length + auditCands.length + phonCands.length, hints: hintCands.length,
    suspicious: auditCands.length,
    truncated: auditCands.length > RELISTEN.maxSpans,
    notListened: Math.max(0, auditCands.length - RELISTEN.maxSpans),
    notListenedTexts: auditCands.slice(RELISTEN.maxSpans, RELISTEN.maxSpans + 3).map(c => c.text.slice(0, 14)),
    phon: { proposals: phon.length, candidates: phonCands.length, notes: phonNotes },
    picked: pickedCands.map(c => ({ text: c.text.slice(0, 16), hint: Boolean(c.hint), phon: c.phon ? c.phon.from + '→' + c.phon.to : null, slot: c.slot ? c.slot.ratio : null, low: c.lowN, iso: c.iso || 0 })),
  }
  if (!pickedCands.length) {
    return off('nothing-suspicious', '既没有质检线索，也没有扎堆的低置信词（4 个词里 ≥2 个 p<' + RELISTEN.lowP + '）、没有单个 p≤' + RELISTEN.isoP + ' 的词、没有吞了静音的词槽，没有值得重听的地方')
  }
  if (section.truncated) {
    log('听音复核：可疑句 ' + auditCands.length + ' 句，预算 ' + RELISTEN.maxSpans + ' 句，还有 ' + section.notListened +
      ' 句没听——没听的句子仍算「没解决的怀疑」，报告里单独计数（不许拿「听过的那几句都没问题」当成全片没问题）')
  }

  const ranges = []
  const confirmed = []
  // 整句读数不一致、但某个字每个窗口都听得到的那些词下标（不放进 confirmed 区间：区间按整句算太粗）
  const confirmedIdx = new Set()
  const reject = (span, r, v, why) => {
    section.spans.push({ span, agree: true, text: r.text, mine: v.text, rejected: why })
    log('听音复核：' + span.join('–') + 's 音频是「' + r.text + '」、字幕是「' + v.text + '」，但' + why + '，不改')
  }

  for (const cand of pickedCands) {
    const rg = findRange(cand.text)
    if (!rg) { section.spans.push({ skipped: 'not-found', quote: cand.text.slice(0, 24) }); continue }
    const v = { ws: [], text: '' }
    for (let i = rg.a; i <= rg.b; i++) v.ws.push({ i, core: splitAffixes(current[i].w).core, p: current[i].p })
    v.text = v.ws.map(x => x.core).join('')
    const t0 = current[rg.a].start
    const t1 = current[rg.b].end
    const span = [+t0.toFixed(2), +t1.toFixed(2)]
    // 邻词的文字一并交进去：窗口的 pad 会把它们切进来（三个窗口都带着，所以「读数一致」也救不了），
    // 不剥掉就会被当成「我们漏了一个字」去申请插字。
    const ctx = {
      prev: rg.a > 0 ? strip(splitAffixes(current[rg.a - 1].w).core) : '',
      next: rg.b + 1 < current.length ? strip(splitAffixes(current[rg.b + 1].w).core) : '',
    }
    const r = await relistenSentence({ media, span: [t0, t1], cacheDir: relistenDir, hotwords, expect: v.text, ctx, log })
    if (!r.ok) {
      section.spans.push({ span, skipped: r.skipped, detail: r.detail || null })
      log('听音复核：' + span.join('–') + 's 没听成（' + r.skipped + '），这条不改')
      continue
    }
    // 采信条件：逐字一致，或者多数窗口一致（votes 里有几比几）。只差句外切进来一两个字时走 loose。
    if (!r.agree && !r.loose && !r.majority) {
      // 整句读数不一致，不等于每个字都没听到：这个词（带上它后面那个字当指纹）**每个窗口**都听得出来，
      // 它就算被音频确认过。自测26 实测 55.29–56.55s 三个窗口读成「只有别人看到你看」/
      // 「只有别人看到你的产品你」/「口只有别人看到你」——整句对不上，但「别人」「看到」三个窗口都有；
      // 原来整句一否决，这两个字也跟着进了「没解决」，等于把已经听得到的证据一起扔掉。
      const hitWords = confirmWords(v.ws, r.texts || [])
      section.spans.push({ span, agree: false, decodes: r.decodes, votes: r.votes || [], confirmedWords: hitWords })
      for (const c of hitWords) confirmedIdx.add(c.i)
      log('听音复核：' + span.join('–') + 's 几个窗口的整句读数不一致（' + (r.votes || []).map(v => '「' + v.text + '」×' + v.n).join(' vs ') + '），' +
        (hitWords.length ? '但每个窗口都听到「' + hitWords.map(c => c.w).join('、') + '」，这几个字算确认过' : '没有哪个字是每个窗口都听到的，整段都不算证据'))
      continue
    }
    const diff = charDiff(v.text, r.text)
    // 只能靠音频定的那一类（捡 jiǎn / 卷 juǎn）：音频必须把这一处听成提案里的那个字，
    // 而且整句其余字与字幕逐字相同。差一个字以上就不再是「这一个音节听清了」，那是另一次转写——
    // 用它改字等于让重听顺手重写整句，规矩不允许。
    if (cand.phon) {
      if (diff.same) {
        reject(span, r, v, '音频与字幕一致，都听到「' + cand.phon.from + '」，提案里的「' + cand.phon.to + '」不成立，不改')
        continue
      }
      const sw = oneCharSwap(v.text, r.text)
      if (!sw || sw.from !== cand.phon.from || sw.to !== cand.phon.to) {
        reject(span, r, v, '音频听到「' + String(r.text || '').slice(0, 16) + '」，不是提案里的「' + cand.phon.from + '→' + cand.phon.to + '」，这条不改')
        continue
      }
    }
    if (diff.same) {
      section.spans.push({ span, agree: true, confirmed: true, text: r.text })
      // 强耳朵逐字读过、和字幕一样：这句话里的词不算「没把握」了
      if (r.tier === 'strong') confirmed.push([t0 - 1e-6, t1 + 1e-6])
      log('听音复核：' + span.join('–') + 's 音频与字幕逐字一致（「' + r.text + '」），这句没有吞字')
      continue
    }
    // 音频否决（放在预算检查之前）：这段是我们自己改过的，而音频读的是改之前那句 → 撤回。
    // 撤回不受「加/删字预算」限制：它不是新改动，是把我们造成的改动退回去。
    const vp = vetoPlan({ current, ids: v.ws.map(x => x.i), audio: r.text })
    if (vp.ok) {
      const idset = new Set(vp.ids)
      const next = current.map((w, i) => idset.has(i) ? { ...w, w: w.w0, src: 'relisten-veto', fixed: false } : w)
      const backNow = v.ws.map(x => splitAffixes(next[x.i].w).core).join('')
      // 退回之后这段必须正好等于「改之前那句」。音频那边允许多一个字／少一个字的读数噪声（vp.ok 已核过），
      // 这里不再拿音频逐字比：先前就是这一步比太死（medium 漏听一个「要」），否决被当成「退不干净」放过去了。
      if (backNow === vp.orig) {
        current = next
        ranges.push([t0 - 1e-6, t1 + 1e-6])
        section.vetoed += 1
        section.spans.push({ span, agree: true, veto: true, text: r.text, mine: v.text, orig: vp.orig, applied: true, op: 'revert' })
        log('听音复核：' + span.join('–') + 's 音频是「' + r.text + '」，和**改之前**那句「' + vp.orig + '」一致 → 这处是文字层自己改错了，退回原话（时间码不动）')
        continue
      }
      reject(span, r, v, '这处改过的字没退干净（' + '退回后是「' + backNow + '」，原话是「' + vp.orig + '」），不动')
      continue
    }
    if (diff.error) { reject(span, r, v, diff.error); continue }
    const ws = v.ws.map(w => ({ i: w.i, core: w.core, start: current[w.i].start, end: current[w.i].end }))
    const gapsOf = i => silentGaps(envelope, current[i].start, current[i].end)
    const rep = planRepair({ ws, diff, gapsOf })
    if (!rep.ok) { reject(span, r, v, rep.why); continue }

    // 弱耳朵（还是 small，只是紧窗口重听）只能给「本来就该有的字」命名，不能自己开一扇门：
    // 要它授权补字，必须再加一条与模型无关的证据——那个词槽明显吞了静音
    // （实测「会」一个字的槽 0.88s，等于 5.5 个字的时长，里面有 0.46s 静音）。
    // 改字只认「强耳朵 + 两个窗口都听成」：弱耳朵就是犯错的那个模型（实测它把「知道」读成「直到」），
    // 让它授权改字等于用一个错去改另一个错。
    if (r.tier !== 'strong' || r.single) {
      reject(span, r, v, r.tier !== 'strong'
        ? '弱耳朵（' + r.model + '）不能单独授权改字，它自己也会听错'
        : '强耳朵这次只有一个窗口听成了（另一个没起来），改字要两个窗口逐字一致')
      continue
    }

    let next = null
    if (rep.op === 'insert') {
      const host = current[rep.host]
      const nw = { w: rep.newWord.w, start: rep.newWord.start, end: rep.newWord.end, p: host.p, fixed: true, src: 'relisten' }
      const nh = { ...host, start: rep.hostStart, fixed: true, src: 'relisten' }
      next = [...current.slice(0, rep.host), nw, nh, ...current.slice(rep.host + 1)]
    } else if (rep.op === 'sub') {
      // 等字数替换：只换词里的字，时间码一个字都不动
      next = current.map((w, i) => {
        const hp = rep.parts.find(x => x.i === i)
        if (!hp) return w
        const af = splitAffixes(w.w)
        return { ...w, w: af.lead + hp.to + af.trail, fixed: true, src: 'relisten' }
      })
    } else if (rep.op === 'respeak') {
      // 一处重说：吃掉整词、合成一个词，占这一段的起止（句子起点因此不动）
      const ids = rep.eaten.map(e => e.i).sort((x, y) => x - y)
      const a = ids[0]
      const z = ids[ids.length - 1]
      if (z - a + 1 !== ids.length) { reject(span, r, v, '重说吃掉的词不连续'); continue }
      const p = Math.min(...ids.map(i => (typeof current[i].p === 'number' ? current[i].p : 1)))
      const nw = { w: rep.ins, start: current[a].start, end: current[z].end, p, fixed: true, src: 'relisten' }
      next = [...current.slice(0, a), nw, ...current.slice(z + 1)]
      if (a === 0 && next[0] && Math.abs(next[0].start - current[0].start) > 1e-6) { reject(span, r, v, '重说挪动了句子起点'); continue }
    } else if (rep.op === 'delete') {
      if (rep.eaten.some(e => !e.full)) { reject(span, r, v, '删字切在词中间，v1 不拆词'); continue }
      const ids = new Set(rep.eaten.map(e => e.i))
      if (Math.min(...ids) === 0) { reject(span, r, v, '删掉的是句首词，v1 不动句子起点'); continue }
      let carry = null
      const out = []
      for (let i = 0; i < current.length; i++) {
        if (ids.has(i)) { carry = current[i].end; continue }
        if (carry !== null && out.length) {
          out[out.length - 1] = { ...out[out.length - 1], end: carry, fixed: true, src: 'relisten' }
          carry = null
        }
        out.push(current[i])
      }
      if (carry !== null && out.length) out[out.length - 1] = { ...out[out.length - 1], end: carry, fixed: true, src: 'relisten' }
      next = out
    }
    if (!next) { reject(span, r, v, '没有可落地的改法'); continue }

    // 落地后那句必须逐字对上音频，对不上就整处撤回，绝不半截改。
    // 不用句子视图（可能跨段），直接在改完的词表附近重新做一次文字对齐。
    const back = alignCrop(r.text, next.slice(Math.max(0, rg.a - 1), rg.b + 6).map(w => ({ w: w.w })))
    if (!back || back.text !== r.text) {
      reject(span, r, v, '改完仍对不上音频（' + (back ? '「' + back.text + '」' : '句子散了') + '），已撤回')
      continue
    }
    current = next
    if (cand.phon) section.phonApplied = (section.phonApplied || 0) + 1
    // 删字会把它前面那个词的 end 延长到被删词的 end，那个词的时间码确实变了，
    // 所以要把它一起划进「允许变动」的区间，否则断言会把它当成越权改动。
    const widen = rep.op === 'delete' ? current[Math.max(0, rg.a - 1)].start : t0
    ranges.push([Math.min(t0, widen) - 1e-6, t1 + 1e-6])
    section.applied += 1
    section.spans.push({
      span, agree: true, loose: r.loose || undefined, text: r.text, mine: v.text, applied: true, op: rep.op,
      tier: r.tier, model: r.model,
      added: rep.op === 'insert' ? rep.newWord.w : null,
      gap: rep.gap || null,
      phon: cand.phon ? { from: cand.phon.from, to: cand.phon.to, pinyin: cand.phon.pinyin, rime: cand.phon.rime } : undefined,
      decodes: r.decodes,
    })
    log('听音复核：' + span.join('–') + 's 字幕「' + v.text + '」→ 音频「' + r.text + '」' +
      (rep.op === 'insert'
        ? '（补「' + rep.newWord.w + '」，放进 ' + rep.gap[0] + '–' + rep.gap[1] + 's 的静音缝隙）'
        : rep.op === 'sub'
          ? '（把「' + rep.parts.map(x => x.from).join('') + '」改成「' + rep.parts.map(x => x.to).join('') + '」，时间码不动）'
          : rep.op === 'respeak'
            ? '（「' + rep.eaten.map(e => e.core).join('') + '」整段重说成「' + rep.ins + '」，合成一个词、时间码不动）'
            : '（删 ' + rep.eaten.length + ' 个词）') + '；两次听一致（强耳朵 ' + r.model + '，两个窗口）' +
      (cand.phon ? '；这处文本层判不了（' + cand.phon.pinyin + '），只有音频能分' : ''))
  }
  section.delta = current.length - startLen
  section.confirmedSpans = confirmed.length
  return { current, section, ranges, confirmed, confirmedIdx, delta: section.delta }
}

/**
 * 主入口。返回 {words, report}。
 */
/**
 * 「还没解决的怀疑」＝ 低置信、又没被音频确认过的词。分两类，因为能做的事不同：
 *   never-heard   这句从来没被强耳朵听过 → 该去听（预算曾是它唯一的天花板）
 *   audio-differs 听过了、音频和字幕不一致，但改法过不了约束 → 需要人来定
 *
 * 为什么要把这两类分开（自测25 的血账）：原来的报告只写「没把握 15/248 = 6.0%」，
 * 那 15 个字全落在 10 句从没被听过的句子里，而流水线既不因此去听、也不因此停下——
 * 这个数字只是装饰。其中一句就是成片开头：「今天大街都在卷AI技术」，
 * 强耳朵三个窗口全听成「今天大家…」，带错出厂，质检 19/19 也没拦住。
 */
export function openQuestions({ current = [], appliedIdx = new Set(), audioIdx = new Set(), heardRanges = [], openRanges = [], confirmedIdx = new Set(), lowP = LOW_P, isoP = RELISTEN.isoP }) {
  const inside = (w, ranges) => ranges.some(r => Array.isArray(r) && w.start >= r[0] && w.end <= r[1] + 1e-6)
  const out = []
  for (let i = 0; i < current.length; i++) {
    const w = current[i]
    if (!(typeof w.p === 'number' && w.p < lowP)) continue
    if (appliedIdx.has(i) || audioIdx.has(i)) continue
    // 强耳朵逐字读过、和字幕一样 → 这不是怀疑，是已核对过的事实
    if (inside(w, heardRanges)) continue
    // 整句读数不一致，但这个字每个窗口都听得到 → 也是核对过的事实（只是核对粒度是字，不是句）
    if (confirmedIdx.has(i)) continue
    // strong=true 是「小模型自己说这个音没听准」（p≤0.40）：这种必须去听掉，留着就是没追到底。
    // strong=false 是 p 在 0.40–0.65 之间的常见词：whisper 对这种词本来就这样，没有结构信号，
    // 记下来但不去追——把两者混成一个「没把握 N 个字」，才是自测25 那个装饰数字的老毛病。
    const strong = typeof w.p === 'number' && w.p <= isoP
    out.push({ i, at: +w.start.toFixed(2), w: w.w, p: +Number(w.p).toFixed(3), strong, why: inside(w, openRanges) ? 'audio-differs' : 'never-heard' })
  }
  return out
}

export async function correct({ words, terms, log = () => {}, askModel = true, segments = null, media = null, envelope = null, relistenDir = null, hints = [] }) {
  const t0 = Date.now()

  const g = applyTerms(words, terms)
  let current = g.words
  const report = {
    at: new Date().toISOString(),
    hotwords: hotwordPrompt(terms),
    termSources: terms.sources || [],
    glossary: { applied: g.hits, skipped: g.skipped, merged: (g.merged || []).length, wordCountDelta: g.delta || 0 },
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
  let view = null
  let passNeed = []
  let passLen = []
  if (askModel && segments && segments.length) {
    const touched = new Set()
    for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) touched.add(a.i + k)
    view = sentenceView(current, segments)
    if (view.length) {
      const r2 = await callSentenceReview(view)
      if (r2.skipped) {
        report.sentence = { skipped: r2.skipped, detail: r2.detail || null }
        log('整句纠错：模型没接上（' + r2.skipped + '），只做了第一遍')
      } else {
        const v2 = await validateSpans(r2.proposals || [], current, view, { skip: touched, terms })
        passNeed = v2.rejected.filter(x => x.need && x.from && x.to)
        passLen = v2.rejected.filter(x => /^字数变了/.test(x.why) && x.from && x.to)
        report.sentence = { ok: true, model: r2.model, ms: r2.ms, tokens: r2.tokens, proposals: (r2.proposals || []).length, sentences: view.length, trimmed: passLen.length }
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

  // 语义型错的通道，两步：
  //   ① 字数不对就带着具体数字回问一遍（「指纹住在」4 字、「真正在」3 字）；
  //   ② 剩下的「几何都对、只差证据」交给**另一个**模型独立复读，逐字相同才采纳。
  // 同一模型问两遍不构成第二条独立事实，所以 ② 必须换模型。这也是接 Opus 的插槽：只换这里。
  if (askModel && view && passLen.length) {
    const r1c = await callSentenceReview(view, { nudge: LEN_NUDGE(passLen) })
    if (r1c.skipped) {
      report.retry = { skipped: r1c.skipped, detail: r1c.detail || null }
      log('字数回问：模型没接上（' + r1c.skipped + '）')
    } else if ((r1c.proposals || []).length) {
      const touched = new Set()
      for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) touched.add(a.i + k)
      const v1c = await validateSpans(r1c.proposals, current, view, { skip: touched, terms })
      report.applied.push(...v1c.accepted)
      report.rejected.push(...v1c.rejected)
      report.retry = { ok: true, model: r1c.model, proposals: r1c.proposals.length, accepted: v1c.accepted.length, ms: r1c.ms }
      passNeed = passNeed.concat(v1c.rejected.filter(x => x.need && x.from && x.to))
      const by1c = new Map()
      for (const a of v1c.accepted) {
        const parts = a.parts || [a.to]
        for (let k = 0; k < (a.n || 1); k++) by1c.set(a.i + k, parts[k])
      }
      current = current.map((w, i) => by1c.has(i) ? { ...w, w: by1c.get(i), w0: w.w0 || w.w, fixed: true } : w)
      log('字数回问：' + r1c.proposals.length + ' 提案 / 采纳 ' + v1c.accepted.length + ' / 打回 ' + v1c.rejected.length)
    } else {
      report.retry = { ok: true, model: r1c.model, proposals: 0 }
      log('字数回问：模型这次一条都没报')
    }
  }

  if (askModel && view && passNeed.length) {
    const pair = proposerCall()
    report.models = { proposer: pair.primary, auditor: pair.auditor, distinct: pair.distinct }
    if (!pair.distinct) {
      report.dual = { skipped: 'single-model', detail: '提案模型和第二意见撞成同一只（' + pair.primary + '），凑不出第二意见' }
    } else {
      const r1b = await callSentenceReview(view, { model: pair.auditor })
      if (r1b.skipped) {
        report.dual = { skipped: r1b.skipped, detail: r1b.detail || null }
        log('第二意见：模型没接上（' + r1b.skipped + '），语义型错这轮不改')
      } else {
        const key = o => o.s + '|' + o.from + '|' + o.to
        const mapKey = m => (m || []).map(([i, t]) => i + ':' + t).sort().join('|')
        const seen = new Set()
        const phonDual = []
        for (const p of r1b.proposals || []) {
          const v = view[Number(p && p.s) - 1]
          if (!v || !p.from || !p.to) continue
          const loc = locateInSentence(v, String(p.from))
          if (loc.error) continue
          const i = v.ws[loc.a].i
          const n = loc.b - loc.a + 1
          const sp = applySpan(current, i, n, String(p.to).trim(), { latinOk: true, allowDelete: true })
          if (sp.error) continue
          const m = []
          for (let q = 0; q < n; q++) {
            const before = splitAffixes(current[i + q].w).core
            const after = splitAffixes(sp.parts[q]).core
            if (after !== before) m.push([i + q, after])
          }
          const k = mapKey(m)
          if (k) seen.add(k)
          // 第二模型自己报的改法：正好是「只差一个元音」那一类（捡 jiǎn / 卷 juǎn）时，
          // 也交给听音复核。它常常和第一模型的提案对不上（一个说抓、一个说卷），
          // 按现在的配对逻辑整个被丢掉——可这一类的判据本来就是音频，不是两个模型对不对得上。
          const core1 = splitAffixes(current[i].w).core
          const core2 = String(p.to ?? '').trim()
          if (n === 1 && [...core1].length === 1 && [...core2].length === 1 && core1 !== core2) {
            phonDual.push({ i, at: +current[i].start.toFixed(2), from: core1, to: core2, why: String(p.why || '').slice(0, 40) })
          }
        }
        if (phonDual.length) {
          const vals = await phoneticOf(phonDual.flatMap(x => [x.from, x.to]))
          let added = 0
          for (let k = 0; k < phonDual.length; k++) {
            const a = vals && vals[k * 2]
            const b = vals && vals[k * 2 + 1]
            const ph = phonOnly(a, b)
            if (!ph) continue
            const cur = report.phonProposals || []
            if (cur.length >= PHON_CAP) break
            if (cur.some(x => Math.abs(x.at - phonDual[k].at) < 0.05)) continue
            report.phonProposals = [...cur, { ...phonDual[k], pinyin: a.py + ' vs ' + b.py, rime: ph.ini + ph.rimeA + ' vs ' + ph.ini + ph.rimeB, by: '第二模型' }]
            added++
          }
          if (added) log('第二意见：另有 ' + added + ' 处只差一个元音（' + phonDual.map(x => x.from + '→' + x.to).join('、') + '），也交听音复核')
        }
        const duals = new Set(passNeed.filter(x => seen.has(mapKey(x.map))).map(key))
        report.dual = {
          ok: true, model: r1b.model, need: passNeed.length, agreed: duals.size, ms: r1b.ms, tokens: r1b.tokens, accepted: 0,
          proposals: (r1b.proposals || []).map(p => ({ s: p.s, from: p.from, to: p.to })),
          waiting: passNeed.map(x => ({ s: x.s, from: x.from, to: x.to })),
        }
        if (duals.size) {
          const touched = new Set()
          for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) touched.add(a.i + k)
          const v1b = await validateSpans(
            passNeed.map(x => ({ s: x.s, from: x.from, to: x.to, why: x.why })),
            current, view, { skip: touched, terms, duals, dualModel: r1b.model })
          report.applied.push(...v1b.accepted)
          report.rejected.push(...v1b.rejected)
          report.dual.accepted = v1b.accepted.length
          const by1b = new Map()
          for (const a of v1b.accepted) {
            const parts = a.parts || [a.to]
            for (let k = 0; k < (a.n || 1); k++) by1b.set(a.i + k, parts[k])
          }
          current = current.map((w, i) => by1b.has(i) ? { ...w, w: by1b.get(i), w0: w.w0 || w.w, fixed: true } : w)
          log('第二意见（' + r1b.model + '）：' + passNeed.length + ' 条只差证据 / ' + duals.size + ' 条两个模型逐字一致 / 采纳 ' + v1b.accepted.length)
        } else {
          log('第二意见（' + r1b.model + '）：' + passNeed.length + ' 条只差证据，但两个模型没给出同一改法，一条都不采纳')
        }
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
      // 只差一个元音的改法（捡→卷）文本层判不了，记下来交给第五遍听音复核
      if (v.phon && v.phon.length) {
        report.phonProposals = v.phon
        log('错字纠错：' + v.phon.length + ' 处只能靠听音频（' + v.phon.map(p => p.from + '→' + p.to).join('、') + '），已交给听音复核')
      }
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
        report.review = {
          ok: true, model: r3.model, ms: r3.ms, tokens: r3.tokens, proposals: (r3.proposals || []).length, sentences: view3.length,
          raw: (r3.proposals || []).map(p => ({ s: p.s, from: p.from, to: p.to })),
        }
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

  // 第五遍：听音复核。只重听 ASR 自己卡过的那几句，预算 RELISTEN.maxSpans 处。
  const aud = await relistenRepair({ words, current, segments, media, envelope, relistenDir, hotwords: hotwordPrompt(terms), hints, phon: report.phonProposals || [], log })
  current = aud.current
  report.relisten = aud.section

  const appliedIdx = new Set()
  for (const a of report.applied) for (let k = 0; k < (a.n || 1); k++) appliedIdx.add(a.i + k)
  const audioIdx = new Set(current.map((w, i) => (w.src === 'relisten' ? i : -1)).filter(i => i >= 0))
  const heardRanges = [...(aud.ranges || []), ...(aud.confirmed || [])]
  // 听过了、但音频和字幕对不上、又落不了地的那些区间：它们也是「没解决」，只是原因不同
  const openRanges = ((aud.section && aud.section.spans) || [])
    .filter(s => Array.isArray(s.span) && (s.agree === false || s.rejected))
    .map(s => s.span)
  report.pending = openQuestions({ current, appliedIdx, audioIdx, heardRanges, openRanges, confirmedIdx: aud.confirmedIdx || new Set() })

  // 硬约束改两条，都比原来更严：
  //   · 改动那句**外面**的词，起止一个字节都不许动（原来要求全片逐词相等；
  //     听音复核补字会在这句里插词，全片相等就不再成立，所以按句子划界）；
  //   · 词数的变化必须正好等于听音复核插/删的词数，多一个少一个都算越权。
  // 英文碎片合并也改变了词边界（3 个词变 1 个），它占的那段时间同样算「允许变动」，
  // 但只限那一段：合并之外的词，起止仍然一个字节都不许动。
  const mergeRanges = (g.merged || []).map(h => [h.start - 1e-6, h.end + 1e-6])
  const inRange = w => aud.ranges.some(r => w.start >= r[0] && w.end <= r[1] + 1e-6) ||
    mergeRanges.some(r => w.start >= r[0] && w.end <= r[1])
  const slice = arr => JSON.stringify(arr.filter(w => !inRange(w)).map(w => [+w.start.toFixed(3), +w.end.toFixed(3)]))
  report.assertion = {
    wordCount: current.length === words.length + (aud.delta || 0) + (g.delta || 0),
    timingUntouched: slice(words) === slice(current),
    audioRepairs: aud.section.applied,
    mergeDelta: g.delta || 0,
    wordCountDelta: current.length - words.length,
  }
  if (!report.assertion.wordCount || !report.assertion.timingUntouched) {
    // 报错要能定位：把区间外对不上的前几处写进报告（只报「动了时间码」等于没报）
    const outA = words.filter(w => !inRange(w))
    const outB = current.filter(w => !inRange(w))
    const bad = []
    for (let i = 0; i < Math.min(outA.length, outB.length) && bad.length < 5; i++) {
      if (outA[i].start !== outB[i].start || outA[i].end !== outB[i].end) bad.push({ i, a: [outA[i].start, outA[i].end, outA[i].w], b: [outB[i].start, outB[i].end, outB[i].w] })
    }
    report.assertion.detail = { ranges: aud.ranges, mergeRanges, outA: outA.length, outB: outB.length, bad }
    throw new Error('纠错层动了时间码或词数，已中止（这是硬约束）：' + JSON.stringify(report.assertion))
  }
  report.stats = {
    words: current.length,
    changed: report.applied.length,
    rejected: report.rejected.length,
    pending: report.pending.length,
    // 没解决的两类分开计数：没听过（该去听）／听过但音频和字幕不一致（要人定）
    pendingNever: report.pending.filter(x => x.why === 'never-heard').length,
    pendingDisagree: report.pending.filter(x => x.why === 'audio-differs').length,
    // 其中「小模型自己说这个音没听准」（p≤0.40）的有几个：这几个必须去听掉，留着就是没追到底
    pendingStrong: report.pending.filter(x => x.strong).length,
    vetoed: (report.relisten && report.relisten.vetoed) || 0,
    suspicious: (report.relisten && report.relisten.suspicious) || 0,
    unheard: (report.relisten && report.relisten.notListened) || 0,
    spans: report.applied.filter(a => (a.n || 1) > 1).length,
    dual: report.applied.filter(a => /双模型一致/.test(String(a.verified || ''))).length,
    deleted: report.applied.reduce((n, a) => n + (a.deleted || 0), 0),
    near: report.applied.filter(a => a.kind === 'near').length,
    span: report.applied.filter(a => a.kind === 'span').length,
    relisten: aud.section.applied || 0,
    // 只差一个元音的那一类：文本层判不了，只有音频能定
    phon: (report.phonProposals || []).length,
    phonApplied: aud.section.phonApplied || 0,
    ms: Date.now() - t0,
  }
  const aiAccepted = report.applied.length - g.hits.length
  log(`错字治理：术语表 ${g.hits.length} 处 · 整句 ${report.sentence && report.sentence.ok ? report.sentence.proposals + ' 提案' : '未接'} · 逐词 ${report.model && report.model.ok ? report.model.proposals + ' 提案' : '未接'} · 第二意见 ${report.dual && report.dual.ok ? report.dual.need + ' 待证/' + report.dual.agreed + ' 一致' : '未用'} · 采纳 ${aiAccepted}（整段 ${report.stats.span}、双模型 ${report.stats.dual}） · 听音复核 ${report.relisten && report.relisten.ran ? ((report.relisten.suspicious || 0) + ' 句可疑/' + report.relisten.applied + ' 处落地' + (report.stats.unheard ? '/' + report.stats.unheard + ' 句没听' : '') + (report.stats.vetoed ? '/否决 ' + report.stats.vetoed + ' 处' : '')) : '未跑'}${report.stats.phon ? '（含只差一个元音 ' + report.stats.phonApplied + '/' + report.stats.phon + '）' : ''} · 打回 ${report.rejected.length} · 没解决 ${report.pending.length}（没听过 ${report.stats.pendingNever}、音频不一致 ${report.stats.pendingDisagree}）`)
  return { words: current, report }
}