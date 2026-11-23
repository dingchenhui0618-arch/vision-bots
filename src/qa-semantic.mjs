/**
 * 语义层质检：模型读交付前的字幕全文，找数值查不出来的错。
 *
 * 数值层（静音、响度、对比度、排版、重复句、低置信词占比）证明不了「这句话说的是不是人话」——
 * 真素材自测里「泼一瓶」「花一千」这种同音错和整句崩，全部从数值层底下溜过去了。
 *
 * 三条硬规矩，缺一条这层就不许算通过：
 * 1. 模型只能加严，不能放宽：它产出的问题只进入「新增失败项」，删不掉任何代码检查。
 * 2. 每条问题必须带逐字引用（quote），引用不在交付文本里就算模型编的，直接不采信。
 * 3. 同音错字必须过硬校验（字数不变 + 拼音一致），验不过只降级成「疑似」，不当作确定错误。
 */
import { chatJSON, LLM } from './llm.mjs'
import { validate as validateFixes } from './asr-fix.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/g
const strip = s => String(s || '').replace(PUNCT, '')

export const KINDS = { homophone: '同音错字', semantic: '语句不通', repeat: '重复句', offtopic: '跑题' }
export const SEMANTIC = { maxIssues: 12, maxTokens: 1400, timeoutMs: 90000 }

/**
 * 读全性验证：条数 + 首尾卡的开头都要对得上。纯函数，可单测。
 * 只验条数的话，一个没读卡的模型也能数出来，所以首尾各要一个逐字证据。
 */
export function confirmsReading(value, cards = []) {
  const v = value || {}
  const n = Number(v.checkedCaps)
  if (!Number.isFinite(n)) return { ok: false, why: '没给 checkedCaps' }
  if (n !== cards.length) return { ok: false, why: '说看了 ' + n + ' 张，实际 ' + cards.length + ' 张' }
  const first = strip(cards[0] && cards[0].text).slice(0, 4)
  const last = strip(cards.at(-1) && cards.at(-1).text).slice(0, 4)
  const fq = strip(v.firstQuote || '')
  const lq = strip(v.lastQuote || '')
  // 前 4 个字因为标点/断句可能有出入，允许模型给的开头包含在首张卡里或反过来
  const okFirst = fq && (first.startsWith(fq) || fq.startsWith(first))
  const okLast = lq && (last.startsWith(lq) || lq.startsWith(last))
  if (!okFirst) return { ok: false, why: '第一张卡开头对不上（给的是「' + fq + '」，实际「' + first + '」）' }
  if (!okLast) return { ok: false, why: '最后一张卡开头对不上（给的是「' + lq + '」，实际「' + last + '」）' }
  return { ok: true }
}

/** 接地：问题的引用必须逐字出现在某张字幕卡或某段大字里。纯函数，可单测。 */
export function groundIssues({ issues, cards = [], sections = [] }) {
  const sources = [
    ...cards.map(c => ({ kind: 'caption', text: strip(c && c.text) })),
    ...sections.map(s => ({ kind: 'section', text: strip(((s && s.lines) || []).join('') || (s && s.text)) })),
  ]
  const kept = []
  const dropped = []
  for (const it of Array.isArray(issues) ? issues : []) {
    const kind = String((it && it.kind) || '').trim()
    const quote = strip(it && it.quote)
    if (!KINDS[kind]) { dropped.push({ quote, why: '类别不在四类里：' + (kind || '空') }); continue }
    if (!quote) { dropped.push({ quote: '', why: '没给原文片段，无法核实' }); continue }
    if ([...quote].length < 2) { dropped.push({ quote, why: '片段太短，无法定位' }); continue }
    const src = sources.find(s => s.text.includes(quote))
    if (!src) { dropped.push({ quote, why: '交付文本里没有这句（模型自己编的），不采信' }); continue }
    kept.push({
      kind, kindLabel: KINDS[kind],
      at: Number(it.at) || null,
      quote,
      to: it.to ? strip(it.to) : null,
      why: String(it.why || '').slice(0, 90),
      severity: 'block',
      groundedIn: src.kind,
    })
  }
  return { kept, dropped }
}

