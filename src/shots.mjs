/**
 * 分镜：这一段用哪种版式、章节名叫什么、要不要加图形块 —— 剪辑 bot 提案，规则校验定生死。
 *
 * 为什么要有这一层：光轨/折光这类逐帧模板的「设计感」不在渲染，在于「哪几秒让位给字、
 * 哪几秒把画面收小、哪句话值得变成全屏色卡」。这件事按时间硬切会假，按字数规则会碎，
 * 只有读过这一页原话才做得对——所以交给模型提案，但每条都必须过确定性校验：
 *   · 章节名 / 小字眉 / 强调词 / 图形块文字，必须是本页原话里连续出现的一段（不许改写、不许编数字）；
 *   · 版式要真能用：全屏色卡得页里真有一句 6 字以内的金句，竖框得真有一段列举；
 *   · 全片有配额：card ≤ 2、frame ≤ 1、corner ≤ 3，超了就退回满幅并记账。
 * 模型挂了或全不合格，就退回确定性兜底（页标题摘句、版式按内容规则挑），片子照出。
 */
import { chatJSON, LLM } from './llm.mjs'
import { checkPageTitle, pickPageTitle, pickEyebrow, bare } from './pages.mjs'
import { segment } from './segment.mjs'

export const SHOT_KINDS = ['full', 'frame', 'corner', 'card']
export const BLOCK_KINDS = ['none', 'tagwall', 'check', 'banner', 'gauge']
export const QUOTA = { card: 2, frame: 1, corner: 3 }
export const SHOT_LABEL = { full: '满幅', frame: '竖框居中', corner: '右上小窗', card: '全屏字卡' }

const PUNCT_END = /[，。！？、；：]/
const cleanShort = (t, max) => {
  const n = bare(t).length
  return n >= 2 && n <= max && !PUNCT_END.test(t)
}
const numsIn = s => String(s || '').match(/\d+/g) || []
/** 原话里没有的数字，一个字都不许出现（图形块尤其容易编出「提升 300%」） */
const groundedNumbers = (s, pageText) => {
  const pool = new Set(numsIn(pageText))
  return numsIn(s).every(d => pool.has(d))
}
const inside = (s, pageText) => Boolean(s) && String(pageText || '').includes(String(s))

/** 强调词必须落在词的边界上：模型给过「一周的工」，把词切了一半 */
function onWordBoundary(text, pageText) {
  const src = bare(pageText)
  const t = bare(text)
  let at = src.indexOf(t)
  if (at < 0) return false
  const words = segment(t)
  return words.join('') === t
}

/** 这一段里能不能真的用竖框：得有一串短句连着说（在列举） */
function hasList(page) {
  const cards = page.cards || []
  let run = 0
  let start = null
  for (const c of cards) {
    if (cleanShort(c.text, 10)) {
      if (run === 0) start = c
      run++
      if (run >= 2 && c.f1 - start.f0 >= 2.4) return { ok: true, from: start.f0 - 0.3, to: c.f1 + 0.6, count: run }
    } else { run = 0; start = null }
  }
  return { ok: false }
}

/** 这一段里有没有一句够短的金句可以做成全屏色卡 */
function hasGoldLine(page) {
  const c = (page.cards || []).find(x => cleanShort(x.text, 6) && x.f1 - x.f0 >= 0.9)
  return c ? { ok: true, from: c.f0, to: c.f1 + 0.9, text: c.text } : { ok: false }
}

/**
 * 校验提案。纯函数：不给模型、不给网络，只吃提案和页骨架，返回「能落地的分镜 + 打回原因」。
 * 任何一项不合规都不许静默：要么退回兜底值，要么整条丢掉并写进 problems。
 */
