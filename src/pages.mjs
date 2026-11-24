/**
 * 页骨架：段落 → 8 页左右，每页带原话、卡片、页码。
 * 分镜（src/shots.mjs）和画布模板（templates/zheguang/scene.mjs）共用这一份，
 * 谁都不许自己再切一套——两套页边界一切，章节卡和版式就会错位。
 */
import { sectionsOf } from './sections.mjs'
import { segment } from './segment.mjs'
import { insideSentence, contiguous } from './headlines.mjs'

const round = (n, k = 3) => Number(n.toFixed(k))
const PUNCT = /[\s，。！？、；：,.!?;:""''…—~·\-]/g
export const bare = s => String(s || '').replace(PUNCT, '')

/** 不能起头的虚词：原话摘句时把它们顶在句首，读起来像半句话 */
export const BAD_START = /^[的了是在和就都也才把给对从但而很太更不没有着过吧呢吗啊嘛去来出要会能说看用做你我他她它们这那就]/
/** 不能收尾的字 */
export const BAD_END = /[的了是在和就都也才把给对从但而很太更不没有着过吧呢吗啊嘛去来出要会能说看用做你我他她它们这那越]$/
/** 不能收尾的整词 */
export const BAD_END_WORD = /(如果|因为|所以|但是|就是|还是|只有|虽然|然后|而且|认为|觉得|这些|那些|什么|怎么|时候|一下|一样|这种|那种)$/

/** 没有信息量的词：算「标题里有多少实词」时不计 */
export const STOP = new Set(['这个', '那个', '就是', '但是', '所以', '因为', '如果', '我们', '你们', '他们', '今天',
  '现在', '其实', '一个', '没有', '可以', '知道', '大家', '什么', '怎么', '时候', '东西', '事情', '这里', '那里',
  '这样', '那样', '一下', '一点', '还是', '然后', '而且', '只是', '这些', '那些', '都能', '做出', '看到', '只有',
  '这种', '那种', '是不是', '一句话'])

/** 一条标题能不能挂在页上：3–10 字、连续取自本页原话、不虚词起头收尾。纯函数。 */
export function checkPageTitle(text, source) {
  const t = String(text || '')
  const n = bare(t).length
  if (!n) return { ok: false, why: '空标题' }
  if (n < 3) return { ok: false, why: '少于 3 字' }
  // 8 个字是当初按纯中文估的；带 OPC / AI 这类西文词的标题（「真正的机会在OPC」）
  // 数字数会被算成 10，但它只占 7 个字宽，54px 章节名在 1080 宽里放得下。
  if (n > 10) return { ok: false, why: '超过 10 字' }
  if (!insideSentence(t, source)) return { ok: false, why: '有本页原话里没有的字' }
  // 章节名同理：只查字袋子会放过「从中间抽掉一个的」这种掐断的标题
  if (!contiguous(t, source)) return { ok: false, why: '不是本页原话里连续的一段' }
  if (BAD_START.test(t)) return { ok: false, why: '虚词起头，像半句话' }
  if (BAD_END.test(t) || BAD_END_WORD.test(t)) return { ok: false, why: '结尾是半句话' }
  return { ok: true, chars: n }
}

/**
 * 确定性兜底：在页原话上按词滑窗口，挑一段能当标题的 3–10 字。
 * 返回的一定是原话里连续的一段，不缩写、不改写。
 */
export function pickPageTitle(source) {
  const ws = segment(bare(source))
  let best = ''
  let bestScore = -1
  for (let i = 0; i < ws.length; i++) {
    let acc = ''
    for (let j = i; j < ws.length; j++) {
      acc += ws[j]
      const n = bare(acc).length
      if (n > 10) break
      if (n < 3) continue
      if (BAD_START.test(acc) || BAD_END.test(acc) || BAD_END_WORD.test(acc)) continue
      const content = ws.slice(i, j + 1).filter(w => !STOP.has(w) && bare(w).length >= 2).length
      const score = content * 2.2 + n * 0.5 - i * 0.05
      if (score > bestScore) { bestScore = score; best = acc }
    }
  }
  return best
}

/** 小字眉：2–4 字的实词，必须取自本页；挑不到就返回空（空着比挂个半个英文单词强） */
export function pickEyebrow(source, hotwords = []) {
  const ws = segment(bare(source)).filter(w => bare(w).length >= 2 && bare(w).length <= 4 && !STOP.has(w))
  const hit = ws.find(w => hotwords.includes(bare(w)))
  return hit ? bare(hit) : ''
}

/** 段落并在 N 页：每次把最短的一页并进更短的邻居，时间顺序不动 */
export function mergeToPages(sections, target) {
  let list = sections.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, text: s.text, first: i, last: i }))
  while (list.length > target) {
    let at = 0
    for (let i = 1; i < list.length; i++) if (list[i].end - list[i].start < list[at].end - list[at].start) at = i
    const j = at === list.length - 1 ? at - 1 : at + 1
    const a = Math.min(at, j), b = Math.max(at, j)
    const merged = { index: 0, start: list[a].start, end: list[b].end, text: list[a].text + list[b].text, first: list[a].first, last: list[b].last }
    list = [...list.slice(0, a), merged, ...list.slice(b + 1)]
  }
  return list.map((p, i) => ({ ...p, index: i + 1, total: list.length }))
}

/**
 * 页骨架。pages 的 index/时间/原话/卡片是「事实」，title/eyebrow 是「确定性兜底」，
 * 模型提案（src/shots.mjs）可以覆盖 title/eyebrow，但覆盖物也要过同一套校验。
 */
export function pageSkeleton({ segments, plan, cards = [], duration, count = null, hotwords = [] }) {
  const target = count || Math.max(3, Math.min(8, Math.round(duration / 8.6)))
  const sections = sectionsOf({ segments, plan })
  const pages = mergeToPages(sections.length ? sections : [{ start: 0, end: duration, text: '' }], target)
  const beats = cards.map(c => ({ text: c.text, f0: round(c.start), f1: round(Math.max(c.start + 0.35, c.end)) }))
  return pages.map(p => {
    const idx = beats.map((b, i) => (b.f0 >= p.start - 0.35 && b.f0 < p.end - 0.05 ? i : -1)).filter(i => i >= 0)
    const text = idx.length ? idx.map(i => beats[i].text).join('') : p.text
    return {
      index: p.index,
      total: p.total,
      start: round(p.start),
      end: round(p.end),
      text,
      cards: idx.map(i => ({ i, ...beats[i] })),
      title: pickPageTitle(text),
      eyebrow: pickEyebrow(text, hotwords),
      kind: p.index === 1 ? 'hook' : p.index === p.total ? 'outro' : 'body',
    }
  })
}
