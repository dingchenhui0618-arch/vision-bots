/**
 * 断行用的中文分词。只决定「一行到哪里为止」，一个字都不改。
 *
 * 零依赖：Node 自带的 Intl.Segmenter（ICU 的中文词典）。ICU 的问题是不认识视频黑话，
 * 「口播」拆成「口|播」、「划走」拆成「划|走了」、「这件事」拆成「这|件|事」——
 * 断行正好落在这些缝里，就是「很多人做口播视 / 频最大的问题」。
 * 所以分词之后再按词表合并回来：词表 = config/terms.json 的 hotwords / terms[].to + 内置几条。
 * 换成 jieba 也换不掉这一层：词典里没有的词，任何分词器都会拆开。
 *
 * 只在 Node 侧用（PPT 底座直接排 ASS，光轨把词写进 scene.json 交给画布引擎），
 * 渲染引擎不依赖分词器。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
// 不该出现在行首的单字（助词、语气词）。不是硬规范，是中文排版的实际观感。
const NO_LINE_START = '的了着过吧呢吗啊呀嘛地得'
const MAX_WORD = 4 // 合并的最长词长，再长就不是词而是短语了

// 内置合并词：ICU 一律拆成单字、但中文里是一个词。
const BUILTIN = ['这件事', '那件事', '一件事', '这种话', '说白了']

let segmenter = null
let lexicon = null

function getSegmenter() {
  if (segmenter === null) {
    try {
      segmenter = new Intl.Segmenter('zh', { granularity: 'word' })
    } catch {
      segmenter = false // 没有 ICU 数据时不断词，退回按字数切
    }
  }
  return segmenter || null
}

/** 词表：术语表里的领域词 + 内置。术语表坏了也不影响主流程。 */
function getLexicon() {
  if (lexicon) return lexicon
  lexicon = new Set(BUILTIN)
  try {
    const p = fileURLToPath(new URL('../config/terms.json', import.meta.url))
    const j = JSON.parse(readFileSync(p, 'utf8'))
    for (const w of j.hotwords || []) {
      if (typeof w === 'string' && w.length > 1 && w.length <= MAX_WORD) lexicon.add(w)
    }
    for (const t of j.terms || []) {
      if (t && typeof t.to === 'string' && t.to.length > 1 && t.to.length <= MAX_WORD) lexicon.add(t.to)
    }
  } catch {
    // 术语表缺失时只用内置词表
  }
  return lexicon
}

/** 把 ICU 拆碎的单字按词表合回整词。 */
function merge(raw, lex) {
  const out = []
  for (let i = 0; i < raw.length; i++) {
    let hit = 0
    for (let n = Math.min(MAX_WORD, raw.length - i); n >= 2; n--) {
      if (lex.has(raw.slice(i, i + n).join(''))) {
        hit = n
        break
      }
    }
    if (hit) {
      out.push(raw.slice(i, i + hit).join(''))
      i += hit - 1
    } else {
      out.push(raw[i])
    }
  }
  return out
}

/**
 * 分词。返回的词按顺序拼起来 === 原文本（一个字符都不增删），
 * 所以断行只会在词边界上切，不会丢字也不会重复。
 */
export function segment(text) {
  const s = String(text ?? '')
  if (!s) return []
  const it = getSegmenter()
  if (!it || !CJK.test(s)) return [s]
  const raw = []
  for (const piece of it.segment(s)) if (piece.segment) raw.push(piece.segment)
  if (raw.join('') !== s) return [s] // 分词器不可靠时宁可不分词
  return merge(raw, getLexicon())
}

/** 宽度：中文按 1，ASCII 按 0.56（和光轨引擎里的字宽口径一致）。 */
function measure(asciiHalf) {
  return asciiHalf ? ch => (ch.charCodeAt(0) < 0x100 ? 0.56 : 1) : () => 1
}
const width = (s, w) => {
  let n = 0
  for (const ch of s) n += w(ch)
  return n
}

/**
 * 按词断行：行数取「刚好装得下」的最少行，各行长度尽量均衡。
 * 孤行治理：末行短到快成一条尾巴时，从上一行借一个词下来。
 * 词本身超宽（长英文 / 长数字）时才硬切。
 */
export function wrapWords(text, per = 10, { asciiHalf = false } = {}) {
  const t = String(text ?? '')
  if (!t) return []
  const w = measure(asciiHalf)
  const perW = Math.max(1, per)

  const tokens = []
  for (const word of segment(t)) {
    if (width(word, w) <= perW) {
      tokens.push(word)
      continue
    }
    let cur = ''
    for (const ch of word) {
      if (cur && width(cur, w) + w(ch) > perW) {
        tokens.push(cur)
        cur = ''
      }
      cur += ch
    }
    if (cur) tokens.push(cur)
  }
  if (!tokens.length) return []

  const total = tokens.reduce((n, x) => n + width(x, w), 0)
  const n = Math.max(1, Math.ceil(total / perW))
  const budget = Math.max(1, Math.ceil(total / n))

  const lines = []
  let cur = []
  let cw = 0
  for (const tok of tokens) {
    const tw = width(tok, w)
    if (cur.length && cw + tw > budget) {
      lines.push(cur)
      cur = []
      cw = 0
    }
    cur.push(tok)
    cw += tw
  }
  if (cur.length) lines.push(cur)

  // 行首禁则：「的 / 了 / 吧」这类词单独起一行，读起来就是机器切的。
  // 并回上一行会让那一行宽一个字——光轨会自动缩字号，PPT 底座也按最长行缩，观感没有代价。
  for (let i = 1; i < lines.length; i++) {
    let moved = 0
    while (moved < 2 && lines[i].length > 1 && lines[i][0].length === 1 && NO_LINE_START.includes(lines[i][0])) {
      lines[i - 1].push(lines[i].shift())
      moved++
    }
  }

  const lw = line => line.reduce((s, x) => s + width(x, w), 0)
  let guard = 0
  while (lines.length > 1 && guard++ < 4) {
    const last = lines.at(-1)
    const prev = lines.at(-2)
    if (lw(last) >= budget * 0.5) break // 末行不算尾巴
    if (prev.length < 2) break
    const moved = prev.pop()
    if (lw(prev) < budget * 0.55) {
      prev.push(moved) // 挪下来上一行也塌了，不挪
      break
    }
    last.unshift(moved)
  }
  return lines.map(line => line.join(''))
}
