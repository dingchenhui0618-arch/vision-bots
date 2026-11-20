/**
 * 资产层：bot 名册、模板库、术语表。
 *
 * 前台是群聊，这里是背景层——机器级的资产，不属于某个项目。
 * 术语表是这里唯一可写的东西，因为它是客户唯一真会想改的：行业黑话、品牌名、人名。
 * 改文件时代码没有意见，但改错了没人拦；所以这一层带三个不收钱的门：
 *
 *   1. 同音门：kind=homophone 的条目必须真同音（pypinyin 验）。
 *      不同音的替换只能登记成专有名词（kind=term），并且会被提醒「可能连正确的词一起改」。
 *      这不是洁癖：applyTerms 是确定性替换，一条不通音的同音条目会把片子里正确的词改坏。
 *   2. 写盘门：临时文件 + rename。写坏一半的术语表会让每次转写都静默退回兜底。
 *   3. 缓存门：保存后清分词词表缓存，否则界面说保存成功、断行还在用旧词。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BOTS, TEMPLATES, specOf } from './bots/roster.mjs'
import { segment, resetLexicon } from './segment.mjs'
import { applyTerms, hotwordPrompt, pinyinOf as realPinyin } from './asr-fix.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const TERMS_FILE = join(ROOT, 'config', 'terms.json')

export const KINDS = ['homophone', 'term', 'number', 'punct']

const MAX_WORD = 8
const digest = s => createHash('sha1').update(s).digest('hex').slice(0, 12)

/** 读术语表。rev 是文件内容的指纹，存盘时拿它对账，防止把别处的改动盖掉。 */
export function readTerms(file = TERMS_FILE) {
  const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const j = JSON.parse(raw)
  return {
    version: Number(j.version) || 1,
    note: typeof j.note === 'string' ? j.note : '',
    hotwords: (j.hotwords || []).filter(x => typeof x === 'string').map(String),
    terms: (j.terms || []).filter(t => t && typeof t === 'object').map(t => ({ ...t, from: Array.isArray(t.from) ? t.from.map(String) : [] })),
    rev: digest(raw),
    file,
  }
}

/**
 * 结构校验：不查拼音，纯形状。返回 {ok, errors, warnings}，每条带位置和原因。
 * 位置写成 terms[3].from[0] 这种路径，界面上能直接指到那一格。
 */