export function validateProposal({ pages, proposal }) {
  const problems = []
  const byIndex = new Map()
  for (const p of (proposal && proposal.pages) || []) {
    const i = Number(p && p.index)
    if (Number.isInteger(i)) byIndex.set(i, p)
  }
  const counts = { card: 0, frame: 0, corner: 0 }
  const out = pages.map(page => {
    const raw = byIndex.get(page.index) || {}
    const title = checkPageTitle(raw.title, page.text)
    if (raw.title && !title.ok) problems.push('第 ' + page.index + ' 页标题「' + raw.title + '」：' + title.why)

    const eyebrowRaw = bare(raw.eyebrow).slice(0, 4)
    const eyebrowOk = eyebrowRaw.length >= 2 && inside(eyebrowRaw, page.text) && eyebrowRaw !== bare(title.ok ? raw.title : '')
    if (raw.eyebrow && !eyebrowOk) problems.push('第 ' + page.index + ' 页小字眉「' + raw.eyebrow + '」不是本页原话')

    const emphRaw = bare(raw.emph).slice(0, 4)
    const emphOk = emphRaw.length >= 2 && inside(emphRaw, page.text) && onWordBoundary(emphRaw, page.text)
    if (raw.emph && !emphOk) problems.push('第 ' + page.index + ' 页强调词「' + raw.emph + '」不是本页原话')

    // 版式：先在「能不能用」上打回，再在配额上打回
    let shot = SHOT_KINDS.includes(raw.shot) ? raw.shot : 'full'
    if (raw.shot && !SHOT_KINDS.includes(raw.shot)) problems.push('第 ' + page.index + ' 页版式「' + raw.shot + '」不认识')
    if (shot === 'card') {
      const asked = bare(raw.cardText || '')
      const c = (page.cards || []).find(x => asked && bare(x.text) === asked && cleanShort(x.text, 8))
      if (!c) {
        problems.push('第 ' + page.index + ' 页想用全屏色卡，但没引用一句本页 6 字以内的原话（cardText）')
        shot = 'full'
      } else raw.cardText = asked
    }
    if (shot === 'frame') {
      const l = hasList(page)
      if (!l.ok) { problems.push('第 ' + page.index + ' 页想用竖框，但这一段没有连续短句在列举'); shot = 'full' }
    }
    if (shot !== 'full') {
      if (counts[shot] >= QUOTA[shot]) {
        problems.push('第 ' + page.index + ' 页想用「' + SHOT_LABEL[shot] + '」，全片配额已满')
        shot = 'full'
      } else counts[shot]++
    }

    // 图形块：只收和这一段真对得上的
    let block = null
    const b = raw.block || {}
    const kind = BLOCK_KINDS.includes(b.kind) ? b.kind : 'none'
    if (kind !== 'none') {
      if (kind === 'tagwall') {
        const items = [...new Set((Array.isArray(b.items) ? b.items : []).map(x => bare(x).slice(0, 6)).filter(x => x.length >= 2))]
          .filter(x => inside(x, page.text) && groundedNumbers(x, page.text))
        if (items.length < 3) problems.push('第 ' + page.index + ' 页标签墙只有 ' + items.length + ' 个词能用（要 3 个以上、且都在原话里）')
        else if (shot !== 'frame' && shot !== 'corner') problems.push('第 ' + page.index + ' 页标签墙只能配竖框/小窗（满幅会压在脸上）')
        else block = { kind: 'tagwall', items: items.slice(0, 8) }
      } else if (kind === 'check') {
        const text = bare(b.text).slice(0, 14)
        if (text.length < 2 || !inside(text, page.text)) problems.push('第 ' + page.index + ' 页对勾卡「' + b.text + '」不是本页原话')
        else if (shot === 'card') problems.push('第 ' + page.index + ' 页对勾卡不能和全屏色卡同时用')
        else block = { kind: 'check', text }
      } else if (kind === 'banner') {
        const text = bare(b.text).slice(0, 10)
        if (text.length < 2 || !inside(text, page.text)) problems.push('第 ' + page.index + ' 页红条「' + b.text + '」不是本页原话')
        else if (shot !== 'full') problems.push('第 ' + page.index + ' 页红条只在满幅上用')
        else block = { kind: 'banner', text }
      } else if (kind === 'gauge') {
        if (!/门槛|越来越|越来越难/.test(page.text)) problems.push('第 ' + page.index + ' 页刻度卡：这一段没在说门槛')
        else block = { kind: 'gauge', label: '门槛' }
      }
    }

    return {
      index: page.index,
      title: title.ok ? String(raw.title) : page.title,
      eyebrow: eyebrowOk ? eyebrowRaw : page.eyebrow,
      emph: emphOk ? emphRaw : '',
      shot,
      block,
      cardText: shot === 'card' ? bare(raw.cardText || '') : '',
      source: title.ok || eyebrowOk || shot !== 'full' || block ? 'model' : 'rules',
      why: typeof raw.why === 'string' ? raw.why.slice(0, 80) : '',
    }
  })
  return { pages: out, problems, counts }
}

