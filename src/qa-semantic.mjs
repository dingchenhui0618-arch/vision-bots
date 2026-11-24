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
import { relistenSentence, strip as stripAll } from './relisten.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/g
const strip = s => String(s || '').replace(PUNCT, '')

export const KINDS = { homophone: '同音错字', semantic: '语句不通', repeat: '重复句', offtopic: '跑题' }
// 输出预算按 26 张卡实测调过：1400 会在 JSON 中间被截断（reading-unverified），
// 截断的语义审读等于没查，只能判不通过。宁可多花几百 token，也别让它半句话收工。
export const SEMANTIC = { maxIssues: 8, maxTokens: 2600, timeoutMs: 90000 }

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


/**
 * 听音复核仲裁：语义审读提的改法，到底是不是「我们写错了」？
 *
 * 语义层只会读文字。它看到「知道会做的人太少了」觉得别扭，就建议改成「怎么知道会做」——
 * 可音频里根本没有「怎么」（实测 42.60–42.88s 只有 0.28s 语音，后面 0.45s 是静音；
 * 强耳朵 medium 与弱耳朵 small 紧窗重听都没听出「怎么」）。
 * 这种建议要是能挡住交付，等于让模型的语感凌驾于素材事实之上。
 *
 * 判据只有一条，而且是对**建议**的，不是对我们的字幕的：
 *   **它建议的那几个字，在音频里听得到吗？**
 *   · 听得到（音频里确实有 to）→ 这条是真错，保留拦截，并把音频原文写进报告；
 *   · 听不到，但音频与我们的字幕逐字一致 → 字幕没错，是说话人自己这么说的，降级成「疑似」；
 *   · 听不到，音频又不是我们的字幕 → 建议在素材里没有依据，同样降级成「疑似」，因为
 *     我们只能照着素材写，不能照着模型的语感改（这条错要么是吞字——归纠错层管，要么是相安无事）；
 *   · 没听成（没有可用耳朵 / 解码失败）→ 原样保留，绝不因为「没证据」就放行。
 */
/** 引用在词表里的**最小**覆盖区间（不往前/后扩，和听音复核的比对口径一致）。
 *  用扩过的短语去比对，边界差一个字就会判成「音频与字幕不一致」（实测「都是在做」的收尾字）。 */
export function tightRange(words, quote) {
  const q = strip(quote)
  if (!q) return null
  let s = ''
  const owner = []
  for (let i = 0; i < words.length; i++) for (const ch of stripAll(words[i].w)) { s += ch; owner.push(i) }
  const at = s.indexOf(q)
  if (at < 0) return null
  const a = owner[at]
  const b = owner[at + q.length - 1]
  if (a === undefined || b === undefined) return null
  return { a, b, text: s.slice(at, at + q.length) }
}

