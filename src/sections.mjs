/**
 * 段落（大字区间）推导：剪辑要给段落起标题，包装要把标题画到画面上，
 * 两边必须算出同一批段落——索引错一位，大字就挂到别的段落上去了。
 * 所以推导只有这一份，剪辑和 scene 都调它。
 */
import { makeMapper } from './plan.mjs'
import { mergeSections } from './chapters.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu

/** 句子（成片时间轴）：whisper 的 segment 映射到成片时间，标点剥掉 */
export function sentencesOf({ segments, plan }) {
  const map = makeMapper(plan)
  return (segments || [])
    .map(s => ({ start: map(s.start), end: Math.max(map(s.start) + 1.0, map(s.end)), text: String(s.text || '').replace(PUNCT, '') }))
    .filter(s => s.text && s.end > s.start)
}

/** 段落：几秒一段，一段一句大字 */
export function sectionsOf({ segments, plan }) {
  return mergeSections(sentencesOf({ segments, plan }))
}

/**
 * 把校验过的标题贴回段落。模型给的标题是提案，没通过 checkTitle 的
 * 在 section-titles.mjs 里就已经标 ok:false，这里只认 ok 的。
 */
export function applyTitles(sections, titles) {
  const list = Array.isArray(titles) ? titles : []
  if (!list.length) return { sections, applied: 0 }
  // 契约：只有 ok === true 的标题才上屏。section-titles.mjs 的 validateBatch 负责标 ok，
  // 这里不再猜——上一次按 source 猜，模型给的 10 条标题一条都没上屏，画面上全退回原句。
  const by = new Map(list.filter(t => t && t.ok === true).map(t => [Number(t.index), String(t.text || '').trim()]))
  let applied = 0
  const out = sections.map(s => {
    const t = by.get(s.index)
    if (!t) return s
    applied++
    return { ...s, text: t, titleSource: 'model' }
  })
  return { sections: out, applied }
}