/**
 * 同音错字要过硬校验才允许判不通过。跨词、字数变了、拼音不一致，都只算「疑似」。
 */
export async function verifyHomophones({ issues = [], words = [], terms = { terms: [] }, validateFn = validateFixes, pinyin } = {}) {
  const out = []
  for (const it of issues) {
    if (it.kind !== 'homophone') { out.push(it); continue }
    const to = it.to ? strip(it.to) : ''
    if (!to) { out.push({ ...it, severity: 'warn', why: it.why + '（模型没给改法）' }); continue }
    if ([...to].length !== [...it.quote].length) {
      out.push({ ...it, severity: 'warn', why: '改法与原文片段字数不同，会撑破字幕卡，只记录' }); continue
    }
    const i = words.findIndex(w => strip(w.w) === it.quote)
    if (i < 0) { out.push({ ...it, severity: 'warn', why: '片段跨了多个词，逐词改会动断句，只报不改' }); continue }
    const v = await validateFn([{ i, to, kind: 'homophone', why: it.why }], words, { terms, pinyin })
    if (v.accepted && v.accepted.length) {
      out.push({ ...it, severity: 'block', fix: v.accepted[0], why: it.why + '（拼音 ' + (v.accepted[0].verified || '一致') + '）' })
    } else {
      const why = v.rejected && v.rejected[0] ? v.rejected[0].why : '校验器不认'
      out.push({ ...it, severity: 'warn', why: it.why + '（硬校验没过：' + why + '）' })
    }
  }
  return out
}

/** 把语义层结论折成一条质检项。纯函数：没跑、跑挂了、跑出问题，三种都判不通过。 */
export function judgeSemantic(semantic, { cards = 0 } = {}) {
  if (!semantic) return { ok: false, detail: '语义层没有跑，这一层没有证据，不当通过', evidence: {} }
  if (!semantic.ok) {
    return {
      ok: false,
      detail: '语义层没查成：' + (semantic.skipped || '未知原因') + (semantic.detail ? '（' + String(semantic.detail).slice(0, 120) + '）' : '') + '。数值层过了也不能算全过',
      evidence: { skipped: semantic.skipped || null },
    }
  }
  const issues = Array.isArray(semantic.issues) ? semantic.issues : []
  const blocks = issues.filter(i => i.severity === 'block')
  const warns = issues.filter(i => i.severity !== 'block')
  const n = Array.isArray(cards) ? cards.length : (Number(cards) || 0)
  const head = '模型读了 ' + n + ' 张字幕卡'
  if (blocks.length) {
    return {
      ok: false,
      detail: head + '，报出 ' + blocks.length + ' 处要拦的问题：' +
        blocks.slice(0, 3).map(i => i.kindLabel + '「' + i.quote + '」' + (i.to ? '→「' + i.to + '」' : '') + (i.at ? '@' + i.at + 's' : '')).join('、') +
        (blocks.length > 3 ? ' 等' : ''),
      evidence: { issues: blocks.slice(0, 6), warns: warns.slice(0, 4), model: semantic.model || null },
    }
  }
  return {
    ok: true,
    detail: head + '，没报问题' + (warns.length ? '；另有 ' + warns.length + ' 处疑似（已在报告里列出，不当作确定错误）' : ''),
    evidence: { warns: warns.slice(0, 6), model: semantic.model || null },
  }
}

/**
 * 一次语义审读。返回 {ok:true, issues, dropped, ...} 或 {ok:false, skipped}。
 * 判断合不合法由 groundIssues / verifyHomophones 负责，这里只负责把话说给模型。
 */
