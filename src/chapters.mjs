/**
 * 分章：把 ASR 的句子并成「一章一句话」。两个模板共用一套规则，跨模板一致。
 *
 * 两条规则，都很实际：
 *   1. 残句必须并走：不到 4 个字、或不到 1 秒的句子，单独成章会一闪而过（「这件事」这种）。
 *   2. 短句可以并，但不能并成长墙：并完超过 maxChars 就不并。
 *      这条以前没有，结果是 24 个字挤成三行大字，一句整话的观感全没了。
 *
 * 输出时间已经在成片时间轴上（调用方用 map() 转好）。
 */

export const CHAPTER_MAX = 20 // 一章大字上限：两行，再多就是三行墙
export const CHAPTER_FRAGMENT = 4 // 短于这个字数的句子是残句
const SHORT_SEC = 1.8 // 成片里短于这个秒数的章节算「短章」，可以并给邻居

export function mergeSentences(sentences, { maxChars = CHAPTER_MAX, fragment = CHAPTER_FRAGMENT, shortSec = SHORT_SEC } = {}) {
  const out = []
  for (const s of sentences) {
    const text = String(s.text || '')
    if (!text) continue
    const prev = out.at(-1)
    const isFragment = text.length < fragment || (s.end - s.start) < 1.0
    const fits = prev ? prev.text.length + text.length <= maxChars : false
    const shortGap = prev && shortSec > 0 && ((s.end - s.start) < shortSec || (prev.end - prev.start) < shortSec)
    if (prev && (isFragment || (fits && shortGap))) {
      prev.end = Math.max(prev.end, s.end)
      prev.text += text
    } else {
      out.push({ start: s.start, end: s.end, text })
    }
  }
  return out
}
