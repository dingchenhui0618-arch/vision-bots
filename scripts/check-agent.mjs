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
import { toolsFor, spotFacts } from '../src/agent/tools.mjs'
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
  // 质检得有一只能「查某一秒」的手（自测27：被追问 27.5s / 31.3s 时它只能说「证不出来」，然后按红线判不通过，
  // 而同一份报告里那两个点明明有记录——报告 19/19、群里「低置信词不通过」，用户看到的是自相矛盾）
  const qt = toolsFor('qc', { group: g, brief: d.brief, state: d.state, runner: d.runner, director: d })
  ok('质检有 explain_spot（被追问某一秒时能取证）', qt.some(t => t.name === 'explain_spot'), qt.map(t => t.name).join(','))
  ok('别的 bot 没有 explain_spot（工具不重样）', BOTS.filter(b => b.id !== 'qc').every(b => !b.tools.includes('explain_spot')))
}

// ── 4b. explain_spot：某一秒的证据（纯函数，用自测27 的真实数字当夹具）──
console.log('\n[4b] 查某一秒')
{
  const words = [
    { w: '为什么', start: 27.02, end: 27.22, p: 0.995 },
    { w: '因为', start: 27.5, end: 27.74, p: 0.565 },
    { w: '现在', start: 27.74, end: 28.1, p: 0.985 },
    { w: 'G', start: 31.28, end: 31.56, p: 0.424 },
    { w: '些', start: 10.42, end: 10.52, p: 0.104 },
  ]
  const fixReport = {
    relisten: { spans: [
      { span: [3.64, 5.92], agree: true, confirmed: true, text: '今天大家都在卷AI技术' },
      { span: [36.9, 39.94], agree: true, confirmed: true, text: '但是AI来去做内容' },
      { span: [45.21, 47.73], agree: true, veto: true, text: '我现在花1000的时间', orig: '我现在要花一千的时间', applied: true, op: 'revert' },
      { span: [30.6, 34.88], agree: true, text: '大家用GDPCodexCodex这些工具', rejected: '删 10 个字，超过听音复核 4 个字的预算' },
    ] },
    pending: [
      { at: 27.5, w: '因为', p: 0.565, why: 'never-heard', strong: false },
      { at: 31.28, w: 'G', p: 0.424, why: 'audio-differs', strong: false },
    ],
    pendingCutTexts: ['些@10.42s', '但是@39.94s'],
  }
  const keep = [[0, 3.125], [25.28, 39.928], [45.07, 54.87]]
  const s1 = spotFacts({ at: 27.5, words, keep, fixReport })
  ok('查得到这一秒的词和置信度', s1.words.some(w => w.w === '因为' && w.p === 0.565), JSON.stringify(s1.words))
  ok('点在有保留区间里 → inFilm', s1.inFilm === true)
  ok('没被听过 → not-audited，并带出为什么', s1.verdict === 'not-audited' && s1.pending[0].why === 'never-heard' && s1.pending[0].strong === false, JSON.stringify(s1.pending))
  const s2 = spotFacts({ at: 31.28, words, keep, fixReport })
  ok('听过但对不上 → rejected，并把理由带出来', s2.verdict === 'rejected' && /删 10 个字/.test(s2.spans[0].rejected || ''), JSON.stringify(s2.spans))
  const s3 = spotFacts({ at: 46.5, words, keep, fixReport })
  ok('被音频否决过 → vetoed', s3.verdict === 'vetoed')
  const s4 = spotFacts({ at: 10.42, words, keep, fixReport })
  ok('已被剪掉的点 → inFilm false（观众听不到）', s4.inFilm === false)
  const s5 = spotFacts({ at: 20, words, keep, fixReport })
  ok('没有任何记录 → not-suspicious', s5.verdict === 'not-suspicious' && s5.spans.length === 0 && s5.pending.length === 0)
  ok('剪掉的字单独列出来（去掉时间写法）', s4.pendingCut.includes('些') && s4.pendingCut.includes('但是'), JSON.stringify(s4.pendingCut))

  // 这只手要真的能把证据交到模型手上，不是只在工具表里挂个名字
  const g2 = group('取证')
  const d2 = new Director(g2, { brief: {}, state: { transcript: { words }, plan: { keep }, fixReport } })
  const qtools = toolsFor('qc', { group: g2, brief: d2.brief, state: d2.state, runner: d2.runner, director: d2 })
  const seen = []
  const chatFn = async ({ messages }) => {
    const isTool = messages.some(m => m.role === 'tool')
    if (!isTool) return { ok: true, content: '', toolCalls: [{ id: 'e1', function: { name: 'explain_spot', arguments: JSON.stringify({ at: 27.5 }) } }] }
    seen.push(messages.filter(m => m.role === 'tool').map(m => String(m.content)).join(''))
    return { ok: true, content: '27.5s 的「因为」置信 0.565，没进过可疑队列，不是抓漏。', toolCalls: [] }
  }
  const rr = await runAgent({ session: new BotSession(g2, 'qc'), bot: byId('qc'), task: '27.5s 对不对', tools: qtools, chatFn })
  ok('质检能从工具里拿到那一秒的证据', seen.length === 1 && seen[0].includes('因为') && seen[0].includes('never-heard'), JSON.stringify(seen).slice(0, 200))
  ok('拿到证据后的话过数字校验', rr.ok && rr.check && rr.check.ok, JSON.stringify(rr.check && rr.check.fail && rr.check.fail.slice(0, 3)))
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

// ── 7. 质检只说话不查片：引擎必须自己验；成片一换旧报告作废 ──
console.log('\n[7] 质检兜底与报告作废')
{
  const g = group('质检兜底')
  const state = {}
  const d = new Director(g, { brief: { duration: 60, template: 'subtitle-only', ratio: '9:16' }, state })
  let engineRuns = 0
  d.handlers.qc = async () => { engineRuns++; state.report = { passed: true, checks: [{ id: 'x', ok: true }] }; return { ok: true } }
  // 模型这一轮只说了「我先抽帧看片」，一次 inspect_film 都没调
  d.chatFn = async () => ({ ok: true, content: '我先抽帧看片，把问题一次查全。', toolCalls: [] })
  const r1 = await d.runBot('qc', '查片')
  ok('质检没调工具时引擎自己跑一遍', engineRuns === 1 && Boolean(state.report), 'engineRuns=' + engineRuns)
  ok('质检没查片也要给出结论（不装作查过了）', Boolean(r1) && state.report.passed === true)
  const r2 = await d.runBot('qc', '再查一遍')
  ok('报告还在就不重复跑引擎', engineRuns === 1, 'engineRuns=' + engineRuns)

  // 成片一换，旧报告必须作废：源码级守卫（runPack 真的出片后再清，测不到就钉住顺序）
  const packSrc = readFileSync(new URL('../src/handlers/pack.mjs', import.meta.url), 'utf8')
  const at = packSrc.indexOf("artifact('video'")
  const clear = packSrc.indexOf('state.report = null')
  ok('出片之后立刻清掉旧质检报告（片子新、报告旧的组合不许存在）', at > 0 && clear > at)
}

console.log('\n' + (fail ? 'FAIL' : 'PASS') + '  ' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)