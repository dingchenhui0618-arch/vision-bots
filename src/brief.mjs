/**
 * 制片人接需求：模型读懂那句话，规则校验每一个字段。
 *
 * 分工是死的：模型只提判断（平台、画幅、时长、模板、有没有稿），能不能用由校验器说了算；
 * 用户原话里明确说了的，模型不许改——模型把「四十秒」记成 45s，最终卡片上还是 40s，并把这次改动记下来。
 * 每个字段都带来源（user / model / default）：群里要说清哪些是他说的，哪些是我替他定的。
 */
import { TEMPLATES, templateById } from './bots/roster.mjs'
import { chatJSON, LLM } from './llm.mjs'

export const PLATFORMS = ['视频号', '抖音', '小红书', 'B站', '快手']
const PLATFORM_HINT = /视频号|抖音|小红书|B站|快手/
/** 短视频平台都是竖屏优先；用户没说画幅时按平台默认。 */
export const PLATFORM_RATIO = { 抖音: '9:16', 视频号: '9:16', 小红书: '9:16', 快手: '9:16', B站: '9:16' }
const RATIOS = ['9:16', '3:4', '16:9']
const RATIO_HINT = [
  [/竖屏|竖版|9\s*[:：x×]\s*16|手机/, '9:16'],
  [/横屏|横版|16\s*[:：x×]\s*9|宽屏/, '16:9'],
  [/3\s*[:：x×]\s*4/, '3:4'],
]
const DURATION_RANGE = [8, 300]
const DEFAULT_DURATION = 60
const DEFAULT_PLATFORM = '视频号'
const DEFAULT_TEMPLATE = 'subtitle-only'

const clampDuration = n => Math.min(DURATION_RANGE[1], Math.max(DURATION_RANGE[0], Math.round(n)))

const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }

/** 中文数字转数值，只处理「几十、几百、十几」这类口播里会出现的写法。 */
export function cnNumber(s) {
  const t = String(s || '')
  if (/^\d+$/.test(t)) return Number(t)
  let total = 0
  let cur = 0
  for (const ch of t) {
    if (ch === '十') { cur = (cur || 1) * 10; total += cur; cur = 0 }
    else if (ch === '百') { cur = (cur || 1) * 100; total += cur; cur = 0 }
    else if (CN_DIGIT[ch] !== undefined) cur = CN_DIGIT[ch]
    else return NaN
  }
  return total + cur
}

/** 用户明说的时长（秒）；没说返回 null。阿拉伯数字和中文数字都认。 */
export function ruleDuration(text) {
  const s = String(text || '')
  const ar = s.match(/(\d+(?:\.\d+)?)\s*(分钟|分|秒钟|秒|min|s(?![a-z]))/i)
  if (ar) {
    const n = Number(ar[1])
    if (!Number.isFinite(n)) return null
    return /^分|min/i.test(ar[2]) ? Math.round(n * 60) : Math.round(n)
  }
  const cn = s.match(/([零一二两三四五六七八九十百]+|半)\s*(分钟|分|秒钟|秒)\s*(半)?/)
  if (cn) {
    const isMin = /^分/.test(cn[2])
    if (cn[1] === '半') return isMin ? 30 : 0
    const whole = cnNumber(cn[1])
    if (!Number.isFinite(whole)) return null
    let sec = isMin ? whole * 60 : whole
    if (cn[3] === '半') sec += isMin ? 30 : 0.5
    return Math.round(sec)
  }
  return null
}

export function rulePlatform(text) {
  const s = String(text || '')
  return (s.match(PLATFORM_HINT) || [])[0] || null
}

export function ruleRatio(text) {
  const s = String(text || '')
  for (const [re, r] of RATIO_HINT) if (re.test(s)) return r
  return null
}

export function ruleTemplate(text) {
  const s = String(text || '')
  if (/折光/.test(s)) return 'zheguang'
  if (/光轨/.test(s)) return 'lighttrail'
  if (/ppt|PPT|底座/.test(s)) return 'ppt-base'
  return null
}

export function ruleHasScript(text) {
  const s = String(text || '')
  // 先认「没稿」：「没有稿子」里也含「有稿」，顺序反了会把没稿读成有稿。
  if (/没稿|没有稿|无稿|不写稿|不要稿|直接口播|不排稿/.test(s)) return false
  if (/有稿|按稿|照稿|稿子.*(给|在|发)/.test(s)) return true
  return null
}