export async function adjudicateByAudio({ issues = [], words = [], media = null, relistenDir = null, log = () => {}, cap = 2 } = {}) {
  const target = issues.filter(i => i.severity === 'block')
  if (!media || !words.length || !target.length) return issues
  const out = []
  let used = 0
  for (const it of issues) {
    if (it.severity !== 'block' || !it.quote || used >= cap) { out.push(it); continue }
    // 「语句不通」但没给具体改法 = 一条意见，不是一条错误：即兴口播本来就常有不完整的句子，
    // 实测同一部片子连跑四轮，四轮报的是四句不同的「语句不通」，每条都没给改法。
    // 要拦，得拿出能核对的东西：给得出改法（而且改法得在音频里听得到），或者音频与字幕真的不一致。
    if (it.kind === 'semantic' && !it.to) {
      out.push({ ...it, severity: 'warn', why: it.why + '（没给具体改法，无法核对，只记录）' })
      continue
    }
    // 「建议」和原文一字不差 = 它其实没提出改动（实测模型会这样交差：quote 和 to 完全相同）。
    // 这种不算问题，也不值得为它去听一遍音频。
    if (it.to && strip(it.to) === strip(it.quote)) {
      out.push({ ...it, severity: 'warn', why: it.why + '（建议的写法和原文一字不差，等于没改，只记录）' })
      continue
    }
    const hit = tightRange(words, it.quote)
    if (!hit) { out.push({ ...it, why: it.why + '（听音复核定位不到这句，没验）' }); continue }
    // 比对口径 = 引用本身（不扩），这样「都在做」的收尾字不会被算成不一致
    const r = await relistenSentence({ media, span: [words[hit.a].start, words[hit.b].end], cacheDir: relistenDir, expect: hit.text, log })
    used++
    if (!r.ok || !r.agree) {
      out.push({ ...it, why: it.why + '（听音复核没跑成：' + (r.skipped || '两次听不一致') + '，这条按原样保留）', audioReview: { ok: false, skipped: r.skipped || 'disagree' } })
      continue
    }
    const cur = hit.text
    const want = strip(it.to || '')
    const ear = r.tier === 'strong' ? '强耳朵 ' + r.model : '弱耳朵 ' + r.model + ' 紧窗重听'
    const base = { ok: true, agree: true, text: r.text, mine: cur, tier: r.tier, single: Boolean(r.single), model: r.model, decodes: r.decodes, note: r.note || null }
    // 只有强耳朵能改变结论。弱耳朵就是犯错的那个模型（实测它把「知道」读成「直到」），
    // 它说「没听到」不能证明建议是错的，只能当线索记着——否则这条规则会变成给错字开绿灯。
    if (r.tier !== 'strong') {
      out.push({
        ...it,
        why: it.why + '（听音复核只有弱耳朵可用：' + ear + ' 听到「' + r.text + '」，这一档不能定案，这条按原样保留）',
        audioReview: { ...base, heard: null, decided: false },
      })
      continue
    }
    if (want && r.text.includes(want)) {
      log('听音复核仲裁：音频里确实有「' + want + '」（' + ear + '）—— 这条是真错，保留拦截')
      out.push({ ...it, why: it.why + '（听音复核：音频里确实有「' + want + '」，字幕写成了「' + cur + '」）', audioReview: { ...base, heard: true } })
      continue
    }
    const same = r.text === cur
    if (!same) {
      // 音频与字幕不是同一句话：这里有出入，不管模型的建议对不对，都不能放行。
      // 放行只在「音频逐字等于字幕」时成立——那时字幕就是说话人的原话。
      log('听音复核仲裁：音频是「' + r.text + '」、字幕是「' + cur + '」，确有出入 —— 保留拦截')
      out.push({
        ...it,
        why: it.why + '（听音复核：音频是「' + r.text + '」，与字幕「' + cur + '」不一致；建议的「' + (want || '改法') +
          '」也没出现在音频里，这一步要更强模型或人来定案）',
        audioReview: { ...base, heard: false, contradicted: false },
      })
      continue
    }
    log('听音复核仲裁：音频与字幕逐字一致，建议的「' + (want || '（没给改法）') + '」在音频里听不到（' + ear + '）—— 降级为疑似')
    out.push({
      ...it,
      severity: 'warn',
      why: it.why + '（听音复核：音频里就是「' + cur + '」，字幕没错；建议的「' + (want || '改法') +
        '」在音频里听不到，不能凭语感改素材里没有的话）',
      audioReview: { ...base, heard: false, contradicted: true },
    })
  }
  return out
}

/** 在词表里找包含 quote 的一段短语（不跨长停顿），用来交给听音复核。纯函数，可单测。 */
export function phraseAround(words, quote, { maxSpan = 14, maxGap = 0.35 } = {}) {
  const q = strip(quote)
  if (!q) return null
  for (let i = 0; i < words.length; i++) {
    let text = ''
    for (let j = i; j < Math.min(words.length, i + maxSpan); j++) {
      text += stripAll(words[j].w)
      if (text.includes(q)) {
        let a = i
        let b = j
        while (a > 0 && b - a < maxSpan - 1 && (words[a].start - words[a - 1].end) < maxGap) a--
        while (b < words.length - 1 && b - a < maxSpan - 1 && (words[b + 1].start - words[b].end) < maxGap) b++
        return { a, b, text: words.slice(a, b + 1).map(w => stripAll(w.w)).join('') }
      }
      if (text.length > q.length + 12) break
    }
  }
  return null
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
export async function reviewText({ words = [], captions = null, sections = [], brief = {}, terms = null, log = () => {}, model = LLM.models.fast, media = null, relistenDir = null } = {}) {
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

  const r = await chatJSON({ prompt, model, maxTokens: SEMANTIC.maxTokens, timeoutMs: SEMANTIC.timeoutMs, temperature: 0 })
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
  let verified = await verifyHomophones({ issues: kept, words, terms: terms || { terms: [] } })
  // 要拦的问题先拿音频对一次：语感不能凌驾于素材事实（详见 adjudicateByAudio 的注释）
  verified = await adjudicateByAudio({ issues: verified, words, media, relistenDir, log })
  const blocks = verified.filter(i => i.severity === 'block')
  log('语义审读：报了 ' + raw.length + ' 处，站得住 ' + kept.length + ' 处，采信 ' + blocks.length + ' 处' + (dropped.length ? '，另有 ' + dropped.length + ' 处引用对不上原文被退回' : ''))

  return {
    ok: true,
    verdict: blocks.length ? 'issues' : 'ok',
    issues: verified,
    dropped,
    model: r.model, ms: r.ms, tokens: r.tokens,
    stats: { reported: raw.length, grounded: kept.length, blocks: blocks.length, dropped: dropped.length },
  }
}
