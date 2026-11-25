/**
 * 多路网关自检：一条产线怎么同时连两家模型服务，而不把规则和证据一起换掉。
 *
 * 起因（2026-11-25 接 Opus 5.5）：用户给了一个外部网关，只要求「提案侧换强一点」。
 * 但两家服务的三处差异会立刻把人绊倒，而且都是**静默**的：
 *   · temperature 只有 1 才许给（给 0 直接 400）；
 *   · 没有 vLLM 的 enable_thinking 字段；
 *   · 思考与回答共用 max_tokens——任务要 1200 的输出，思考能把它吃光，返回空 content。
 * 前两条会报错，第三条不报错：整句删会「模型没接上」然后悄悄退回规则排序，片子照样出，
 * 只是换了模型等于白换。所以三条都要有离线断言钉住。
 *
 * 断言分三组：路由怎么解析、请求体怎么裁、配置接线有没有漏。
 *   node scripts/check-routes.mjs
 */
import { LLM, resolveModel, requestBody, modelLabel, llmStatus, taskCall, shouldRetryEmpty } from '../src/llm.mjs'
import { proposalKey } from '../src/proposal-cache.mjs'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }

// ── 1) 路由解析：模型名自带网关 ──
// 用注入的假路由，不读本机 config/llm.local.json——离线断言不许依赖某台机器的凭证。
const R = {
  far: { base: 'https://far.example/v1', key: 'KEY-FAR', models: {}, noTemperature: true, noThinkingFlag: true, minTimeoutMs: 90000, minMaxTokens: 4000 },
  plain: { base: 'https://plain.example/v1', key: null, models: {}, noTemperature: false, noThinkingFlag: false },
  nobase: { key: 'X' },
}
const t1 = resolveModel('far:opus-5-5', R)
ok('带前缀的模型名走那家网关', t1.route === 'far' && t1.model === 'opus-5-5' && t1.base === 'https://far.example/v1', JSON.stringify(t1))
ok('路由自己的凭证优先于默认凭证', t1.key === 'KEY-FAR')
ok('路由的耐心下限跟着名字走', t1.minTimeoutMs === 90000 && t1.minMaxTokens === 4000)
const t2 = resolveModel('opus-5-5', R)
ok('不带前缀就走默认网关（老路径不变）', t2.route === null && t2.base === LLM.base && t2.model === 'opus-5-5')
const t3 = resolveModel('nope:opus-5-5', R)
ok('不认识的网关名不静默改道（整串当模型名）', t3.route === null && t3.model === 'nope:opus-5-5' && t3.base === LLM.base)
const t4 = resolveModel('far:', R)
ok('只有前缀没有模型名也不改道', t4.route === null && t4.model === 'far:')
const t5 = resolveModel('nobase:opus', R)
ok('没写 base 的路由不算路由', t5.route === null && t5.model === 'nobase:opus')
ok('空模型名退回默认模型', resolveModel('', R).model === LLM.model)

// ── 2) 请求体：哪些字段能给、哪些绝不能给 ──
const msgs = [{ role: 'user', content: 'hi' }]
const strict = requestBody({ target: t1, messages: msgs, maxTokens: 1200, temperature: 0, thinking: false })
ok('不许温度的网关不塞 temperature（给了会 400）', !('temperature' in strict))
ok('不许温度的网关不塞 enable_thinking（不是它的字段）', !('enable_thinking' in strict))
ok('思考下限抬得比任务预算高（留出思考空间）', strict.max_tokens === 4000, String(strict.max_tokens))
const loose = requestBody({ target: t2, messages: msgs, maxTokens: 1200, temperature: 0, thinking: false })
ok('普通网关照旧钉温度 0（纠错和选句要可复现）', loose.temperature === 0)
ok('普通网关照旧关思考（思考烧光预算会返回空）', loose.enable_thinking === false)
ok('任务没给思考下限时预算照旧', loose.max_tokens === 1200, String(loose.max_tokens))
const thinkOn = requestBody({ target: t2, messages: msgs, thinking: true })
ok('开了思考就不再发关闭标记', !('enable_thinking' in thinkOn))
const withTools = requestBody({ target: t2, messages: msgs, tools: [{ type: 'function', function: { name: 'f' } }] })
ok('工具表照常传（bot 只能调工具，不能自己写时间码）', Array.isArray(withTools.tools) && withTools.tool_choice === 'auto')
ok('没有工具时不塞空的 tools 键', !('tools' in requestBody({ target: t2, messages: msgs })))
// 网关方言（如 Anthropic 的 output_config.effort）原样带过去，但不许改产线的硬约束
const withExtra = resolveModel('far:opus', { far: { base: 'https://far.example/v1', extraBody: { output_config: { effort: 'low' }, model: 'evil', max_tokens: 9, messages: 'x' } } })
const eb = requestBody({ target: withExtra, messages: msgs, maxTokens: 1200, temperature: 0 })
ok('路由方言字段原样带过去', eb.output_config && eb.output_config.effort === 'low', JSON.stringify(eb.output_config))
ok('方言不能改模型、预算和消息（硬约束）', eb.model === 'opus' && eb.max_tokens === 1200 && Array.isArray(eb.messages), eb.model + '/' + eb.max_tokens)

// ── 2b) 空正文重试：只有「思考烧光预算」这一种才重试，别的空就是空 ──
const burn = { ok: false, skipped: 'empty', finishReason: 'length' }
ok('思考烧光预算（finish=length）时重试一次', shouldRetryEmpty(burn, t1) === true)
ok('别的原因空着就不重试（finish=stop 是真没话说）', shouldRetryEmpty({ ok: false, skipped: 'empty', finishReason: 'stop' }, t1) === false)
ok('普通网关照旧不重试（行为不变）', shouldRetryEmpty(burn, t2) === false)
ok('成功的结果不重试', shouldRetryEmpty({ ok: true }, t1) === false)

// ── 3) 接线：名册、缓存指纹、报错里不出现密钥 ──
const label = modelLabel('cutter')
ok('名册显示的是模型名，不带网关前缀', !String(label).includes(':'), String(label))
const keyA = proposalKey({ prompt: 'p', model: 'far:opus-5-5' })
const keyB = proposalKey({ prompt: 'p', model: 'opus-5-5' })
ok('缓存指纹认模型全名：换网关等于换问题，不会命中旧答案', keyA !== keyB)
ok('默认网关的调用也用默认凭证', String(resolveModel('qwen3.8-max').key) === 'null' || resolveModel('qwen3.8-max').key === null)
const status = JSON.stringify(llmStatus())
ok('状态里不出现密钥（含路由的）', !/sk[-_][A-Za-z0-9_-]{12}/.test(status), status.slice(0, 120))
const smart = String(LLM.models.smart || '')
const hasRoute = smart.includes(':')
ok('smart 配成路由时，解析结果和名字里的前缀一致', !hasRoute || resolveModel(smart).route === smart.split(':')[0], smart)
ok('剪辑的产线调用用的就是 smart 那一档', taskCall('cutter').model === LLM.models.smart, taskCall('cutter').model)

if (fails.length) {
  console.log('路由自检 ' + pass + '/' + (pass + fails.length) + ' 通过，失败：')
  for (const f of fails) console.log('  × ' + f)
  process.exit(1)
}
console.log('路由自检 ' + pass + '/' + pass + ' 通过（解析 8 / 请求体 11 / 重试 4 / 接线 6）')
