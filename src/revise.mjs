/**
 * 改一句：把用户的一句话变成 scene 的改动，再让它只重渲那一处。
 *
 * 硬约束（和错字治理同一条规矩）：只改词的文字，
 * 词数、每个词的起止时间码一个字都不能动——时间线是 EDL 定的，不由这句话改。
 *
 * 这里只做「定位 + 改字 + 自检」，不碰渲染：渲染由模板和分段缓存照着新 scene 走。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { makeMapper } from './plan.mjs'
import { buildCaptions } from './captions.mjs'
import { applyToSegments } from './asr-fix.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
const PUNCT_TAIL = /[，。！？、；：,.!?;:…—~·\s]+$/u
const QUOTE = /[「」『』“”"'\u2018\u2019\u201c\u201d《》\[\]()（）]/gu

const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function toNumber(s) {
  if (/^\d+$/.test(s)) return Number(s)
  if (CN_NUM[s]) return CN_NUM[s]
  const m = String(s).match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/)
  if (m) return (m[1] ? CN_NUM[m[1]] : 1) * 10 + (m[2] ? CN_NUM[m[2]] : 0)
  return null
}

const clean = s => String(s || '')
  .replace(QUOTE, '')
  .replace(/^(把|请|帮我|麻烦|给我|我想)+/u, '')
  .replace(PUNCT_TAIL, '')
  .trim()

/**
 * 解析一句改动。
 * 支持：「把划走改成溜走」「划走换成溜走」「「划走」→「溜走」」「第4章的划走改成溜走」
 * 返回 { kind:'edit', from, to, chapter } / { kind:'rerun' } / null
 */
export function parseEdit(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (/^(重跑|重新跑|重来|重新来|再来一版|再跑一遍|重新出片|重新渲染)/.test(raw)) return { kind: 'rerun' }

  const sep = raw.match(/^(.*?)(?:改成|换成|改为|替换成|替换为|变成|→|->|=>)(.*)$/su)
  if (!sep) return null
  let left = sep[1]
  const right = sep[2]
  if (!left || !right) return null

  let chapter = null
  const ch = left.match(/第\s*([0-9一二三四五六七八九十]+)\s*章/)
  if (ch) {
    chapter = toNumber(ch[1])
    left = left.replace(ch[0], '')
  }
  const from = clean(left).replace(/^(的|那个|这句|这一句|这个字|这几个字)+/u, '')
  const to = clean(right)
  if (!from || !to) return null
  return { kind: 'edit', from, to, chapter }
}

/** 词序列摊平成字符流：跨词的错字（「划」+「走了。」）也能匹配。 */
function flatten(words) {
  const chars = []
  const offsets = []
  let pos = 0
  for (let i = 0; i < words.length; i++) {
    const cs = [...String(words[i].w === undefined ? '' : words[i].w)]
    offsets.push(pos)
    for (let c = 0; c < cs.length; c++) chars.push({ ch: cs[c], w: i })
    pos += cs.length
  }
  return { chars, offsets, text: chars.map(x => x.ch).join('') }
}

/**
 * 在词序列里找这句话说的那一段。
 * 返回 { ok, match, matches, reason, hint }
 */
export function locate(words, from, { plan = null, chapter = null, scene = null } = {}) {
  const flat = flatten(words)
  const target = String(from || '')
  const tries = [target]
  const bare = target.replace(PUNCT, '')
  if (bare && bare !== target) tries.push(bare)

  let hits = []
  for (const t of tries) {
    if (!t) continue
    let p = flat.text.indexOf(t)
    while (p !== -1) { hits.push({ p, q: p + t.length }); p = flat.text.indexOf(t, p + t.length) }
    if (hits.length) break
  }

  const map = plan ? makeMapper(plan) : null
  const matches = hits.map(h => {
    const i = flat.chars[h.p].w
    const j = flat.chars[h.q - 1].w
    const at = Number(words[i].start || 0)
    const film = map ? +map(at).toFixed(2) : null
    return { i, j, from: h.p, to: h.q, at, film, chapter: scene ? chapterOf(scene, film === null ? at : film) : null }
  })

  if (!matches.length) {
    const head = bare.slice(0, 2)
    const around = words
      .map(w => String(w.w || ''))
      .filter(w => head && w && (w.includes(head[0]) || (head[1] && w.includes(head[1]))))
      .slice(0, 5)
      .map(w => '「' + w + '」')
    return { ok: false, matches: [], reason: '这条片子里没有「' + target + '」', hint: around.length ? '相近的有：' + around.join('、') : '' }
  }

  if (chapter) {
    const inChapter = matches.filter(m => m.chapter === chapter)
    if (!inChapter.length) {
      const where = [...new Set(matches.map(m => m.chapter).filter(Boolean))]
      return { ok: false, matches, reason: '第 ' + chapter + ' 章里没有「' + target + '」', hint: where.length ? '它在第 ' + where.join('、') + ' 章' : '' }
    }
    return { ok: true, match: inChapter[0], matches: inChapter }
  }
  if (matches.length > 1) {
    const list = matches.map(m => (m.chapter ? '第 ' + m.chapter + ' 章（' + m.film + 's）' : m.film + 's')).join('、')
    return { ok: false, matches, ambiguous: true, reason: '这条有 ' + matches.length + ' 处「' + target + '」：' + list, hint: '说「第几章的」我再改，别改错地方' }
  }
  return { ok: true, match: matches[0], matches }
}

