/**
 * 句级大字：口播说到哪一句，屏上挂的就是哪一句的标题。
 *
 * 以前大字挂在「段落」上（一段 2–4 句、最长 16 秒），结果是口播已经进了下一句，
 * 大字还停在上一句的标题上——用户 2026-11-24 明确指出「说到下一段了，字幕还在上一段」。
 * 现在大字区间 = 句子区间：句子开头那一刻换，句中不换。
 *
 * 规则比段落标题更严：标题的每个字都必须在这一句里出现过（不是 80%，是 100%），
 * 所以它只可能是「正在说的这句」的压缩，不可能变成别的句子的总结。
 * 模型给不出合格的就退回确定性摘句（从这句里挑一段原话），绝不静默留空、也不许编。
 */
import { chatJSON, LLM } from './llm.mjs'
import { segment } from './segment.mjs'

export const HEADLINE = {
  minChars: 2,
  maxChars: 8,      // 9:16 上 8 个字一行放得下；再长就要缩号，压到人物胸前
  hardMax: 10,
  // 结尾落在这类字上是半句话，上屏像被截断。
  // 虚词之外还加了「做/出/说/看/用/给/要/会/能/去/来」这类光杆动词和「你/我/他」这类代词：
  // 真素材上模型给过「满大街在做」「都能做出你」「一天做出」——都是把一句话在词中间掐断，
  // 读起来像字幕卡了。重写一次基本都能落回实词（2026-11-24 实测）。
  badTail: '的了是在和就都也才把给对从但而很太更不没有着过吧呢吗啊嘛做说看用要会能去来出你我他她它们',
  badHead: /^(但是|然后|所以|因为|而且|就是|其实|如果|只有|或者|还是|这个|那个|就是说)/,
  // 太短的句子不值得单独占大字：说话只要 1 秒，大字一闪反而像抖，
  // 这一句交给底部字幕 pill（它本来就有）。宁缺毋滥，也不拿上一句的字来凑。
  minSec: 1.15,
}

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/g
const strip = s => String(s || '').replace(PUNCT, '')
const chars = s => [...strip(s)]

/** 字的多重集合：中文里同一个字可能出现两次，只查「有没有」会放过照抄一个字的标题 */
function pool(text) {
  const m = new Map()
  for (const ch of chars(text)) m.set(ch, (m.get(ch) || 0) + 1)
  return m
}

/** 标题是不是完全由这一句的字组成（含重复次数）。渲染前还会再验一次，防止改字之后标题变旧。 */
export function insideSentence(text, sentence) {
  const p = pool(sentence)
  for (const ch of chars(text)) {
    const n = p.get(ch) || 0
    if (!n) return false
    p.set(ch, n - 1)
  }
  return true
}

/**
 * 是不是这一句里**连续**的一段。
 * 只查「字都在这一句里」（insideSentence）挡不住从中间抽字：
 * 「真正赚钱的有几个」抽掉一个「的」还是「字都在」，但读起来是「真正赚钱几个」——
 * 自测 03–10 的大字里一直有这种被掐断的句子，根因就是接地只查字袋子、不查连续性。
 */
export function contiguous(text, sentence) {
  const t = strip(text), s = strip(sentence)
  return Boolean(t) && s.includes(t)
}

/** 一条标题能不能挂在这一句上：长度、连续取自本句、开头结尾不是半句话。纯函数，可单测。 */
export function checkHeadline(text, sentence) {
  const t = strip(text)
  if (!t) return { ok: false, why: '空标题' }
  const cs = [...t]
  if (cs.length < HEADLINE.minChars) return { ok: false, why: '少于 ' + HEADLINE.minChars + ' 字' }
  if (cs.length > HEADLINE.hardMax) return { ok: false, why: '超过 ' + HEADLINE.hardMax + ' 字' }
  if (cs.length > HEADLINE.maxChars) return { ok: false, why: '超过 ' + HEADLINE.maxChars + ' 字' }
  if (!insideSentence(t, sentence)) {
    const p = pool(sentence)
    const bad = cs.filter(ch => !p.has(ch))
    return { ok: false, why: '有这一句里没有的字：' + [...new Set(bad)].join('') }
  }
  if (!contiguous(t, sentence)) return { ok: false, why: '不是这一句里连续的一段（中间抽掉了字）' }
  const last = cs[cs.length - 1]
  if (HEADLINE.badTail.includes(last)) return { ok: false, why: '结尾是「' + last + '」，读起来是半句话' }
  if (HEADLINE.badHead.test(t)) return { ok: false, why: '以连接词开头，抓不住人' }
  return { ok: true, chars: cs.length }
}

