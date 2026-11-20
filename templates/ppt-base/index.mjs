/**
 * PPT 底座：人物满幅，顶部章节卡 + 底部字幕。
 * 分章、章节卡文字全部由词级时间戳确定性推导，模型不参与渲染。
 * 产出 scene.json；渲染交给固定引擎。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { makeMapper } from '../../src/plan.mjs'
import { mergeSentences } from '../../src/chapters.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const template = JSON.parse(readFileSync(join(HERE, 'template.json'), 'utf8'))

const SENT = /[。！？!?]$/
const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
const clean = ws => ws.map(w => w.w).join('').replace(PUNCT, '')

export function buildPptBase({ words, plan, segments, brief = {} }) {
  const t = template
  // 画幅：brief 说的优先，模板不认就退回模板默认画幅
  const layouts = t.layouts || {}
  const RATIO = (brief.ratio && layouts[brief.ratio]) ? brief.ratio : (layouts[t.ratio] ? t.ratio : Object.keys(layouts)[0] || '3:4')
  const L = layouts[RATIO]
  const [W, H] = L.size
  const map = makeMapper(plan)
  const raw = []

  // 章节优先取 ASR 的整句（model 给的句子边界比按字数硬切可靠）
  const sentences = (segments || [])
    .map(s => ({ start: map(s.start), end: Math.max(map(s.start) + 1.0, map(s.end)), text: String(s.text || '').replace(PUNCT, '') }))
    .filter(s => s.text && s.end > s.start)

  if (sentences.length >= 2) {
    raw.push(...mergeSentences(sentences))
  } else {
    let cur = []
    const flush = () => {
      if (!cur.length) return
      const start = map(cur[0].start)
      const end = Math.max(start + 1.2, map(cur[cur.length - 1].end))
      const text = clean(cur)
      if (text) raw.push({ start, end, text })
      cur = []
    }
    for (const w of words) {
      cur.push(w)
      const len = clean(cur).length
      const dur = map(w.end) - map(cur[0].start)
      if (SENT.test(w.w) || len >= 12 || dur >= 6.5) flush()
    }
    flush()
  }

  // 残句并走：单独成章会一闪而过。规则和光轨共用一份。
  const chapters = mergeSentences(raw, { shortSec: 0 })

  const total = chapters.length
  const hold = L.type.head.hold
  const per = Math.max(4, Math.floor((W - L.type.head.x * 2) / L.type.head.size))
  const outWords = words
    .map(w => ({ t: map(w.start), text: String(w.w).replace(PUNCT, '') }))
    .filter(w => w.text)
  const events = []

  chapters.forEach((c, i) => {
    const cardEnd = Math.min(c.end, c.start + hold)
    const ws = outWords.filter(w => w.t >= c.start - 0.02 && w.t < c.end + 0.02).map(w => w.text)
    events.push(`Dialogue: 0,${ts(c.start)},${ts(cardEnd)},Head,,0,0,0,,{\\fad(200,240)}${wrapHead(c.text, per, ws)}`)
    events.push(`Dialogue: 0,${ts(c.start)},${ts(cardEnd)},Idx,,0,0,0,,{\\fad(200,240)}${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`)
  })

  for (const c of captions(words, plan)) {
    events.push(`Dialogue: 0,${ts(c.start)},${ts(c.end)},Sub,,0,0,0,,${esc(c.text)}`)
  }

  const scene = {
    template: t.id,
    ratio: RATIO,
    size: L.size,
    spec: t.spec,
    layout: L,
    chapters: chapters.map((c, i) => ({
      index: i + 1,
      start: round(c.start), end: round(c.end),
      head: c.text.slice(0, 20), text: c.text,
      cardEnd: round(Math.min(c.end, c.start + hold)),
    })),
  }

  return {
    scene,
    assText: header(L) + events.join('\n') + '\n',
    layout: { ...L, width: W, height: H },
  }
}

const round = n => Number(n.toFixed(2))

/**
 * 章节卡手动断行。断行符是控制码，不参与转义。
 * 优先按词断（`words` 的边界就是中文的词边界，按字数硬切会把「视频」拆成两个字），
 * 词对不上章节文本时退回按字数平分；两种情况都做孤行治理，不留一个字单独一行。
 */
