/**
 * 段落大字标题：模型给提案，规则定生死。
 *
 * 为什么不全交给模型：标题是「上屏 3–11 秒、观众唯一读完的一行字」，
 * 模型擅长写短句，但它会顺手编原文没有的事实（数字、平台名、结论），
 * 也常给出「都能做出你想要的」「捡内容生产力才是」这种被截断的半句话。
 * 所以每条标题都要过接地检查——字必须来自这一段自己说过的话——结尾还得落在实词上。
 * 过不了的先让模型重写一次，还不行才退回原句（pickTitle 的结果），并在报告里写明哪几条是模型写的。
 */
import { chatJSONCached, taskCall } from './llm.mjs'

export const TITLE = {
  minChars: 4,     // 少于 4 字撑不起大字，观感像标签
  maxChars: 12,    // 超过 12 字在 9:16 上要缩号，光轨的留白会被吃掉
  hardMax: 16,     // 超过这个数直接判不合格，不缩号
  groundRatio: 0.8,// 标题里至少 80% 的字来自该段原文
  // 结尾落在这类字上，上屏就是半句话；中文断行的禁则同理，只是这里管整句
  badTail: '的了是在和就都也才把给对从但而很太更不没有着过吧呢吗啊嘛',
  badHead: /^(但是|然后|所以|因为|而且|就是|这样|那么|其实|如果|虽然|这个|那个)/,
}

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/g
const strip = s => String(s || '').replace(PUNCT, '')
const chars = s => [...strip(s)]
const DIGITS = /[0-9一二三四五六七八九十百千万亿%]/

/**
 * 一条标题能不能上屏：长度、接地、不编数字、结尾不许是半句话。纯函数，可单测。
 */
export function checkTitle(text, section, { maxChars = TITLE.maxChars } = {}) {
  const t = strip(text)
  if (!t) return { ok: false, why: '空标题' }
  const cs = [...t]
  if (cs.length < TITLE.minChars) return { ok: false, why: '少于 ' + TITLE.minChars + ' 字' }
  if (cs.length > TITLE.hardMax) return { ok: false, why: '超过 ' + TITLE.hardMax + ' 字' }
  if (cs.length > maxChars) return { ok: false, why: '超过这段的 ' + maxChars + ' 字上限' }

  const pool = new Set(chars((section.lines || []).join('') || section.text || ''))
  const inside = cs.filter(c => pool.has(c)).length
  const ratio = inside / cs.length
  if (ratio < TITLE.groundRatio) {
    return { ok: false, why: '接地不足：' + Math.round(ratio * 100) + '% 的字来自原文（要 ' + Math.round(TITLE.groundRatio * 100) + '%）', ratio }
  }
  // 原文没说的数字一律不许出现：这是「编事实」最常见的样子（「省下 90% 时间」）
  const said = strip((section.lines || []).join('') || section.text || '')
  if (DIGITS.test(t)) {
    const bad = cs.filter(c => DIGITS.test(c) && !said.includes(c))
    if (bad.length) return { ok: false, why: '标题里有原文没说的数字：' + bad.join('') }
  }
  // 结尾落在虚词上，上屏就是一个被截断的半句话（实测模型常给出「都能做出你想要的」「捡内容生产力才是」）
  if (TITLE.badTail.includes(cs[cs.length - 1])) {
    return { ok: false, why: '结尾是「' + cs[cs.length - 1] + '」，读起来是半句话' }
  }
  if (TITLE.badHead.test(t)) return { ok: false, why: '以连接词开头，抓不住人' }
  return { ok: true, ratio }
}

function promptFor(input, maxChars) {
  return [
    '你在给竖屏口播视频写「大字标题」：每段一句，这句话在画面上停留 3–11 秒，观众只读这一行。',
    '要求：',
    '- 每句 6–8 个汉字（最多 ' + maxChars + ' 个），是压缩过的短语，不是整句照抄。',
    '- 只能用这一段原文里出现过的字；不许引入原文没有的数字、人名、平台名、结论。',
    '- 结尾落在实词上，不许是「的、了、是、在、就、都、也、才、把」这类字——那是半句话。',
    '- 不许以「但是、所以、然后、就是」开头。',
    '- 各段不重复；不要问句堆叠、不要感叹号、不要「大家好」「这期视频」。',
    '示范：原文「但是我今天就要给大家泼一瓶冷水」→ 标题「先泼一盆冷水」；原文「就是说用AI来做生产力工具」→「AI做生产力工具」。',
    '',
    '段落（index / 时长秒 / 原文）：',
    JSON.stringify(input, null, 1),
    '',
    '只输出 JSON：{"titles":[{"index":1,"text":"6到8个字"}]}',
  ].join('\n')
}