const CONNECTIVE = /^(但是|然后|所以|因为|而且|就是|其实|如果|只有|或者|还是|这个|那个|就是说|所以说|我最近|我们现在)/

/**
 * 模型没给或没过的兜底：从这一句里挑一段原话，规则全是确定性的。
 * 挑法：在词边界上截 2–8 字，内容词（≥2 字的词）越多越靠前；避开连接词开头和虚词结尾。
 */
export function pickHeadline(sentence) {
  const text = strip(sentence)
  if (!text) return ''
  if (text.length <= HEADLINE.maxChars) return HEADLINE.badHead.test(text) ? text.slice(0, HEADLINE.maxChars) : text
  const words = segment(text).length ? segment(text) : [...text]
  let best = null
  for (let i = 0; i < words.length; i++) {
    let acc = ''
    for (let j = i; j < words.length; j++) {
      acc += words[j]
      if (acc.length > HEADLINE.maxChars) break
      if (acc.length < HEADLINE.minChars) continue
      let score = 0
      for (let k = i; k <= j; k++) score += words[k].length >= 2 ? words[k].length : 0
      if (CONNECTIVE.test(acc)) score -= 2.5
      if (HEADLINE.badTail.includes(acc[acc.length - 1])) score -= 1.5
      if (acc.length < 3) score -= 1
      if (!best || score > best.score) best = { text: acc, score }
    }
  }
  return best ? best.text : text.slice(0, HEADLINE.maxChars)
}

function promptFor(input) {
  return [
    '你在给竖屏口播视频写「大字」：一句一条，这条字只在说这一句的那两秒里停在画面上。',
    '要求：',
    '- 每条 3–6 个汉字（最多 8 个）：是这一句的压缩，不是整句照抄，也不是总结别的句子。',
    '- 只能用这一句原文里出现过的字；不许引入这句里没有的数字、人名、平台名、结论。',
    '- 结尾落在实词上，不许是「的、了、是、在、就、都、也、才、把」这类字——那是半句话。',
    '- 不许以「但是、然后、所以、因为、就是」开头；不要问句、不要感叹号。',
    '- 每条只对指定的那一句负责：不要拿前后句的内容来概括，也不要跨句改写。',
    '- 必须是这一句里连续的一段：可以砍头、可以砍尾，不能从中间抽字。',
    '  原文「真正赚钱的有几个呢」写成「真正赚钱几个」（抽掉一个「的」）就要退回原句重来。',
    '',
    '示范：原文「但是我今天就要给大家泼一瓶冷水」→ 大字「泼一瓶冷水」；',
    '原文「真正的机会是在OPC结合内容」→「机会是在OPC」（不能写成「真正机会在OPC」）；',
    '原文「研究了一圈」→「研究了一圈」（整句就是短的，照旧）。',
    '',
    '句子（index / 原文）：',
    JSON.stringify(input, null, 1),
    '',
    '只输出 JSON：{"titles":[{"index":1,"text":"3到6个字"}]}',
  ].join('\n')
}