/** 只按规则定（模型没接上时走这条，行为和接模型之前一致）。 */
export function ruleBrief(text) {
  const platform = rulePlatform(text) || DEFAULT_PLATFORM
  return {
    platform,
    ratio: ruleRatio(text) || PLATFORM_RATIO[platform] || '9:16',
    duration: clampDuration(ruleDuration(text) ?? DEFAULT_DURATION),
    template: ruleTemplate(text) || DEFAULT_TEMPLATE,
    hasScript: ruleHasScript(text) ?? false,
  }
}

export function cleanPlatform(v) {
  const s = String(v ?? '').trim()
  if (PLATFORMS.includes(s)) return s
  if (/^(douyin|抖音)/i.test(s)) return '抖音'
  if (/^(xiaohongshu|小红书)/i.test(s)) return '小红书'
  if (/^(shipinhao|视频号|wechat)/i.test(s)) return '视频号'
  if (/^(bilibili|b站)/i.test(s)) return 'B站'
  if (/^kuaishou/i.test(s)) return '快手'
  return null
}

export function cleanRatio(v) {
  const s = String(v ?? '').replace(/\s+/g, '').replace(/[：xX×]/g, ':')
  if (RATIOS.includes(s)) return s
  return null
}

export function cleanTemplate(v) {
  const s = String(v ?? '').trim()
  if (!s) return null
  const t = TEMPLATES.find(x => x.id === s || x.name === s)
  return t && t.status === 'ready' ? t.id : null
}

export function cleanDuration(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return clampDuration(n)
}

/** 群聊里那一行：是他点名的、模型推荐的，还是我按默认替他定的，写法不一样。 */
export function templateLine(brief) {
  const tpl = templateById(brief.template)
  const name = tpl ? tpl.name : brief.template
  const own = tpl ? tpl.note : ''
  const src = (brief.src && brief.src.template) || 'default'
  if (src === 'user') return '模板：' + name + '，你点名要的' + (own ? ' · ' + own : '')
  if (src === 'model' && brief.templateWhy) return '推荐模板：' + name + ' · ' + brief.templateWhy
  return '推荐模板：' + name + (src === 'default' ? '，你没指定' : '') + (own ? ' · ' + own : '')
}

/** 模板理由：去掉换行，超过 40 字截断；空的返回 null。 */
export function cleanWhy(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return null
  return s.length > 40 ? s.slice(0, 40) : s
}

/**
 * 合：用户明说的 > 模型说的 > 默认值。
 * 模型和用户原话冲突时听用户的，并把这次冲突记进 corrected（群里要说明，不偷偷改）。
 */
export function mergeBrief({ text = '', model = null } = {}) {
  const m = model && typeof model === 'object' && !Array.isArray(model) ? model : null
  const assumed = []
  const corrected = []
  const src = {}

  // 平台
  let platform
  const up = rulePlatform(text)
  const mp = cleanPlatform(m && m.platform)
  if (up) {
    platform = up
    src.platform = 'user'
    if (mp && mp !== up) corrected.push('平台：你说「' + up + '」，模型记成「' + mp + '」，按你说的')
  } else if (mp) {
    platform = mp
    src.platform = 'model'
    assumed.push('平台 ' + mp)
  } else {
    platform = DEFAULT_PLATFORM
    src.platform = 'default'
    assumed.push('平台 ' + DEFAULT_PLATFORM)
  }

  // 画幅
  let ratio
  const ur = ruleRatio(text)
  const mr = cleanRatio(m && m.ratio)
  if (ur) {
    ratio = ur
    src.ratio = 'user'
    if (mr && mr !== ur) corrected.push('画幅：你说 ' + ur + '，模型记成 ' + mr + '，按你说的')
  } else if (mr) {
    ratio = mr
    src.ratio = 'model'
    assumed.push('画幅 ' + mr)
  } else {
    ratio = PLATFORM_RATIO[platform] || '9:16'
    src.ratio = 'default'
    assumed.push('画幅 ' + ratio + '（' + platform + ' 默认）')
  }

  // 时长
  let duration
  const ud = ruleDuration(text)
  const md = cleanDuration(m && m.durationSec)
  if (ud !== null && ud > 0) {
    duration = clampDuration(ud)
    src.duration = 'user'
    if (duration !== Math.round(ud)) corrected.push('时长：你说 ' + Math.round(ud) + 's，不在 ' + DURATION_RANGE[0] + '–' + DURATION_RANGE[1] + 's 里，按 ' + duration + 's 算')
    else if (md !== null && Math.abs(md - ud) > ud * 0.15) corrected.push('时长：你说 ' + Math.round(ud) + 's，模型记成 ' + md + 's，按你说的')
  } else if (md !== null) {
    duration = md
    src.duration = 'model'
    assumed.push('时长 ' + md + 's')
  } else {
    duration = DEFAULT_DURATION
    src.duration = 'default'
    assumed.push('时长 ' + DEFAULT_DURATION + 's')
  }

  // 模板
  let template
  const ut = ruleTemplate(text)
  const mt = cleanTemplate(m && m.template)
  if (ut) {
    template = ut
    src.template = 'user'
    if (mt && mt !== ut) corrected.push('模板：你点名要 ' + (templateById(ut) || {}).name + '，模型选了 ' + (templateById(mt) || {}).name + '，按你说的')
  } else if (mt) {
    template = mt
    src.template = 'model'
  } else {
    template = DEFAULT_TEMPLATE
    src.template = 'default'
  }

  // 有没有稿
  let hasScript
  const us = ruleHasScript(text)
  const ms = typeof (m && m.hasScript) === 'boolean' ? m.hasScript : null
  if (us !== null) {
    hasScript = us
    src.hasScript = 'user'
    if (ms !== null && ms !== us) corrected.push('稿子：你说' + (us ? '有稿' : '没稿') + '，模型记成' + (ms ? '有稿' : '没稿') + '，按你说的')
  } else if (ms !== null) {
    hasScript = ms
    src.hasScript = 'model'
    assumed.push(ms ? '按稿' : '没稿直接口播')
  } else {
    hasScript = false
    src.hasScript = 'default'
    assumed.push('没稿直接口播')
  }

  const why = cleanWhy(m && m.templateWhy)
  return {
    brief: {
      platform,
      ratio,
      duration,
      template,
      hasScript,
      templateWhy: why,
      templateWhySource: why ? 'model' : 'roster',
      assumed,
      corrected,
      src,
      banned: '',
      speed: 1,
    },
    assumed,
    corrected,
    src,
  }
}

