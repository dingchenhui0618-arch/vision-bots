/**
 * 制片人读需求的自检：时长解析、规则兜底、模型字段校验、用户原话优先、模板理由。
 * 全部离线跑——模型的输出用固定样本喂进来，不联网也能验「哪些话能信、哪些要拦」。
 */
import { ruleBrief, ruleDuration, ruleRatio, ruleHasScript, mergeBrief, understand, whyText, templateLine, cleanTemplate, cleanRatio, cleanPlatform, cleanDuration } from '../src/brief.mjs'
import { templateById, specOf } from '../src/bots/roster.mjs'

let pass = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  fails.push(name + (detail ? '：' + detail : ''))
}

// ── 1. 时长：中国人说话不会只说阿拉伯数字 ──
const D = [
  ['发抖音，40秒', 40],
  ['四十秒左右', 40],
  ['大概一分半', 90],
  ['两分钟够了', 120],
  ['半分钟就行', 30],
  ['别超过一分钟', 60],
  ['1.5分钟', 90],
  ['三分钟', 180],
  ['九十秒', 90],
  ['没说多长', null],
]
for (const [text, want] of D) ok('时长 · ' + text, ruleDuration(text) === want, String(ruleDuration(text)))

// ── 2. 规则兜底：模型没接上时走的就是这条，和接模型之前一个行为 ──
const r1 = ruleBrief('发抖音，20秒，用光轨')
ok('规则 · 三字段', r1.platform === '抖音' && r1.ratio === '9:16' && r1.duration === 20 && r1.template === 'lighttrail', JSON.stringify(r1))
const r2 = ruleBrief('随便发发')
ok('规则 · 全默认', r2.platform === '视频号' && r2.ratio === '9:16' && r2.duration === 60 && r2.template === 'subtitle-only', JSON.stringify(r2))
ok('规则 · 没有稿子不能被读成有稿', ruleHasScript('我没有稿子') === false)
ok('规则 · 有稿在桌面', ruleHasScript('有稿子在桌面') === true)
ok('规则 · 没提稿子就不表态', ruleHasScript('发抖音') === null)
ok('规则 · 竖屏', ruleRatio('竖屏发就行') === '9:16' && ruleRatio('横屏') === '16:9' && ruleRatio('随便') === null)

// ── 3. 用户明说的，模型改不掉（并把这次读岔记下来）──
const MODEL_BAD = { platform: '抖音', ratio: '3:4', durationSec: 45, template: 'ppt-base', templateWhy: '口播为主', hasScript: true }
const m1 = mergeBrief({ text: '发视频号，四十秒左右，用光轨，我没稿子，竖屏', model: MODEL_BAD })
const b1 = m1.brief
ok('合 · 平台听用户的', b1.platform === '视频号' && b1.src.platform === 'user', b1.platform)
ok('合 · 画幅听用户的', b1.ratio === '9:16' && b1.src.ratio === 'user', b1.ratio)
ok('合 · 时长听用户的', b1.duration === 40 && b1.src.duration === 'user', String(b1.duration))
ok('合 · 模板听用户的', b1.template === 'lighttrail' && b1.src.template === 'user', b1.template)
ok('合 · 稿子听用户的', b1.hasScript === false && b1.src.hasScript === 'user')
ok('合 · 四处读岔都记了', m1.corrected.length === 4, JSON.stringify(m1.corrected))
ok('合 · 记了是哪一步', /模型记成「抖音」/.test(m1.corrected.join(' ')) && /模型记成 3:4/.test(m1.corrected.join(' ')), m1.corrected.join(' '))
// 40s 对 45s 差 12.5%，在「左右」的容差内，不算读岔，不弹出一句废话
ok('合 · 在容差内不算读岔', !m1.corrected.some(c => /时长/.test(c)), m1.corrected.join(' '))
const m1b = mergeBrief({ text: '四十秒左右，发抖音', model: { durationSec: 90 } })
ok('合 · 差太多才改回来', m1b.brief.duration === 40 && /模型记成 90s/.test(m1b.corrected.join(' ')), m1b.corrected.join(' '))
ok('合 · 用户都说全了就没有替我定的', m1.assumed.length === 0, JSON.stringify(m1.assumed))

// ── 4. 用户没说的，模型补上，但要标来源 ──
const m2 = mergeBrief({ text: '你看着办', model: { platform: '小红书', ratio: '3:4', durationSec: 45, template: 'lighttrail', templateWhy: '口播密度高', hasScript: false } })
ok('合 · 模型补平台', m2.brief.platform === '小红书' && m2.brief.src.platform === 'model')
ok('合 · 模型补时长', m2.brief.duration === 45 && m2.brief.src.duration === 'model')
ok('合 · 记下替我定了什么', m2.assumed.join(',') === '平台 小红书,画幅 3:4,时长 45s,没稿直接口播', m2.assumed.join(','))

