/**
 * 接线自检：产线里每一次模型调用，到底听谁的。
 *
 * 这一层不是测模型好坏，是测「配置有没有落到执行上」。自测 19–21 的根因之一就在这里：
 * config/bots/<id>.json 写着「剪辑 smart、温度 0」，可分镜、大字、整句删、错字治理、语义审读
 * 全部硬写 LLM.models.fast、不传温度——声明是声明，产线是产线，两句空话。
 * 后果有两个，都实测到了：
 *   · 同一素材五次跑，分镜 13/9/9/11/12 段、整句删时有时无（温度用了服务端默认）；
 *   · 客户把剪辑换成更强的模型（接 Opus），改字和选句这些真决定成败的调用根本没换。
 *
 * 断言分三组：调用参数怎么合（纯函数）、证据对怎么配、每个模块的调用点是不是真走了配置。
 *   node scripts/check-routing.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LLM, taskCall, pairFor } from '../src/llm.mjs'
import { proposerCall } from '../src/asr-fix.mjs'

const ROOT = process.cwd()
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }
const src = f => readFileSync(join(ROOT, 'src', f), 'utf8')

// ── 1) 参数怎么合 ──
const cutter = taskCall('cutter')
const packer = taskCall('packer')
const qc = taskCall('qc')
const prod = taskCall('producer')
ok('剪辑的产线调用用剪辑的模型', cutter.model === LLM.models.smart, cutter.model)
ok('剪辑的温度钉 0', cutter.temperature === 0, String(cutter.temperature))
ok('包装的产线调用用包装的模型', packer.model === LLM.models.fast, packer.model)
ok('质检的模型和温度都听质检配置', qc.model === LLM.models.fast && qc.temperature === 0, qc.model + '/' + qc.temperature)
ok('制片人的温度留空（服务端默认，不要求逐字复现）', prod.temperature === null, String(prod.temperature))
ok('任务自己要的 token 预算说了算', taskCall('packer', { maxTokens: 2400 }).maxTokens === 2400, String(taskCall('packer', { maxTokens: 2400 }).maxTokens))
ok('任务没给就用 bot 的 token 预算', packer.maxTokens === 700, String(packer.maxTokens))
ok('任务自己要的超时说了算（读需求只等 15 秒）', taskCall('producer', { timeoutMs: 15000 }).timeoutMs === 15000, String(taskCall('producer', { timeoutMs: 15000 }).timeoutMs))
ok('任务没给就用 bot 的耐心', packer.timeoutMs === 90000, String(packer.timeoutMs))
ok('每次调用都记着是哪个 bot 的', cutter.bot === 'cutter' && packer.bot === 'packer')

// ── 2) 证据对：提案一只模型，第二意见必须是另一只 ──
const M = { fast: 'F', smart: 'S' }
ok('提案是 smart 时第二意见退到 fast', pairFor('S', M).auditor === 'F' && pairFor('S', M).distinct === true)
ok('提案是 fast 时第二意见用 smart', pairFor('F', M).auditor === 'S' && pairFor('F', M).distinct === true)
ok('两只撞成同一只时明确说凑不出第二意见', pairFor('X', { fast: 'X', smart: 'X' }).distinct === false)
ok('提案模型不被改写', pairFor('S', M).primary === 'S')
const pair = proposerCall()
ok('错字治理的提案跟剪辑配置走', pair.primary === cutter.model, pair.primary)
if (LLM.models.fast !== LLM.models.smart) {
  ok('错字治理的第二意见和提案不是同一只', pair.auditor !== pair.primary && pair.distinct === true, pair.primary + ' / ' + pair.auditor)
}

// ── 3) 接线：这几个模块的调用点必须走 taskCall，不许再硬写模型 ──
const WIRED = [
  ['prune.mjs', 'cutter', '整句删（内容预算）'],
  ['shots.mjs', 'cutter', '分镜'],
  ['headlines.mjs', 'cutter', '段落大字'],
  ['section-titles.mjs', 'cutter', '段落标题'],
  ['asr-fix.mjs', 'cutter', '错字治理'],
  ['qa-semantic.mjs', 'qc', '语义审读'],
  ['brief.mjs', 'producer', '读需求'],
]
for (const [f, bot, label] of WIRED) {
  let s = ''
  try { s = src(f) } catch { fails.push(label + '：读不到 src/' + f); continue }
  ok(label + '走 ' + bot + ' 的配置', s.includes("taskCall('" + bot + "'"), f)
  ok(label + '没有硬写模型', !/model:\s*LLM\.models\./.test(s), f)
}
// 证据层的温度恒 0：三条 chat 调用（整句 / 逐词 / 字数回问）一处都不许跟配置抖
{
  const s = src('asr-fix.mjs')
  const n = (s.match(/temperature: 0/g) || []).length
  ok('错字治理的证据层温度恒 0', n >= 2, n + ' 处')
  ok('错字治理没有把温度交给配置', !/temperature:\s*[a-zA-Z_]+\.temperature/.test(s))
}

console.log('接线自检：' + pass + ' 通过，' + fails.length + ' 失败')
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