export function validateBatch(list, asked, maxChars, used) {
  const byIndex = new Map()
  for (const t of asked) {
    const i = Number(t && t.index)
    if (Number.isInteger(i)) byIndex.set(i, String(t.text || ''))
  }
  return list.map(s => {
    const raw = byIndex.get(s.index)
    if (!raw) return { index: s.index, text: s.text, source: 'rules', ok: false, why: '模型没给这一段' }
    const c = checkTitle(raw, s, { maxChars })
    if (!c.ok) return { index: s.index, text: s.text, source: 'rules', ok: false, why: c.why, asked: strip(raw) }
    if (used.has(strip(raw))) return { index: s.index, text: s.text, source: 'rules', ok: false, why: '和前面某段重复', asked: strip(raw) }
    used.add(strip(raw))
    return { index: s.index, text: strip(raw), source: 'model', ok: true, ratio: c.ratio }
  })
}

/**
 * 给每段要一个标题。返回的 titles 一定和 sections 等长、索引一一对应。
 * 有打回时问模型一轮「只重写这几段」，还不行才退回原句（source: 'rules'）——
 * 静默留空或者硬塞半句话上屏都不行。
 */
export async function titleSections({ sections, maxChars = TITLE.maxChars, log = () => {}, repair = true } = {}) {
  const list = Array.isArray(sections) ? sections : []
  if (!list.length) return { ok: false, skipped: 'no-sections', titles: [] }

  const input = list.map(s => ({ index: s.index, 秒: +((s.end - s.start)).toFixed(1), 原文: strip((s.lines || []).join('') || s.text) }))
  const r = await chatJSONCached({ prompt: promptFor(input, maxChars), ...taskCall('cutter', { maxTokens: 1200 }) })
  if (!r.ok) {
    log('段落标题：模型没接上（' + r.skipped + '），沿用原句')
    return { ok: false, skipped: r.skipped, detail: r.detail || null, titles: list.map(s => ({ index: s.index, text: s.text, source: 'rules' })), model: null }
  }

  const got = Array.isArray(r.value && r.value.titles) ? r.value.titles : []
  const used = new Set()
  let titles = validateBatch(list, got, maxChars, used)

  const rejected = titles.filter(t => t.asked && t.source === 'rules')
  let repairInfo = null
  if (repair && rejected.length) {
    const secs = rejected.map(t => list.find(s => s.index === t.index)).filter(Boolean)
    const fixInput = secs.map(s => ({ index: s.index, 秒: +((s.end - s.start)).toFixed(1), 原文: strip((s.lines || []).join('') || s.text) }))
    const fixPrompt = [
      '下面这几段的标题没过校验，原因在「不合格」里。只重写这几段，规则同前：',
      '6–8 个汉字、压缩成短语、字只能来自该段原文、结尾落在实词上、不许以「但是/所以/然后/就是」开头。',
      JSON.stringify(rejected.map((t, i) => ({ ...fixInput[i], 不合格: t.why, 上一版: t.asked })), null, 1),
      '只输出 JSON：{"titles":[{"index":1,"text":"6到8个字"}]}',
    ].join('\n')
    const r2 = await chatJSONCached({ prompt: fixPrompt, ...taskCall('cutter', { maxTokens: 700 }) })
    if (r2.ok) {
      const fixed = validateBatch(secs, Array.isArray(r2.value && r2.value.titles) ? r2.value.titles : [], maxChars, used)
      const byIndex = new Map(fixed.map(t => [t.index, t]))
      titles = titles.map(t => {
        const f2 = byIndex.get(t.index)
        return f2 && f2.source === 'model' ? f2 : t
      })
      const fixedCount = fixed.filter(f2 => f2.source === 'model').length
      repairInfo = { asked: rejected.length, fixed: fixedCount }
      log('段落标题：打回 ' + rejected.length + ' 条（' + rejected.map(t => t.why).slice(0, 2).join('；') + '），重写后补上 ' + fixedCount + ' 条')
    } else {
      log('段落标题：重写没接上（' + r2.skipped + '），这几段沿用原句')
    }
  }

  const modelCount = titles.filter(t => t.source === 'model').length
  log('段落标题：模型给了 ' + got.length + ' 条，采纳 ' + modelCount + ' / ' + list.length + ' 条' +
    (modelCount < list.length ? '，其余沿用原句' : ''))
  return { ok: true, model: r.model, ms: r.ms, tokens: r.tokens, titles, stats: { asked: got.length, adopted: modelCount, total: list.length, repaired: repairInfo } }
}