function wrapHead(text, per = 10, ws = null) {
  const t = text.slice(0, 20)
  if (!t) return ''
  const lines = wrapByWords(ws, per, t) || wrapByChars(t, per)
  return lines.map(esc).join(String.fromCharCode(92) + 'N')
}

function wrapByWords(ws, per, t) {
  if (!ws || !ws.length) return null
  // 只取前 20 字，且必须和章节文本逐字对得上，否则说明词和句子不是同一份来源
  const flat = []
  let acc = ''
  for (const w of ws) {
    for (const ch of w) {
      if (acc.length >= t.length) break
      acc += ch
      flat.push(ch)
    }
    if (acc.length >= t.length) break
  }
  if (acc !== t) return null
  const words = []
  let i = 0
  for (const w of ws) {
    const take = []
    for (const ch of w) {
      if (i >= t.length) break
      take.push(ch)
      i++
    }
    if (take.length) words.push(take.join(''))
    if (i >= t.length) break
  }
  const pieces = []
  for (const w of words) {
    if (w.length <= per) { pieces.push(w); continue }
    for (let k = 0; k < w.length; k += per) pieces.push(w.slice(k, k + per))
  }
  const total = pieces.join('').length
  const n = Math.max(1, Math.ceil(total / per))
  const budget = Math.max(1, Math.ceil(total / n))
  const out = []
  let cur = []
  const len = l => l.reduce((s, w) => s + w.length, 0)
  for (const w of pieces) {
    if (cur.length && len(cur) + w.length > budget) { out.push(cur); cur = [] }
    cur.push(w)
  }
  if (cur.length) out.push(cur)
  // 孤行：末行只剩一两个字，从上一行借一个词下来
  while (out.length > 1 && out.at(-1).length === 1 && len(out.at(-1)) <= 3 && out.at(-2).length > 1) {
    out.at(-1).unshift(out.at(-2).pop())
  }
  return out.map(l => l.join(''))
}

function wrapByChars(t, per) {
  const n = Math.max(1, Math.ceil(t.length / per))
  const size = Math.max(1, Math.ceil(t.length / n))
  const lines = []
  for (let i = 0; i < t.length; i += size) lines.push(t.slice(i, i + size))
  return lines
}

function captions(words, plan, maxChars = 14) {
  const map = makeMapper(plan)
  const cards = []
  let buf = []
  let lastEnd = 0
  const flushCard = () => {
    if (!buf.length) return
    const text = clean(buf)
    if (text) cards.push({ start: map(buf[0].start), end: Math.max(map(buf[0].start) + 0.35, map(buf[buf.length - 1].end)), text })
    buf = []
  }
  for (const w of words) {
    const gap = buf.length ? w.start - lastEnd : 0
    if (buf.length && (gap > 0.55 || clean(buf).length + w.w.length > maxChars || SENT.test(buf[buf.length - 1].w))) flushCard()
    buf.push(w)
    lastEnd = w.end
    if (SENT.test(w.w)) flushCard()
  }
  flushCard()
  return cards
}

function header(L) {
  const t = L
  const head = `Style: Head,${t.type.head.font},${t.type.head.size},&H00F4F4F0,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,0,0,7,${t.type.head.x},${t.type.head.x},${t.type.head.y},1`
  const idxs = `Style: Idx,${t.type.index.font},${t.type.index.size},&H00D7D7D3,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,2,0,1,0,0,9,${t.type.index.right},${t.type.index.right},${t.type.index.y},1`
  const sub = `Style: Sub,${t.type.caption.font},${t.type.caption.size},&H00F4F4F0,&H000000FF,&H00101011,&H80000000,-1,0,0,0,100,100,0,0,1,${t.type.caption.outline},0,2,72,72,${t.type.caption.bottom},1`
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${L.size[0]}
PlayResY: ${L.size[1]}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${head}
${idxs}
${sub}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`
}

const esc = s => s.replace(/\\/g, '\\\\')

function ts(t) {
  const cs = Math.max(0, Math.round(t * 100))
  const h = Math.floor(cs / 360000), m = Math.floor(cs % 360000 / 6000), s = Math.floor(cs % 6000 / 100), r = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(2, '0')}`
}