/**
 * bot 是 agent 这件事的离线自测：不联网，不碰真素材。
 * 验的是三条硬规矩，和「四个 bot 是不是真的同一套能力、各自的会话」。
 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Group } from '../src/core/group.mjs'
import { BotSession } from '../src/agent/session.mjs'
import { FactBook } from '../src/agent/facts.mjs'
import { runAgent, buildSystem } from '../src/agent/loop.mjs'
import { Director } from '../src/agent/director.mjs'
import { toolsFor } from '../src/agent/tools.mjs'
import { BOTS, byId } from '../src/bots/roster.mjs'
import { callProfile } from '../src/llm.mjs'

const ROOT = join(process.cwd(), '.test', 'agent-tmp')
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })

let pass = 0, fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name) }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) }
}
const group = name => {
  const g = Group.create(ROOT, name)
  g.meta.template = 'subtitle-only'
  g.meta.assets = []
  g.save()
  return g
}

// ── 1. 事实表：编的数字必须被拦住 ──
console.log('\n[1] 事实表')
{
  const b = new FactBook('t')
  b.addAll({ outSec: 68.4, frames: 2052, sections: 10 }, 'pack')
  ok('工具返回的数算有出处', b.check('成片 68.4s，2052 帧，10 段').ok)
  ok('四舍五入到整数算有出处', b.check('成片 68s').ok)
  ok('编出来的数被拦', !b.check('成片 70.2s').ok)
  ok('半格以内不算编（68.4→68）', b.check('68').ok)
  ok('按位数四舍五入算有出处（24.93→24.9）', new FactBook().add(24.93).check('24.9s').ok)
  ok('差一位小数就是编（24.93→24.8）', !new FactBook().add(24.93).check('24.8s').ok)
  ok('17.04→17.0 算有出处', new FactBook().add(17.04).check('17.0s').ok)
  ok('改大超过半格算编（68.4→69）', !b.check('69').ok)
  const r = b.check('渲染 300 秒，编了 3 章')
  ok('违规数逐个列出来', r.bad.length === 2 && r.bad.map(x => x.raw).join(',') === '300,3', JSON.stringify(r.bad))
  ok('提示里点名这几个数', b.hint(r.bad).includes('300'))
}

// ── 2. 会话：长驻，落盘，能重建 ──
console.log('\n[2] 会话')
{
  const g = group('会话')
  const a = new BotSession(g, 'producer')
  a.push({ role: 'user', kind: 'user', content: '看看素材' })
  a.said('素材 24.9s，能剪 22s。')
  a.remember('目标时长', '用户要 60s，素材不够')
  const b = new BotSession(g, 'producer') // 重开 = 模拟 CLI 重启
  ok('说过的话落盘能重建', b.all.length === 2 && b.tail(1)[0].content.includes('22s'))
  ok('记忆落盘能重建', b.notes.length === 1 && b.notes[0].text.includes('60s'))
  b.remember('目标时长', '改主意了，要 45s')
  ok('同一个 key 覆盖，不留两份', b.notes.length === 1 && b.notes[0].text.includes('45s'))
  const c = new BotSession(g, 'cutter')
  ok('不同 bot 的会话互不干扰', c.all.length === 0)
  ok('会话存在群目录下', existsSync(join(g.dir, 'bots', 'producer', 'history.jsonl')))
}

// ── 3. 一轮循环：只能用工具、只能是真数 ──
console.log('\n[3] 一轮循环')
{
  const g = group('循环')
  const session = new BotSession(g, 'producer')
  const tools = [{
    name: 'inspect_project',
    description: '看项目',
    parameters: { type: 'object', properties: {} },
    run: () => ({ sourceSec: 24.9, targetSec: 60, gapSec: 35.1 }),
  }]
  const script = []
  const chatFn = async ({ messages }) => script.shift()(messages)

  // 3.1 先调工具，再说话，数字都对
  script.push(() => ({ ok: true, content: '', toolCalls: [{ id: 'c1', function: { name: 'inspect_project', arguments: '{}' } }] }))
  script.push(() => ({ ok: true, content: '素材 24.9s，目标 60s，差 35.1s。要 60s 得你补素材。', toolCalls: [] }))
  const r1 = await runAgent({ session, bot: byId('producer'), task: '看素材', tools, chatFn })
  ok('先调工具再说话', r1.ok && r1.used.length === 1)
  ok('说的话有出处就放行', r1.check.ok)
  session.push({ role: 'user', kind: 'user', content: '看素材' + '2' })

  // 3.2 编数字 → 被打回 → 重写通过
  let round = 0
  const chatFn2 = async ({ messages }) => {
    round++
    const isTool = messages.some(m => m.role === 'tool')
    if (!isTool) return { ok: true, content: '', toolCalls: [{ id: 'c2', function: { name: 'inspect_project', arguments: '{}' } }] }
    const told = messages.some(m => m.role === 'user' && String(m.content).includes('没有出处'))
    if (!told) return { ok: true, content: '渲染只用 12 秒，特别快。', toolCalls: [] }
    return { ok: true, content: '素材 24.9s，目标 60s。', toolCalls: [] }
  }
  const s2 = new BotSession(g, 'packer')
  const r2 = await runAgent({ session: s2, bot: byId('packer'), task: '说进度', tools, chatFn: chatFn2 })
  ok('编了数被打回重写', r2.ok && r2.check.ok && round === 3)
  ok('重写后的话是真的', r2.text.includes('24.9'))

  // 3.3 一直编 → 标出来交出去，不静默
  const chatFn3 = async ({ messages }) => {
    const isTool = messages.some(m => m.role === 'tool')
    if (!isTool) return { ok: true, content: '', toolCalls: [{ id: 'c3', function: { name: 'inspect_project', arguments: '{}' } }] }
    return { ok: true, content: '渲染 999 秒。', toolCalls: [] }
  }
  const s3 = new BotSession(g, 'qc')
  const r3 = await runAgent({ session: s3, bot: byId('qc'), task: '说进度', tools, chatFn: chatFn3 })
  ok('死不认账就标记为未落实', !r3.ok && r3.skipped === 'unverified-numbers')
  ok('标出来的数看得见', r3.text.includes('999') && r3.text.includes('没出处'))
}

// ── 4. 同一套工具、不同会话和不同配置：红线各自不同 ──
console.log('\n[4] 四个 bot 是一套工具代码的四个会话，配置各管各的')
{
  const g = group('名册')
  ok('模型不在名册里写死（各自在 config/bots/<id>.json）', BOTS.every(b => b.model === undefined))
  ok('四个 bot 各自解析出模型', BOTS.every(b => { const m = callProfile(b.id).model; return typeof m === 'string' && m.length > 0 }))
  ok('每个 bot 都有自己的红线', BOTS.every(b => Array.isArray(b.contract) && b.contract.length >= 3))
  const sp = buildSystem(byId('qc'), { notes: [{ key: 'k', text: 'v' }], context: '素材 24.9s' })
  ok('system 里有红线', sp.includes('红线') && sp.includes('没有证据不许判通过'))
  ok('system 里有它记得的事', sp.includes('你记得的事'))
  ok('system 里有项目现状', sp.includes('素材 24.9s'))

  const d = new Director(g, { brief: { duration: 60, template: 'subtitle-only', ratio: '9:16' }, state: {} })
  const pt = toolsFor('producer', { group: g, brief: d.brief, state: d.state, runner: d.runner, director: d })
  const ct = toolsFor('cutter', { group: g, brief: d.brief, state: d.state, runner: d.runner, director: d })
  ok('制片人有派活权', pt.some(t => t.name === 'dispatch_to'))
  ok('剪辑没有派活权（层级是代码定的）', !ct.some(t => t.name === 'dispatch_to'))
  ok('四个 bot 的工具不重样', new Set(BOTS.flatMap(b => b.tools)).size === BOTS.flatMap(b => b.tools).length)
  ok('会话各存一份', BOTS.every(b => d.session(b.id).dir.includes(join('bots', b.id))))
}

// ── 5. 交付硬门：没质检不许交 ──
console.log('\n[5] 交付硬门')
{
  const g = group('硬门')
  const d = new Director(g, { brief: {}, state: {} })
  const no = await d.deliver('交')
  ok('没跑质检不许交付', !no.ok && no.error.includes('质检'))
  d.state.report = { passed: false, checks: [{ id: 'a', ok: true }, { id: 'b', ok: false }] }
  const yes = await d.deliver('交')
  ok('质检跑过就能交（失败项如实带出来）', yes.ok && yes.failed.length === 1)
  const again = await d.deliver('再交一次')
  ok('不许重复交付', !again.ok && again.error.includes('交付过'))
}

// ── 6. 派活层数有上限，不会无限套 ──
console.log('\n[6] 派活层级')
{
  const g = group('层级')
  const d = new Director(g, { brief: {}, state: {} })
  d.depth = 3
  const r = await d.runBot('cutter', '干活')
  ok('层数太深直接停', !r.ok && String(r.error).includes('太深'))
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)