function validateBatch(list, asked, used) {
  const byIndex = new Map()
  for (const t of asked) {
    const i = Number(t && t.index)
    if (Number.isInteger(i)) byIndex.set(i, String(t.text || ''))
  }
  return list.map(s => {
    const raw = byIndex.get(s.index)
    if (!raw) return { index: s.index, text: pickHeadline(s.text), source: 'rules', ok: true, why: '模型没给这一句' }
    const c = checkHeadline(raw, s.text)
    if (!c.ok) {
      const fallback = pickHeadline(s.text)
      return { index: s.index, text: fallback, source: 'rules', ok: true, why: c.why, asked: strip(raw) }
    }
    const t = strip(raw)
    if (used.has(t)) {
      // 同一句话说了两遍时，两条大字相同是可以接受的（内容确实一样），只是记一笔
      return { index: s.index, text: t, source: 'model', ok: true, dup: true }
    }
    used.add(t)
    return { index: s.index, text: t, source: 'model', ok: true, chars: c.chars }
  })
}

/**
 * 给每句要一条大字。返回的 titles 一定和 sentences 等长、索引一一对应。
 * 打回一轮只重写不合格的；还不行用 pickHeadline 兜底（source: 'rules'），
 * 所以画面上不会出现「这一句没有大字」的空档。
 */
export async function titleSentences({ sentences, log = () => {}, repair = true } = {}) {
  const list = (Array.isArray(sentences) ? sentences : []).filter(s => s && strip(s.text))
  if (!list.length) return { ok: false, skipped: 'no-sentences', titles: [] }
  const input = list.map(s => ({ index: s.index, 原文: strip(s.text) }))
  const r = await chatJSON({ prompt: promptFor(input), maxTokens: 1800, model: LLM.models.fast })
  if (!r.ok) {
    log('句级大字：模型没接上（' + r.skipped + '），按原文摘句')
    return { ok: false, skipped: r.skipped, detail: r.detail || null, titles: list.map(s => ({ index: s.index, text: pickHeadline(s.text), source: 'rules', ok: true })), model: null }
  }
  const got = Array.isArray(r.value && r.value.titles) ? r.value.titles : []
  const used = new Set()
  let titles = validateBatch(list, got, used)

  const rejected = titles.filter(t => t.asked)
  let repairInfo = null
  if (repair && rejected.length) {
    const secs = rejected.map(t => list.find(s => s.index === t.index)).filter(Boolean)
    const fixPrompt = [
      '下面这几句的大字没过校验，原因在「不合格」里。只重写这几句，规则同前：',
      '3–6 个汉字、只能用这一句原文里的字、结尾落在实词上、不许以「但是/所以/然后/就是」开头。',
      JSON.stringify(rejected.map((t, i) => ({ index: t.index, 原文: strip(secs[i].text), 不合格: t.why, 上一版: t.asked })), null, 1),
      '只输出 JSON：{"titles":[{"index":1,"text":"3到6个字"}]}',
    ].join('\n')
    const r2 = await chatJSON({ prompt: fixPrompt, maxTokens: 900, model: LLM.models.fast })
    if (r2.ok) {
      const fixed = validateBatch(secs, Array.isArray(r2.value && r2.value.titles) ? r2.value.titles : [], used)
      const by = new Map(fixed.map(t => [t.index, t]))
      let n = 0
      titles = titles.map(t => {
        const f2 = by.get(t.index)
        if (f2 && f2.source === 'model' && t.asked) { n++; return f2 }
        return t
      })
      repairInfo = { asked: rejected.length, fixed: n }
      log('句级大字：打回 ' + rejected.length + ' 条（' + rejected.map(t => t.why).slice(0, 2).join('；') + '），重写后补上 ' + n + ' 条')
    } else {
      log('句级大字：重写没接上（' + r2.skipped + '），这几句按原文摘句')
    }
  }

  const modelCount = titles.filter(t => t.source === 'model').length
  log('句级大字：' + list.length + ' 句，模型采纳 ' + modelCount + ' 条，其余按原文摘句')
  return { ok: true, model: r.model, ms: r.ms, tokens: r.tokens, titles, stats: { asked: got.length, adopted: modelCount, total: list.length, repaired: repairInfo } }
}
