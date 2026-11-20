/** 把词级时间戳排成字幕卡：按语义长度断行，成片时间，无标点。 */
import { makeMapper } from './plan.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
const SENTENCE_END = /[。！？!?]$/

export function buildCaptions(words, plan, { maxChars = 14, maxLines = 2, maxGap = 0.55 } = {}) {
  const map = makeMapper(plan)
  const cards = []
  let buffer = []
  let lastEnd = null

  // 逐字落点：大字按音节落下要用它；同时保证拼出来的文字和卡片文本逐字一致
  const flush = () => {
    if (!buffer.length) return
    const chars = []
    for (const w of buffer) {
      const f0 = map(w.start)
      const f1 = Math.max(f0 + 0.04, map(w.end))
      const cs = [...String(w.w).replace(PUNCT, '')].filter(Boolean)
      const n = cs.length
      cs.forEach((ch, i) => chars.push({ ch, f0: +(f0 + (f1 - f0) * i / n).toFixed(3), f1: +(f0 + (f1 - f0) * (i + 1) / n).toFixed(3) }))
    }
    const text = chars.map(k => k.ch).join('').trim()
    const start = map(buffer[0].start)
    const end = Math.max(start + 0.35, map(buffer.at(-1).end))
    if (text && end > start) cards.push({ start, end, text, chars, srcStart: buffer[0].start, srcEnd: buffer.at(-1).end })
    buffer = []
  }

  for (const w of words) {
    const gap = lastEnd === null ? 0 : w.start - lastEnd
    const text = buffer.map(x => x.w).join('').replace(PUNCT, '')
    if (buffer.length && (gap > maxGap || text.length + w.w.length > maxChars || SENTENCE_END.test(buffer.at(-1).w))) {
      flush()
    }
    buffer.push(w)
    lastEnd = w.end
    if (SENTENCE_END.test(w.w)) flush()
  }
  flush()

  // 一个字都不许丢：与原文逐字核对
  const original = words.map(w => w.w).join('').replace(PUNCT, '')
  const shown = cards.map(c => c.text).join('')
  const missing = original.length - shown.length
  return { cards, coverage: { originalChars: original.length, shownChars: shown.length, missing } }
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