export function validateTerms(j) {
  const errors = []
  const warnings = []
  const hotwords = Array.isArray(j.hotwords) ? j.hotwords : []
  const seenHot = new Set()
  hotwords.forEach((w, i) => {
    const at = 'hotwords[' + i + ']'
    if (typeof w !== 'string' || !w.trim()) return errors.push({ at, why: '空词' })
    if (/\s/.test(w)) return errors.push({ at, why: '「' + w + '」里有空格' })
    if (w.length > MAX_WORD) return errors.push({ at, why: '「' + w + '」超过 ' + MAX_WORD + ' 字，会挤掉别的热词' })
    if (seenHot.has(w)) return errors.push({ at, why: '「' + w + '」重复' })
    seenHot.add(w)
  })

  const terms = Array.isArray(j.terms) ? j.terms : []
  if (!hotwords.length && !terms.length) warnings.push('热词和术语都空着，错字治理只剩模型那一层')
  if (hotwords.length) {
    const list = terms.map(t => ({ to: String(t.to || '') }))
    list.hotwords = hotwords
    const prompt = hotwordPrompt(list) || ''
    if (prompt.length >= 180) warnings.push('热词串已经顶到 180 字上限（' + prompt.length + ' 字），排在后面的词转写时用不上')
  }

  const seen = new Set()
  terms.forEach((t, i) => {
    const at = 'terms[' + i + ']'
    if (!t || typeof t !== 'object') return errors.push({ at, why: '不是对象' })
    const to = String(t.to || '').trim()
    if (!to) errors.push({ at, why: '缺少 to（改成的正确形态）' })
    else {
      if (/\s/.test(to)) errors.push({ at, why: 'to 里有空格' })
      if (to.length > MAX_WORD) errors.push({ at, why: 'to 超过 ' + MAX_WORD + ' 字' })
    }
    const from = Array.isArray(t.from) ? t.from : []
    if (!from.length) errors.push({ at, why: '缺少 from（ASR 常写错的形态）' })
    from.forEach((f, k) => {
      const a = at + '.from[' + k + ']'
      if (typeof f !== 'string' || !f.trim()) return errors.push({ at: a, why: '空形态' })
      if (/\s/.test(f)) return errors.push({ at: a, why: '「' + f + '」里有空格' })
      if (f === to) return errors.push({ at: a, why: '「' + f + '」和 to 一样，这条永远不会触发' })
    })
    if (t.kind && !KINDS.includes(t.kind)) errors.push({ at, why: 'kind 只能是 ' + KINDS.join(' / ') })
    if (t.next !== undefined) {
      const nx = Array.isArray(t.next) ? t.next : [t.next]
      if (!nx.length || nx.some(x => typeof x !== 'string' || !x.trim())) errors.push({ at, why: 'next 要是非空词或词数组' })
    }
    if (t.onlyIfLowConfidence !== undefined && typeof t.onlyIfLowConfidence !== 'boolean') errors.push({ at, why: 'onlyIfLowConfidence 只能是 true / false' })
    const key = [t.kind || 'term', to, from.join(','), [].concat(t.next || []).join(',')].join('|')
    if (seen.has(key)) errors.push({ at, why: '和前面某条完全重复' })
    seen.add(key)
  })

  // 同一个形态被两条改成不同结果时，谁先命中看数组顺序——说清楚，别让人以为会「合并」
  const owner = new Map()
  for (const t of terms) {
    for (const f of (Array.isArray(t.from) ? t.from : [])) {
      const k = (t.kind || 'term') + '|' + f + '|' + (t.next ? '>' + [].concat(t.next).join(',') : '')
      const prev = owner.get(k)
      const to = String(t.to || '')
      if (prev && to && prev !== to) warnings.push('「' + f + '」被两条改成不同结果（' + prev + ' / ' + to + '），先命中哪条看顺序')
      else if (to) owner.set(k, to)
      else owner.set(k, String(t.to || ''))
    }
  }
  return { ok: errors.length === 0, errors, warnings }
}

/**
 * 同音门。同音字条目逐条查拼音；专有名词条目不同音时给提醒（它可能连正确的词一起改）。
 * 本机没有 pypinyin 就 pinyinMode:'off'——不拦存盘，但要说清楚门没跑。
 */
export async function auditTerms(j, opts = {}) {
  const getPy = opts.pinyinOf || realPinyin
  const terms = Array.isArray(j.terms) ? j.terms : []
  const targets = terms.map((t, i) => ({ t, i })).filter(x => x.t.kind === 'homophone' || x.t.kind === 'term')
  if (!targets.length) return { pinyinMode: 'n/a', rows: [], errors: [], warnings: [], checked: 0 }

  const pairs = []
  for (const { t, i } of targets) for (const f of (Array.isArray(t.from) ? t.from : [])) pairs.push({ i, kind: t.kind, from: f, to: String(t.to || ''), low: Boolean(t.onlyIfLowConfidence) })
  if (!pairs.length) return { pinyinMode: 'n/a', rows: [], errors: [], warnings: [], checked: 0 }

  const py = await getPy([...pairs.map(p => p.from), ...pairs.map(p => p.to)])
  if (!py) return { pinyinMode: 'off', rows: [], errors: [], warnings: ['本机没有拼音校验（pypinyin 不可用），同音门没跑——存盘不拦，但同音条目没被验证'], checked: 0 }

  const n = pairs.length
  const rows = pairs.map((p, k) => {
    const pyFrom = py[k] || null
    const pyTo = py[n + k] || null
    return { ...p, pyFrom, pyTo, same: Boolean(pyFrom && pyTo && pyFrom === pyTo) }
  })
  const errors = []
  const warnings = []
  for (const r of rows) {
    const at = 'terms[' + r.i + '].from[' + terms[r.i].from.indexOf(r.from) + ']'
    if (r.kind === 'homophone' && !r.same) {
      errors.push({ at, why: '「' + r.from + '」读 ' + (r.pyFrom || '查不到') + '，「' + r.to + '」读 ' + (r.pyTo || '查不到') + '，不同音。同音字类必须真同音；不是同音就只能登记成专有名词（kind: term）' })
    }
    if (r.kind === 'term' && !r.same && !r.low) {
      warnings.push('「' + r.from + '」和「' + r.to + '」不同音，又没勾「只改低置信」，会把片子里写对的「' + r.from + '」也一并改掉')
    }
  }
  return { pinyinMode: 'on', rows, errors, warnings, checked: rows.length }
}