function chapterOf(scene, t) {
  const bigs = scene && scene.bigs ? scene.bigs : []
  for (const b of bigs) if (t >= b.f0 - 0.02 && t <= b.f1 + 0.02) return b.index
  return null
}

/**
 * 改字：只动被匹配到的那几个词，词数不变、时间码不变。
 * 等长替换按原词边界摊回去（逐字落点不动）；不等长时替换整段塞进起始词，
 * 剩余文本原样留在最后的词里——不丢字，也不假装对齐。
 */
export function applyEdit({ words, segments, match, to }) {
  const i = match.i
  const j = match.j
  const pick = words.map(w => String(w.w === undefined ? '' : w.w))
  let localStart = match.from
  for (let k = 0; k < i; k++) localStart -= [...pick[k]].length
  let localEnd = match.to
  for (let k = 0; k < i; k++) localEnd -= [...pick[k]].length

  const spanText = pick.slice(i, j + 1).join('')
  const replacement = String(to)
  const newSpan = spanText.slice(0, localStart) + replacement + spanText.slice(localEnd)
  const lens = pick.slice(i, j + 1).map(s => [...s].length)
  const out = words.map(w => ({ ...w }))

  if ([...replacement].length === localEnd - localStart) {
    let p = 0
    for (let k = 0; k < lens.length; k++) {
      out[i + k].w = newSpan.slice(p, p + lens[k])
      p += lens[k]
    }
  } else {
    const prefix = spanText.slice(0, localStart)
    const suffix = spanText.slice(localEnd)
    if (j > i) {
      out[i].w = prefix + replacement
      for (let k = i + 1; k < j; k++) out[k].w = ''
      out[j].w = suffix
    } else {
      out[i].w = prefix + replacement + suffix
    }
  }

  // 自检的基准：整条文字只在匹配那一段上被换掉，别处一个字都不许动
  const globalText = words.map(w => w.w).join('')
  let gStart = 0
  for (let k = 0; k < i; k++) gStart += pick[k].length
  const expect = globalText.slice(0, gStart + localStart) + replacement + globalText.slice(gStart + localEnd)
  const joined = out.map(w => w.w).join('')
  if (joined !== expect) throw new Error('改字对不上：' + joined + ' ≠ ' + expect)

  const changed = []
  for (let k = i; k <= j; k++) if (out[k].w !== pick[k]) changed.push({ i: k, from: pick[k], to: out[k].w, at: words[k].start })
  return { words: out, segments: applyToSegments(out, segments), changed, before: spanText, after: newSpan }
}

/** 自检：词数、每词时间码必须一个不变，改动只能落在被匹配的词上。 */
export function assertUntouched(before, after, { changed = [] } = {}) {
  if (before.length !== after.length) throw new Error('词数变了：' + before.length + ' → ' + after.length)
  const allowed = new Set(changed.map(c => c.i))
  for (let i = 0; i < before.length; i++) {
    if (Number(before[i].start) !== Number(after[i].start) || Number(before[i].end) !== Number(after[i].end)) {
      throw new Error('第 ' + i + ' 个词的时间码被动了：' + before[i].start + '–' + before[i].end + ' → ' + after[i].start + '–' + after[i].end)
    }
    if (before[i].w !== after[i].w && !allowed.has(i)) {
      throw new Error('第 ' + i + ' 个词不在改动范围内却变了：「' + before[i].w + '」→「' + after[i].w + '」')
    }
  }
  return true
}

/**
 * 取回这条片子最后一次剪辑的完整状态：改一句要基于它，不能重跑转写。
 * 新群直接读 pipeline.json；老群从产物反推（plan.json 旁边就有 transcript.json）。
 */
export function loadPipeline(group) {
  const file = join(group.dir, 'pipeline.json')
  if (existsSync(file)) {
    const p = JSON.parse(readFileSync(file, 'utf8'))
    if (p && p.transcript && p.plan) return { ...p, from: 'pipeline.json' }
  }
  const a = group.meta.artifacts || {}
  if (!a.timeline || !existsSync(a.timeline)) return null
  const dir = dirname(a.timeline)
  const tFile = join(dir, 'transcript.json')
  if (!existsSync(tFile)) return null
  const plan = JSON.parse(readFileSync(a.timeline, 'utf8'))
  const transcript = JSON.parse(readFileSync(tFile, 'utf8'))
  const brief = group.meta.brief || {}
  const captions = buildCaptions(transcript.words, plan, { maxChars: brief.maxChars || 14 })
  const fixFile = a.fix && existsSync(a.fix) ? JSON.parse(readFileSync(a.fix, 'utf8')) : null
  return {
    version: 0,
    at: new Date().toISOString(),
    template: group.meta.template,
    brief,
    plan,
    captions,
    transcript: { words: transcript.words, segments: transcript.segments },
    fixReport: fixFile,
    from: '从产物反推（plan.json + transcript.json）',
  }
}

/** 上次出片的 scene：章节名和帧区间都从它来，改一句时告诉用户改的是第几章。 */
export function loadScene(group) {
  const f = (group.meta.artifacts || {}).scene
  if (!f || !existsSync(f)) return null
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null }
}

export function savePipeline(group, pipe) {
  const out = { ...pipe, version: 1, at: new Date().toISOString() }
  delete out.from
  const file = join(group.dir, 'pipeline.json')
  writeFileSync(file, JSON.stringify(out), 'utf8')
  return file
}

export { PUNCT }