export async function reviewText({ words = [], captions = null, sections = [], brief = {}, terms = null, log = () => {}, model = LLM.models.fast } = {}) {
  const cards = (captions && captions.cards) || []
  if (!cards.length) return { ok: false, skipped: 'no-captions' }

  const cardList = cards.map((c, i) => ({ i: i + 1, t: +(Number(c.start) || 0).toFixed(2), 文字: strip(c.text) }))
  const secList = (sections || []).map(s => ({ index: s.index, t: +(Number(s.start) || 0).toFixed(2), 大字: strip(((s.lines || []).join('') || s.text)) }))

  const prompt = [
    '你在给一条已经出片的短视频做交付前审读。只看给的文字找问题，不要评论画面、不要重写文案。',
    '规格：' + [brief.platform, brief.duration ? brief.duration + 's' : null, brief.template].filter(Boolean).join(' / '),
    '',
    '字幕卡（编号 / 成片时间秒 / 文字）：',
    JSON.stringify(cardList, null, 1),
    '',
    '段落大字：',
    JSON.stringify(secList, null, 1),
    '',
    '只找这四类问题：',
    '1 kind=homophone 同音错字：to 给正确写法，字数必须与 quote 完全相同。',
    '2 kind=semantic 语句不通：说反、缺主语、整句崩、明显不是人话。',
    '3 kind=repeat 重复句：同一句话在片子里出现了两次。',
    '4 kind=offtopic 跑题/与规格不符：内容和用户要的口播对不上。',
    '',
    '硬要求：',
    '- 每条必须给 quote：从上面某一张字幕卡或某一段大字里逐字复制，一个字都不许改。',
    '- 没有问题时 issues 给空数组，不要为了凑数编问题；宁可漏也不要编。',
    '- checkedCaps 填你实际看到的字幕卡条数。',
    '- firstQuote 填第 1 张字幕卡的前 4 个字，lastQuote 填最后一张字幕卡的前 4 个字，逐字复制。',
    '',
    '只输出 JSON：{"checkedCaps":<条数>,"firstQuote":"前4字","lastQuote":"前4字","verdict":"ok"|"issues","issues":[{"kind":"homophone","at":12.3,"quote":"原文片段","to":"正确写法","why":"一句话"}]}',
  ].join('\n')

  const r = await chatJSON({ prompt, model, maxTokens: SEMANTIC.maxTokens, timeoutMs: SEMANTIC.timeoutMs })
  if (!r.ok) {
    log('语义审读：模型没接上（' + r.skipped + '）')
    return { ok: false, skipped: r.skipped, detail: r.detail || null, model: null }
  }

  // 只认条数不够：模型不读也能数出条数。还要它逐字报第一张和最后一张卡的开头，
  // 这两处只有真读完整个列表才答得对——这是「它到底看没看全」的实证。
  const seen = confirmsReading(r.value, cards)
  if (!seen.ok) {
    log('语义审读：读全性验证没过（' + seen.why + '），采信不了')
    return { ok: false, skipped: 'reading-unverified', detail: seen.why + '；模型返回：' + String(r.content || '').slice(0, 160), model: r.model }
  }

  const raw = Array.isArray(r.value && r.value.issues) ? r.value.issues.slice(0, SEMANTIC.maxIssues) : []
  const { kept, dropped } = groundIssues({ issues: raw, cards, sections })
  const verified = await verifyHomophones({ issues: kept, words, terms: terms || { terms: [] } })
  const blocks = verified.filter(i => i.severity === 'block')
  log('语义审读：模型报 ' + raw.length + ' 条，接地 ' + kept.length + ' 条，采信 ' + blocks.length + ' 条，丢弃 ' + dropped.length + ' 条')

  return {
    ok: true,
    verdict: blocks.length ? 'issues' : 'ok',
    issues: verified,
    dropped,
    model: r.model, ms: r.ms, tokens: r.tokens,
    stats: { reported: raw.length, grounded: kept.length, blocks: blocks.length, dropped: dropped.length },
  }
}