/**
 * 序列化：按人写这个文件时的样子排——热词一行灌几个，术语一条一行、对象压平。
 * 不是洁癖：内容没改的一次存盘必须产生 0 行 git diff，否则以后看这个文件的改动就全是噪音，
 * 「原样存回字节不变」也就成了可以进检查脚本的断言。
 */
export function serializeTerms(j) {
  const q = s => JSON.stringify(String(s == null ? '' : s))
  const inlineArr = a => '[' + a.map(q).join(', ') + ']'
  const hotwords = (j.hotwords || []).map(String)
  const terms = j.terms || []
  const out = ['{', '  "version": ' + (Number(j.version) || 1) + ',', '  "note": ' + q(j.note || '') + ',']

  const vis = s => {
    let n = 0
    for (const ch of s) n += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
    return n
  }
  const WIDTH = 88 // 内容（不含缩进）的宽度上限：中文按两格算，一行十个词左右，diff 里看得清是哪个词动了

  if (!hotwords.length) out.push('  "hotwords": [],')
  else {
    out.push('  "hotwords": [')
    const rows = []
    let cur = ''
    for (const w of hotwords) {
      const piece = (cur ? ', ' : '') + q(w)
      if (cur && vis(cur + piece) > WIDTH) { rows.push(cur + ','); cur = q(w) } else cur += piece
    }
    if (cur) rows.push(cur)
    for (const r of rows) out.push('    ' + r)
    out.push('  ],')
  }

  if (!terms.length) out.push('  "terms": []')
  else {
    out.push('  "terms": [')
    terms.forEach((t, i) => {
      const parts = ['"kind": ' + q(t.kind || 'term'), '"to": ' + q(t.to || ''), '"from": ' + inlineArr(t.from || [])]
      if (t.next !== undefined) parts.push('"next": ' + (Array.isArray(t.next) ? inlineArr(t.next) : q(t.next)))
      if (t.onlyIfLowConfidence) parts.push('"onlyIfLowConfidence": true')
      out.push('    { ' + parts.join(', ') + ' }' + (i === terms.length - 1 ? '' : ','))
    })
    out.push('  ]')
  }
  out.push('}')
  return out.join('\n') + '\n'
}

/**
 * 存盘：临时文件 + rename。返回落盘后的实际内容（含新 rev）。
 * 顺序、note、version 全部原样保留——这个文件是人也会手改的，别替人重排。
 */
export function writeTerms(j, file = TERMS_FILE) {
  const next = {
    version: Number(j.version) || 1,
    note: typeof j.note === 'string' ? j.note : '',
    hotwords: (j.hotwords || []).map(String),
    terms: (j.terms || []).map(t => {
      const out = { kind: t.kind || 'term', to: String(t.to || ''), from: (t.from || []).map(String) }
      if (t.next !== undefined) out.next = t.next
      if (t.onlyIfLowConfidence) out.onlyIfLowConfidence = true
      return out
    }),
  }
  mkdirSync(dirname(file), { recursive: true })
  const body = serializeTerms(next)
  const tmp = file + '.tmp'
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, file)
  resetLexicon()
  return readTerms(file)
}

/**
 * 试验台：拿真的 applyTerms 在真的分词结果上跑一遍。
 * 词没有真实时间戳，这里按 0.12s 一个假词位、置信度 0.5（低置信那一侧，让 onlyIfLowConfidence 有机会触发）。
 * 所以它验的是「这条术语会不会命中」，不验转写本身——这个区别在界面上写清楚。
 */
