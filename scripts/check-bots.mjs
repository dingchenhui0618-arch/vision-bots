/**
 * 每个 bot 各自一份配置：自检。
 *
 * 这个脚本不碰真配置——用 VISION_BOTS_CONFIG_DIR 指到临时目录再 import。
 * 六件事：四份配置都读得到、模型别名解析成真名、改一个 bot 不影响另一个、
 * 写坏的字段退回默认并报出来、环境变量能覆盖单个 bot、agent 循环真的用上了这份配置。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'bots-cfg-'))
process.env.VISION_BOTS_CONFIG_DIR = dir
let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name) } }

const write = (name, obj) => writeFileSync(join(dir, name + '.json'), typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')

const mod = await import('../src/bots/config.mjs')
const llm = await import('../src/llm.mjs')
const { BOTS } = await import('../src/bots/roster.mjs')

// ── 1. 目录里什么都没有：四个 bot 都能用默认值起来
mod.resetBotConfig()
const all0 = mod.allBotConfigs()
ok(all0.length === 4, '四个 bot 都有一份配置（文件缺失时用默认值）')
ok(all0.every(c => c.source === 'default'), '缺文件时来源标成 default，不假装读过文件')
ok(all0.every(c => llm.callProfile(c.id).model), '四个 bot 都能解析出真实模型名')
ok(llm.callProfile('producer').temperature === null, '制片人没钉温度（用服务端默认）')
ok(llm.callProfile('cutter').temperature === 0, '剪辑钉温度 0（同一素材两次决策一致）')

// ── 2. 只给剪辑一份文件：别的 bot 不受影响
mod.resetBotConfig()
write('cutter', { model: 'gpt-test-cutter', temperature: 0.3, maxSteps: 3, params: { gap: { comma: 0.4 } } })
const cut = mod.botConfig('cutter'), pack = mod.botConfig('packer')
ok(cut.model === 'gpt-test-cutter', '剪辑读到自己的模型名')
ok(cut.source === 'file', '剪辑来源标成 file')
ok(pack.model === 'fast' && pack.source === 'default', '包装没被剪辑的文件影响（还是默认）')
ok(llm.callProfile('cutter').model === 'gpt-test-cutter', '别名/全名都能解析')
ok(llm.callProfile('cutter').temperature === 0.3 && llm.callProfile('cutter').maxSteps === 3, '采样和步数来自剪辑自己那份')
ok(mod.paramsOf('cutter').gap.comma === 0.4 && mod.paramsOf('cutter').gap.period === 0.3, 'params 深合并：改一个键不丢其他键')

// ── 3. 写坏的字段：退回默认并报出来，不让整条片子停
mod.resetBotConfig()
write('qc', { model: 42, temperature: 9, maxSteps: 'many', typoKey: 1 })
const qc = mod.botConfig('qc')
ok(qc.model === 'fast', 'model 类型不对退回默认')
ok(qc.temperature === 0 && qc.maxSteps === 6, 'temperature / maxSteps 越界退回默认')
const probs = mod.configProblems()
ok(probs.some(p => p.includes('model')), '报出 model 那条问题')
ok(probs.some(p => p.includes('temperature')), '报出 temperature 那条问题')
ok(probs.some(p => p.includes('typoKey')), '不认识的字段也报出来（静默吞掉才是坑）')

// ── 4. 整份 JSON 坏了：用默认值，并说清是哪份
mod.resetBotConfig()
write('packer', '{ this is not json')
const pk = mod.botConfig('packer')
ok(pk.source === 'default' && pk.model === 'fast', 'JSON 解析失败时用默认值')
ok(mod.configProblems().some(p => p.includes('packer.json')), '说清是 packer.json 解析不了')

// ── 5. 环境变量只覆盖单个 bot
mod.resetBotConfig()
process.env.VISION_BOTS_CUTTER_MODEL = 'env-model'
process.env.VISION_BOTS_CUTTER_TEMPERATURE = '0.7'
ok(llm.callProfile('cutter').model === 'env-model', '环境变量覆盖剪辑的模型')
ok(llm.callProfile('cutter').temperature === 0.7, '环境变量覆盖剪辑的温度')
ok(llm.callProfile('producer').model !== 'env-model', '制片人没被带跑')
mod.resetBotConfig()
process.env.VISION_BOTS_CUTTER_TEMPERATURE = 'hot'
ok(llm.callProfile('cutter').temperature === 0.3, '非法环境变量值忽略，仍用配置文件里的 0.3（不是退回默认）')
delete process.env.VISION_BOTS_CUTTER_MODEL
delete process.env.VISION_BOTS_CUTTER_TEMPERATURE

// ── 6. agent 循环真的用上了这份配置（不是只读不用）
mod.resetBotConfig()
write('producer', { model: 'gpt-producer-test', temperature: 0.2, maxSteps: 1, maxTokens: 321 })
mod.resetBotConfig()
const { runAgent } = await import('../src/agent/loop.mjs')
const seen = []
const chatFn = async (args) => {
  seen.push(args)
  return { ok: true, content: '', toolCalls: [{ id: 'c' + seen.length, function: { name: 'noop', arguments: '{}' } }] }
}
const session = { notes: [], tail: () => [], push: () => {} }
const bot = { id: 'producer', name: '制片人', role: 'r', voice: 'v' }
const tools = [{ name: 'noop', label: 'noop', description: 'd', parameters: { type: 'object', properties: {} }, run: () => ({ n: 1 }) }]
const out = await runAgent({ session, bot, task: '试一下', tools, chatFn, profile: llm.callProfile('producer') })
ok(seen[0].model === 'gpt-producer-test', '模型传到了模型调用')
ok(seen[0].temperature === 0.2, '温度传到了模型调用')
ok(seen[0].maxTokens === 321, 'token 预算传到了模型调用')
ok(seen.length === 1 && out.skipped === 'step-limit', '步数上限来自这个 bot 的配置（1 步就停）')

// 这次调用的临时覆盖要压过配置（只说一句话时用）
seen.length = 0
await runAgent({ session, bot, task: '只说一句', tools, chatFn, profile: llm.callProfile('producer'), maxSteps: 2, maxTokens: 500 })
ok(seen.length === 2 && seen[0].maxTokens === 500, '单次调用的覆盖压过配置')

rmSync(dir, { recursive: true, force: true })
console.log('')
if (fail) { console.log('FAIL  ' + pass + ' 条通过，' + fail + ' 条不通过'); process.exit(1) }
console.log('PASS  ' + pass + ' 条全过（每 bot 独立配置 / 坏配置退回默认 / 环境变量覆盖 / 循环真的用上）')