/** 群里说模板为什么选它：他点名的就说他点名，模型给的就说模型给的，都没有就用模板自己的说明。 */
export function whyText(brief) {
  const tpl = templateById(brief.template)
  const name = tpl ? tpl.name : brief.template
  const own = tpl ? tpl.note : ''
  if (brief.src && brief.src.template === 'user') return name + '是你点名的' + (own ? '：' + own : '。')
  if (brief.templateWhy) return name + '：' + brief.templateWhy
  if (brief.src && brief.src.template === 'default') return '你没指定模板，先按 ' + name + ' 出' + (own ? '：' + own : '。')
  return name + (own ? '：' + own : '。')
}

const PROMPT = (text) => `你是短视频制片人，开工前把用户这句话定成一条片子的交付规格。

可选模板（id / 名字 / 支持的画幅 / 时长区间 / 说明）：
${TEMPLATES.map(t => '- ' + t.id + ' / ' + t.name + ' / ' + Object.keys(t.ratios || {}).join('、') + ' / ' + ((t.spec && t.spec.duration) || []).join('-') + 's / ' + t.note).join('\n')}

用户说的：${String(text || '').trim()}

输出 JSON，字段：
{"platform":"视频号|抖音|小红书|B站|快手","ratio":"9:16|3:4|16:9","durationSec":整数秒,"template":"模板 id","templateWhy":"不超过 30 字，说清这个模板为什么适合这条素材","hasScript":true|false}

规矩：
1. 用户明确说了的（平台、时长、画幅、模板、有没有稿），原样照抄，不许改，更不许为了迁就模板的时长区间改数字。
2. 用户没说到的，按最省事的默认值定：平台 视频号，时长 60 秒，画幅按平台（短视频 9:16）。
3. templateWhy 只说这条素材为什么用这个模板，不要复述参数，不要写「根据用户需求」这类空话。
只输出 JSON，不要其他文字。`

/**
 * 主入口：模型读需求 + 规则校验。
 * askModel=false 或模型没接上时，退化成纯规则（和接模型之前的行为一致），并把原因带出来。
 */
export async function understand({ text = '', askModel = true, call = chatJSON, timeoutMs = 15000 } = {}) {
  const t0 = Date.now()
  if (!askModel) {
    const merged = mergeBrief({ text, model: null })
    return { brief: merged.brief, meta: { model: null, skipped: 'off', ms: Date.now() - t0, tokens: null } }
  }
  const r = await call({ prompt: PROMPT(text), maxTokens: 500, timeoutMs, model: LLM.models.smart })
  const merged = mergeBrief({ text, model: r.ok ? r.value : null })
  return {
    brief: merged.brief,
    meta: {
      model: r.ok ? r.model : null,
      skipped: r.ok ? null : (r.skipped || 'bad-json'),
      detail: r.ok ? null : (r.detail || null),
      ms: Date.now() - t0,
      tokens: r.ok ? r.tokens ?? null : null,
    },
  }
}