// ── 5. 模型给的字段不合法就退回：模板、画幅、平台、时长 ──
ok('校验 · 不认识的模板', cleanTemplate('cinematic-4k') === null && cleanTemplate('光轨') === 'lighttrail' && cleanTemplate('lighttrail') === 'lighttrail')
ok('校验 · 不认识的画幅', cleanRatio('横向') === null && cleanRatio('9：16') === '9:16' && cleanRatio('9x16') === '9:16')
ok('校验 · 不认识的平台', cleanPlatform('YouTube') === null && cleanPlatform('抖音') === '抖音')
ok('校验 · 时长越界夹住', cleanDuration(9999) === 300 && cleanDuration(3) === 8 && cleanDuration('abc') === null)
const m3 = mergeBrief({ text: '发个片子', model: { platform: 'YouTube', ratio: '横向', durationSec: '不清楚', template: 'cinematic-4k', templateWhy: '', hasScript: 'yes' } })
ok('校验 · 全非法就全默认', m3.brief.platform === '视频号' && m3.brief.ratio === '9:16' && m3.brief.duration === 60 && m3.brief.template === 'subtitle-only' && m3.brief.hasScript === false, JSON.stringify(m3.brief))
ok('校验 · 来源标成默认', Object.values(m3.brief.src).every(v => v === 'default'), JSON.stringify(m3.brief.src))

// ── 6. 模型没返回 / 返回不是对象 ──
const m4 = mergeBrief({ text: '发抖音', model: null })
ok('合 · 没模型也能定', m4.brief.platform === '抖音' && m4.brief.src.platform === 'user' && m4.brief.src.duration === 'default')
const m5 = mergeBrief({ text: '发抖音', model: ['not', 'an', 'object'] })
ok('合 · 数组当没给', m5.brief.src.duration === 'default')
const m6 = mergeBrief({ text: '三十秒，抖音', model: { durationSec: 30, platform: '抖音' } })
ok('合 · 模型和用户一致就不啰嗦', m6.corrected.length === 0, JSON.stringify(m6.corrected))

// ── 7. 接入：认识这个对象，模型挂了也不抛 ──
const u1 = await understand({ text: '发抖音，三十秒，用光轨', askModel: false })
ok('接入 · 关掉模型走规则', u1.meta.skipped === 'off' && u1.brief.duration === 30 && u1.brief.template === 'lighttrail')
const u2 = await understand({ text: '发抖音，三十秒', call: async () => ({ ok: false, skipped: 'timeout', ms: 12 }) })
ok('接入 · 超时退回规则', u2.meta.skipped === 'timeout' && u2.brief.duration === 30 && u2.brief.platform === '抖音')
const u3 = await understand({ text: '发抖音，三十秒', call: async () => ({ ok: false, skipped: 'bad-json' }) })
ok('接入 · 不是 JSON 也退回规则', u3.meta.skipped === 'bad-json' && u3.brief.duration === 30)
const u4 = await understand({ text: '发抖音', call: async () => ({ ok: true, value: { platform: '抖音', ratio: '9:16', durationSec: 45, template: 'lighttrail', templateWhy: '逐帧字幕节奏', hasScript: false }, ms: 3400, tokens: 300, model: 'fake' }) })
ok('接入 · 模型通了就用模型的判断', u4.brief.template === 'lighttrail' && u4.brief.duration === 45 && u4.meta.ms >= 0 && u4.meta.skipped === null, JSON.stringify(u4.brief.src))

// ── 8. 模板为什么：他点名的 / 推荐 / 默认，三种说法不能混 ──
const U = { platform: '视频号', ratio: '9:16', duration: 60, template: 'lighttrail', hasScript: false, templateWhy: null, src: { template: 'user' } }
ok('理由 · 他点名的', /光轨，你点名要的/.test(templateLine(U)), templateLine(U))
ok('理由 · 推荐带模型的理由', /^推荐模板：光轨 · 逐帧字幕节奏$/.test(templateLine({ ...U, templateWhy: '逐帧字幕节奏', src: { template: 'model' } })), templateLine({ ...U, templateWhy: '逐帧字幕节奏', src: { template: 'model' } }))
ok('理由 · 默认要说没指定', /你没指定/.test(templateLine({ ...U, template: 'subtitle-only', src: { template: 'default' } })))
ok('理由 · 卡片上不带前缀', !/^推荐模板/.test(whyText({ ...U, templateWhy: 'x', src: { template: 'model' } })), whyText({ ...U, templateWhy: 'x', src: { template: 'model' } }))

// ── 9. 模板没做的画幅：不能静默改，得标出来 ──
const spec = specOf(templateById('ppt-base'), '16:9')
ok('画幅 · 不支持的要说出来', spec.unsupported === true && spec.asked === '16:9' && spec.ratio === '3:4', JSON.stringify(spec))

const total = pass + fails.length
if (fails.length) {
  console.log('FAIL · ' + fails.length + '/' + total + ' 条没过')
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('PASS · ' + total + ' 条全过（时长 10 / 规则 6 / 用户优先 10 / 模型补位 3 / 没模型 3 / 校验 6 / 接入 4 / 模板理由 4 / 画幅 1）')
}
