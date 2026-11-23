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

// ───────── 段落（section）：观众眼里的一段话，几个句子 ─────────
//
// 以前一章 = 一句，68 秒的片子被切成 22 章，平均 3.1 秒换一次大字：
// 那不是章节，那是字幕在抖。用户 2026-11-23 明确否掉了这版。
//
// 段落是「几秒之内讲同一件事」，规则同样只用时间戳，不猜语义：
//   1. 够长了（>= targetSec）且中间有停顿（>= gap）才断，断句只落在句子边界；
//   2. 一段不超过 maxSec，也不超过 maxChars 字（再长就不是一段话，是一堵墙）；
//   3. 尾巴太短并进上一段——6 秒的收尾段单独一段，观感是「多出来一章」。
export const SECTION = { minSec: 4, targetSec: 11, maxSec: 16, maxChars: 36, gap: 0.22 }

export function mergeSections(sentences, { minSec = SECTION.minSec, targetSec = SECTION.targetSec, maxSec = SECTION.maxSec, maxChars = SECTION.maxChars, gap = SECTION.gap } = {}) {
  const out = []
  let cur = null
  for (const s of sentences) {
    const text = String(s.text || '')
    if (!text) continue
    if (!cur) { cur = { start: s.start, end: s.end, sentences: [s] }; continue }
    const curLen = cur.end - cur.start
    const gapLen = s.start - cur.end
    const chars = cur.sentences.reduce((n, x) => n + String(x.text).length, 0) + text.length
    const wouldLen = Math.max(cur.end, s.end) - cur.start
    const breakHere = (curLen >= targetSec && gapLen >= gap) || wouldLen > maxSec || (curLen >= minSec && chars > maxChars)
    if (breakHere) { out.push(cur); cur = { start: s.start, end: s.end, sentences: [s] } }
    else { cur.end = Math.max(cur.end, s.end); cur.sentences.push(s) }
  }
  if (cur) out.push(cur)

  // 任何一段短于 minSec 都是「多出来的一章」：并给邻居（先并前一段，并不下再并后一段）。
  // 尾巴 2.3 秒单独成一段，质检会按 section_pace 判不过——这条规则就是为了不让它出现在成片里。
  const mergeInto = (i, j) => {
    const a = out[Math.min(i, j)], b = out[Math.max(i, j)]
    a.start = Math.min(a.start, b.start)
    a.end = Math.max(a.end, b.end)
    a.sentences = [...a.sentences, ...b.sentences].sort((x, y) => x.start - y.start)
    out.splice(Math.max(i, j), 1)
  }
  let guard = 0
  while (out.length > 1 && guard++ < 40) {
    const i = out.findIndex(s => s.end - s.start < minSec)
    if (i < 0) break
    const prevOk = i > 0 && Math.max(out[i].end, out[i - 1].end) - out[i - 1].start <= maxSec + 3
    const nextOk = i < out.length - 1 && Math.max(out[i].end, out[i + 1].end) - out[i].start <= maxSec + 3
    if (prevOk) mergeInto(i, i - 1)
    else if (nextOk) mergeInto(i, i + 1)
    else if (out.length > 1) mergeInto(i, i > 0 ? i - 1 : i + 1)
    else break
  }

  return out.map((s, i) => ({ index: i + 1, start: s.start, end: s.end, text: pickTitle(s.sentences), lines: s.sentences.map(x => x.text) }))
}

/**
 * 一段一句大字。不写新文案（那是改写），只从这一段里挑一句原话：
 * 6–12 字优先（上屏是「一句钉子」），其次 4 字以上最短的，实在都不短就取最长的。
 */
export function pickTitle(sentences) {
  const texts = sentences.map(s => String(s.text || '')).filter(Boolean)
  if (!texts.length) return ''
  // 这一段第一句本身就是短钉子时就用它：大字和说出口的第一句同步，观感才不飘
  const head = texts[0]
  if (head.length >= 6 && head.length <= 12) return head
  const mid = texts.filter(t => t.length >= 6 && t.length <= 12)
  if (mid.length) return mid.slice().sort((a, b) => a.length - b.length)[0]
  const short = texts.filter(t => t.length >= 4)
  if (short.length) return short.slice().sort((a, b) => a.length - b.length)[0]
  return texts.slice().sort((a, b) => b.length - a.length)[0]
}