const PROMPT = (input) => [
  '你在给一条竖屏口播视频做分镜，节奏参考「折光」：每几秒换一次构图，字的密度高，但只有金句才占满屏。',
  '给你若干页，每页是那几秒里说过的原话（已经剪好的成片文本）。为每页决定：',
  '',
  '1) title 章节名：3–8 个汉字。必须是这一页原话里连续出现的一段，不许改写、不许缩写、不许用别的页的字。',
  '   不要以「的、了、是、在、就、都、也、这、那」这类字开头，也不要收在「给、做、说、越、如果」这种半句话上。',
  '2) eyebrow 小字眉：2–4 个汉字，同样取自这一页原话（挑一个实词，比如「门槛」「机会」）。',
  '3) shot 版式：',
  '   full   满幅（默认：人在说话）',
  '   corner 右上小窗，画面让给字（交代背景、转折、要强调一段话时）',
  '   frame  竖框居中，人物收窄（只有一段里连着列好几样东西时才用）',
  '   card   全屏色卡（只有一句 6 字以内的金句或反问时才用；全片最多 2 次）。用 card 必须给 cardText，',
  '          照抄该页「卡片」里那一句的原话；给不出 cardText 就别用 card。',
  '4) emph 强调词：2–4 个字，这一页最值得上色（黄 / 荧光绿 / 红底）的那个词，必须原话里有。',
  '5) block 图形块（可选，只在内容和它天然对得上时才给，不要为了热闹硬加）：',
  '   tagwall 标签墙：把这一段说到的 3–8 个同类名词列成标签，每个 2–6 字，必须都在本页原话里；只能配 frame / corner',
  '   check   对勾卡：说「你能得到 / 你想要的」时，给一句 2–14 字的交付物，必须是原话',
  '   banner  红条打叉：说「别再看 / 不要 / 别再」这类否定时，给 2–10 字',
  '   gauge   刻度卡：说门槛越来越低 / 越来越难时（卡上不写数字）',
  '   none    不加',
  '',
  '硬规矩：任何地方都不许写原话里没有的数字、品牌名、人名、结论。整体配额：card ≤ 2、frame ≤ 1、corner 2–3，其余 full。',
  '',
  '页（index / 起始秒 / 原文）：',
  JSON.stringify(input, null, 1),
  '',
  '只输出 JSON：{"pages":[{"index":1,"title":"...","eyebrow":"...","shot":"full","cardText":"","emph":"...","block":{"kind":"none","items":[],"text":""}}]}',
].join('\n')

/**
 * 给每一页要一个分镜。返回的 pages 一定和传入的页等长、index 一一对应。
 * 模型没接上 / 全不合格 → 确定性兜底（页骨架自带 title/eyebrow，版式回落 full）。
 */
export async function planPages({ pages, log = () => {} } = {}) {
  const list = (Array.isArray(pages) ? pages : []).filter(p => p && bare(p.text))
  const fallback = list.map(p => ({ index: p.index, title: p.title, eyebrow: p.eyebrow, emph: '', shot: 'full', block: null, source: 'rules', why: '' }))
  if (!list.length) return { ok: false, skipped: 'no-pages', pages: [] }
  const input = list.map(p => ({
    index: p.index, 起始: p.start, 原文: bare(p.text),
    卡片: (p.cards || []).map(c => bare(c.text)).filter(t => t.length <= 12),
  }))
  const r = await chatJSON({ prompt: PROMPT(input), maxTokens: 2200, model: LLM.models.fast })
  if (!r.ok) {
    log('分镜：模型没接上（' + r.skipped + '），按内容规则排版')
    return { ok: false, skipped: r.skipped, pages: fallback, problems: [], model: null }
  }
  const v = validateProposal({ pages: list, proposal: r.value })
  const adopted = v.pages.filter(p => p.source === 'model').length
  const blocks = v.pages.filter(p => p.block).length
  log('分镜：' + list.length + ' 页，模型采纳 ' + adopted + ' 页；版式 ' +
    Object.entries(v.counts).filter(([, n]) => n).map(([k, n]) => SHOT_LABEL[k] + ' ' + n).join(' / ') +
    (blocks ? '；图形块 ' + blocks + ' 个' : '') +
    (v.problems.length ? '；打回 ' + v.problems.length + ' 条（' + v.problems.slice(0, 2).join('；') + '）' : ''))
  return { ok: true, model: r.model, ms: r.ms, tokens: r.tokens, pages: v.pages, problems: v.problems, counts: v.counts }
}
