/** 把词级时间戳排成字幕卡：按语义长度断行，成片时间，无标点。 */
import { makeMapper } from './plan.mjs'
import { segment } from './segment.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu

// 口播里的连接词：字幕卡片别拿它收尾，一断就成了"半句话"
const CONNECTORS = ['但是', '所以', '因为', '然后', '而且', '不过', '就是', '其实', '如果', '只有', '或者', '还是', '可是', '于是', '另外', '这种', '这个', '现在', '今天', '就是']
const SENTENCE_END = /[。！？!?]$/

export function buildCaptions(allWords, plan, { maxChars = 14, maxLines = 2, maxGap = 0.55, sentenceGap = 0.25 } = {}) {
  const map = makeMapper(plan)

  // 被剪掉的词（删词、重复、口头语）不进字幕：音频里没有了，字幕上还挂着就成了「说了两遍」。
  // 判据是中点在某个保留区间里——用保留区间而不是切口，因为片头片尾被删的词不在任何切口里。
  const keep = (plan && plan.keep) || []
  const words = keep.length ? allWords.filter(w => {
    const mid = (w.start + w.end) / 2
    return keep.some(([a, b]) => mid >= a && mid <= b)
  }) : allWords

  // 1) 先切句：whisper 中文经常不带标点，标点不能当唯一依据——停顿（> sentenceGap）就是句子边界。
  //    以前不切句，字幕会攒到 14 字硬断：「我最近研究了一」/「圈真正的机会是在OPC结合内」这种
  //    跨句、断词的字幕（2026-11-23 真素材上被抓出来）。
  const groups = []
  let cur = []
  let lastEnd = null
  for (const w of words) {
    const gap = lastEnd === null ? 0 : w.start - lastEnd
    if (cur.length && (gap > sentenceGap || SENTENCE_END.test(String(cur.at(-1).w)))) { groups.push(cur); cur = [] }
    cur.push(w)
    lastEnd = w.end
    if (SENTENCE_END.test(String(w.w))) { groups.push(cur); cur = [] }
  }
  if (cur.length) groups.push(cur)

  const cards = []
  for (const g of groups) {
    // 逐字落点：大字按音节落下要用它；同时保证拼出来的文字和卡片文本逐字一致
    const chars = []
    for (const w of g) {
      const f0 = map(w.start)
      const f1 = Math.max(f0 + 0.04, map(w.end))
      const cs = [...String(w.w).replace(PUNCT, '')].filter(Boolean)
      const n = cs.length
      cs.forEach((ch, i) => chars.push({ ch, f0: +(f0 + (f1 - f0) * i / n).toFixed(3), f1: +(f0 + (f1 - f0) * (i + 1) / n).toFixed(3) }))
    }
    if (!chars.length) continue
    const text = chars.map(k => k.ch).join('')
    // 2) 句内断卡只落在词边界：掉字、断词都会让字幕读起来像乱码
    const bounds = wordBounds(text)
    let at = 0
    while (at < chars.length) {
      let end = Math.min(chars.length, at + maxChars)
      if (end < chars.length) {
        const cand = bounds.filter(b => b > at && b <= end).pop()
        if (cand && cand - at >= 3) end = cand
      }
      // 卡片不要以连接词收尾（"…技术但是我"这种断法读起来像断气）：把连接词推到下一张
      if (end < chars.length) {
        const seg0 = text.slice(at, end)
        // 末尾 4 个字里出现连接词就退到它前面（"…技术但是我" → "…技术" + "但是…"）
        const tail = Math.max(0, seg0.length - 4)
        let cut = 0
        for (const c of CONNECTORS) {
          const idx = seg0.lastIndexOf(c)
          if (idx >= 6 && idx >= tail && idx + c.length === seg0.length) { cut = Math.max(cut, seg0.length - idx) }
          else if (idx >= 6 && idx >= tail && seg0.length - (idx + c.length) <= 2) { cut = Math.max(cut, seg0.length - idx) }
        }
        if (cut && end - cut >= 6) end -= cut
      }
      const piece = chars.slice(at, end)
      const cardText = piece.map(k => k.ch).join('').trim()
      if (cardText) {
        cards.push({
          start: piece[0].f0,
          end: Math.max(piece[0].f0 + 0.35, piece.at(-1).f1),
          text: cardText,
          chars: piece,
        })
      }
      at = end
    }
  }

  // 太碎的卡（"一圈"、"人太少了"这种 2–3 字）并回上一张，只要不超长：一闪而过的字幕等于没有
  for (let i = cards.length - 1; i > 0; i--) {
    const c = cards[i], p = cards[i - 1]
    if (c.text.length < 4 && p.text.length + c.text.length <= 16) {
      p.text += c.text
      p.chars = p.chars.concat(c.chars)
      p.end = Math.max(p.end, c.end)
      cards.splice(i, 1)
    }
  }

  // 一个字都不许丢：与「留下的词」逐字核对（被剪掉的词本来就不该出现）
  const original = words.map(w => w.w).join('').replace(PUNCT, '')
  const shown = cards.map(c => c.text).join('')
  const missing = original.length - shown.length
  return { cards, coverage: { originalChars: original.length, shownChars: shown.length, missing } }
}

/** 词边界：ICU 分词 + 术语表补词（和断行同一套），返回字符下标。 */
function wordBounds(text) {
  const out = []
  let acc = 0
  for (const w of segment(text)) { acc += [...w].length; out.push(acc) }
  return out
}


const esc = s => s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')

export function toASS(cards, { width = 1080, height = 1920, fontSize = 64, marginBottom = 220, font = 'Microsoft YaHei' } = {}) {
  const head = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${font},${fontSize},&H00F4F4F0,&H0000FF5A,&H00101011,&H80000000,-1,0,0,0,100,100,0,0,1,4,0,2,80,80,${marginBottom},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`
  const lines = cards.map(c => `Dialogue: 0,${tsASS(c.start)},${tsASS(c.end)},Default,,0,0,0,,${esc(c.text)}`)
  return head + '\n' + lines.join('\n') + '\n'
}

export function toSRT(cards) {
  return cards.map((c, i) => `${i + 1}\n${ts(c.start, ',')} --> ${ts(c.end, ',')}\n${c.text}\n`).join('\n')
}

/** ASS 只吃两位小数（厘秒）；三位会被 libass 解析错，字幕会一直挂在屏幕上。 */
function tsASS(t) {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), s = Math.floor(cs % 6000 / 100), r = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(2, '0')}`
}

function ts(t, sep = '.') {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000), r = ms % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${sep}${String(r).padStart(3, '0')}`
}