export function trial(text, terms) {
  const src = String(text || '')
  if (!src.trim()) return { src, out: src, hits: [], skipped: [], spans: [], words: 0, changed: 0 }
  const words = segment(src).map((w, i) => ({ w, start: +(i * 0.12).toFixed(2), end: +(i * 0.12 + 0.1).toFixed(2), p: 0.5 }))
  const r = applyTerms(words, terms)
  const out = r.words.map(w => w.w).join('')
  const spans = []
  let at = 0
  for (const w of r.words) {
    if (w.fixed && w.w0 && w.w0 !== w.w) spans.push({ at, from: w.w0, to: w.w, len: w.w.length })
    at += w.w.length
  }

  // 再按字面找一遍：客户脑子里想的是「这句话里有没有我登记的那个错写」，
  // 分词器却可能把它切成两个词（「口拨」→「口」「拨」）。两边都摆出来，别让试验台替生产打包票。
  const literal = []
  for (const t of terms) {
    for (const from of (t.from || [])) {
      if (!from) continue
      let i = src.indexOf(from)
      while (i >= 0) {
        const rest = src.slice(i + from.length)
        const ok = !t.next || [].concat(t.next).some(x => rest.startsWith(x))
        if (ok) literal.push({ at: i, from: from, to: String(t.to || ''), kind: t.kind || 'term' })
        i = src.indexOf(from, i + 1)
      }
    }
  }
  const missed = literal.filter(L => !spans.some(s => s.at === L.at))

  return { src, out, hits: r.hits, skipped: r.skipped, spans, words: words.length, changed: spans.length, literal, missed }
}

/**
 * 名册：只给界面真会显示的那几栏。
 * skills 不出去——它是内功，不是产品形态；浏览器里也不该出现内部资产名。
 */
export function botRoster() {
  return BOTS.map(b => ({
    id: b.id,
    name: b.name,
    mark: b.mark,
    order: b.order,
    role: b.role,
    voice: b.voice,
    model: b.model,
    tools: b.tools || [],
    templates: (b.templates || []).map(id => {
      const t = TEMPLATES.find(x => x.id === id)
      return t ? t.name : id
    }),
    outputs: b.outputs || [],
    refuses: b.refuses || [],
  }))
}

/**
 * 模板库：roster 声明什么、template.json 实际做了什么，两样都摆出来。
 * 声明和实现对不上的时候（比如 template.json 少一个画幅），界面上能看见，但这里不判错——
 * 那是 scripts/check-templates.mjs 的活，它退出码会红。
 */
export function templateLibrary() {
  return TEMPLATES.map(tpl => {
    const spec = specOf(tpl)
    const file = join(ROOT, 'templates', tpl.id, 'template.json')
    let built = null
    if (existsSync(file)) {
      try {
        const t = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
        built = {
          engine: t.engine || null,
          ratio: t.ratio || null,
          layouts: Object.keys(t.layouts || {}),
          palette: t.palette ? Object.keys(t.palette) : null,
        }
      } catch (err) {
        built = { error: 'template.json 读不出来：' + err.message }
      }
    }
    return {
      id: tpl.id,
      name: tpl.name,
      bot: tpl.bot,
      status: tpl.status || 'planned',
      engine: tpl.engine || 'ffmpeg',
      note: tpl.note || '',
      defaultRatio: spec.ratio,
      size: [spec.width, spec.height],
      fps: spec.fps,
      duration: spec.duration,
      ratios: Object.entries(tpl.ratios || {}).map(([r, s]) => ({ ratio: r, width: s.width, height: s.height })),
      built,
    }
  })
}

/** 资产层的总口径，给页面顶部那行小字用。 */
export function assetSummary() {
  const terms = readTerms()
  return {
    bots: BOTS.length,
    templates: TEMPLATES.length,
    ready: TEMPLATES.filter(t => t.status === 'ready').length,
    hotwords: terms.hotwords.length,
    terms: terms.terms.length,
    termsFile: TERMS_FILE,
  }
}
