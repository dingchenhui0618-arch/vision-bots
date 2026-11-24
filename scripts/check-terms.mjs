/**
 * 资产层的自检：术语表是这里唯一可写的东西，所以每一道门都要有断言。
 *
 * 离线跑：同音门用假拼音喂进去（不依赖本机 pypinyin），写盘写到临时目录（不碰仓库的 config/terms.json）。
 * 三件事必须成立：
 *   1. 同音字类必须真同音——不通音的同音条目会把片子里写对的词改坏，这是这个模块最容易犯的错。
 *   2. 内容没改的一次存盘必须产生 0 行改动（序列化幂等）。
 *   3. 试验台用的就是转写时用的那个 applyTerms，不是另写一份。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readTerms, validateTerms, auditTerms, writeTerms, serializeTerms, trial, templateLibrary, botRoster, TERMS_FILE } from '../src/assets.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TMP = join(ROOT, '.test', 'terms-check')
const sha = s => createHash('sha1').update(s).digest('hex').slice(0, 12)
const clone = j => JSON.parse(JSON.stringify(j))

let pass = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  fails.push(name + (detail ? '：' + detail : ''))
}

const repoRaw = readFileSync(TERMS_FILE, 'utf8')
const repoRev = sha(repoRaw)
const base = readTerms()

// ── 1. 解析 ──
ok('解析 · 读出术语表', base.terms.length >= 13, String(base.terms.length))
ok('解析 · 热词有口播和划走', base.hotwords.includes('口播') && base.hotwords.includes('划走'))
ok('解析 · note 保留下来（存盘要原样写回）', base.note.length > 40)
ok('解析 · rev 是文件指纹', base.rev === repoRev, base.rev + ' / ' + repoRev)
const changedFile = join(TMP, 'changed.json')
mkdirSync(TMP, { recursive: true })
writeFileSync(changedFile, repoRaw.replace('"version": 2', '"version": 3'), 'utf8')
ok('解析 · 文件一变 rev 就变', readTerms(changedFile).rev !== base.rev)

// ── 2. 形状门：不过形状的条目连拼音都不用查 ──
const add = t => { const j = clone(base); j.terms.push(t); return validateTerms(j) }
out: {
  ok('形状 · 真表全过', validateTerms(base).ok && validateTerms(base).errors.length === 0)
  const empty = add({ kind: 'homophone', to: '', from: ['画走'] })
  ok('形状 · 空 to', !empty.ok && /缺少 to/.test(empty.errors[0].why), JSON.stringify(empty.errors))
  const noFrom = add({ kind: 'homophone', to: '划走', from: [] })
  ok('形状 · from 空着 = 证据词条，不报错但要提醒它不做替换', noFrom.ok && noFrom.warnings.some(w => /只当证据/.test(w)), JSON.stringify(noFrom))
  const evTerm = add({ kind: 'term', to: 'Gemini', from: [] })
  ok('形状 · 专有名词可以只登记证据词条', evTerm.ok && !evTerm.warnings.some(w => /只当证据/.test(w)), JSON.stringify(evTerm))
  const same = add({ kind: 'homophone', to: '划走', from: ['划走'] })
  ok('形状 · from 和 to 一样', !same.ok && /永远不会触发/.test(same.errors[0].why))
  const space = add({ kind: 'homophone', to: '划 走', from: ['画走'] })
  ok('形状 · to 里有空格', !space.ok && /空格/.test(space.errors[0].why))
  const kind = add({ kind: 'typo', to: '划走', from: ['画走'] })
  ok('形状 · 类型不在四类里', !kind.ok && /kind 只能是/.test(kind.errors[0].why))
  const dup = add({ kind: 'homophone', to: '划走', from: ['画走', '华走', '化走'], onlyIfLowConfidence: true })
  ok('形状 · 完全重复的条目', !dup.ok && /完全重复/.test(dup.errors[0].why), JSON.stringify(dup.errors))
  const next = add({ kind: 'homophone', to: '划', from: ['化'], next: [] })
  ok('形状 · next 空数组', !next.ok && /next 要是非空词/.test(next.errors[0].why))
  const low = add({ kind: 'homophone', to: '划走', from: ['画走'], onlyIfLowConfidence: 'yes' })
  ok('形状 · onlyIfLowConfidence 不是布尔', !low.ok && /只能是 true/.test(low.errors[0].why))
  const hw = clone(base); hw.hotwords = [...hw.hotwords, hw.hotwords[0]]
  ok('形状 · 热词重复', !validateTerms(hw).ok && /重复/.test(validateTerms(hw).errors[0].why))
  const bad = add({ kind: 'homophone', to: '划', from: ['化'], next: '走' })
  ok('形状 · 合法的 next 条目放行', bad.ok, JSON.stringify(bad.errors))
}

// ── 3. 同音门：假拼音，验的是判断逻辑不是 pypinyin ──
const PY = { 划: 'hua', 化: 'hua', 画: 'hua', 观众: 'guanzhong', 观点: 'guandian', 划走: 'huazou', 画走: 'huazou' }
const fakePy = map => async items => items.map(s => map[s] ?? null)
const one = t => ({ version: 2, note: '', hotwords: [], terms: [t] })
{
  const a1 = await auditTerms(one({ kind: 'homophone', to: '划', from: ['化'], next: '走' }), { pinyinOf: fakePy(PY) })
  ok('同音 · 真同音放行', a1.pinyinMode === 'on' && a1.errors.length === 0, JSON.stringify(a1.errors))
  const a2 = await auditTerms(one({ kind: 'homophone', to: '观众', from: ['观点'] }), { pinyinOf: fakePy(PY) })
  ok('同音 · 不通音拦下', a2.errors.length === 1 && /不同音/.test(a2.errors[0].why), JSON.stringify(a2.errors))
  ok('同音 · 拦下时说清读什么', /guandian/.test(a2.errors[0].why) && /guanzhong/.test(a2.errors[0].why), a2.errors[0].why)
  const a3 = await auditTerms(one({ kind: 'term', to: '观众', from: ['观点'] }), { pinyinOf: fakePy(PY) })
  ok('同音 · 专有名词类不拦', a3.errors.length === 0)
  ok('同音 · 但提醒会连正确的词一起改', a3.warnings.length === 1 && /也一并改掉/.test(a3.warnings[0]), JSON.stringify(a3.warnings))
  const a4 = await auditTerms(one({ kind: 'term', to: '观众', from: ['观点'], onlyIfLowConfidence: true }), { pinyinOf: fakePy(PY) })
  ok('同音 · 只改低置信就不提醒', a4.warnings.length === 0, JSON.stringify(a4.warnings))
  const a5 = await auditTerms(one({ kind: 'homophone', to: '划', from: ['化'] }), { pinyinOf: async () => null })
  ok('同音 · 本机没拼音校验时说明白', a5.pinyinMode === 'off' && a5.errors.length === 0 && /没跑/.test(a5.warnings[0]), JSON.stringify(a5))
  const a6 = await auditTerms(one({ kind: 'number', to: '3', from: ['三'] }), { pinyinOf: fakePy(PY) })
  ok('同音 · 数字类不查拼音', a6.pinyinMode === 'n/a')
}

// ── 4. 试验台：走的是真的 applyTerms ──
{
  const t1 = trial('观众三秒就画走了', base.terms)
  ok('试验 · 画走修成划走', t1.out === '观众三秒就划走了', t1.out)
  ok('试验 · 记下命中位置', t1.hits.length === 1 && t1.spans.length === 1, JSON.stringify(t1.hits))
  ok('试验 · 高亮位置对得上纠正后的文本', t1.out.slice(t1.spans[0].at, t1.spans[0].at + t1.spans[0].len) === t1.spans[0].to)
  const t2 = trial('化走了', base.terms)
  ok('试验 · 被拆成两个词也能修', t2.out === '划走了', t2.out)
  const t3 = trial('口拨才是关键', base.terms)
  ok('试验 · 字面能找到被切碎的错写', t3.literal.length === 1 && t3.literal[0].from === '口拨' && t3.literal[0].to === '口播', JSON.stringify(t3.literal))
  ok('试验 · 并说明按词切没走到', t3.missed.length === 1 && t3.changed === 0, JSON.stringify({ missed: t3.missed, changed: t3.changed }))
  const t4 = trial('画走了', [{ kind: 'homophone', to: '划走', from: ['画'] }])
  ok('试验 · 字数不一致就不改（会撑破字幕卡）', t4.out === '画走了' && t4.skipped.length === 1 && /字数不一致/.test(t4.skipped[0].why), JSON.stringify(t4.skipped))
  const t5 = trial('这句话本来就没写错', base.terms)
  ok('试验 · 原句没写错就一条不命中', t5.changed === 0 && t5.out === t5.src)
  const t6 = trial('', base.terms)
  ok('试验 · 空输入不炸', t6.out === '' && t6.changed === 0)
}

// ── 5. 存盘：幂等、原子、不碰仓库文件 ──
{
  const f = join(TMP, 'terms.json')
  if (existsSync(f)) rmSync(f)
  const a = serializeTerms(base)
  const b = serializeTerms(readTerms(TERMS_FILE))
  ok('存盘 · 序列化是稳定的', a === b)
  ok('存盘 · 内容没改就等于原文件的排版', a === repoRaw, firstDiff(a, repoRaw))
  const w1 = writeTerms(base, f)
  ok('存盘 · 写出来的能读回去', readTerms(f).terms.length === base.terms.length)
  ok('存盘 · rev 是落盘后的真实指纹', w1.rev === readTerms(f).rev)
  ok('存盘 · 不留临时文件', !existsSync(f + '.tmp'))
  const before = readFileSync(f, 'utf8')
  writeTerms(readTerms(f), f)
  ok('存盘 · 再存一次字节不变', readFileSync(f, 'utf8') === before)
  const empty = writeTerms({ version: 2, note: '', hotwords: [], terms: [] }, join(TMP, 'empty.json'))
  const emptyRaw = readFileSync(join(TMP, 'empty.json'), 'utf8')
  ok('存盘 · 空表也是合法 JSON', (() => { try { JSON.parse(emptyRaw); return true } catch { return false } })())
  ok('存盘 · 不写 BOM', emptyRaw.charCodeAt(0) === 0x7b)
  ok('存盘 · 版本和 note 原样保留', readTerms(f).version === base.version && readTerms(f).note === base.note)
  ok('存盘 · 顺序一个没变', readTerms(f).terms.map(x => x.to).join(',') === base.terms.map(x => x.to).join(','))
  ok('存盘 · 仓库里的术语表一个字节没动', sha(readFileSync(TERMS_FILE, 'utf8')) === repoRev)
}

// ── 6. 接线：界面能看见的东西都得真的接上 ──
{
  const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8')
  ok('接线 · 三条路由都在', ['/^\\/api\\/assets$/', '/^\\/api\\/assets\\/terms$/', '/^\\/api\\/assets\\/terms\\/trial$/'].every(r => server.includes(r)))
  ok('接线 · 资产层从 assets.mjs 来', /from '\.\/assets\.mjs'/.test(server))
  const save = server.slice(server.indexOf('/api\\/assets\\/terms$'), server.indexOf('/terms\\/trial$'))
  ok('接线 · 存盘先形状后同音再写盘', save.indexOf('validateTerms') > 0 && save.indexOf('auditTerms') > save.indexOf('validateTerms') && save.indexOf('writeTerms') > save.indexOf('auditTerms'))
  ok('接线 · 存盘带 rev 对账', /b\.rev !== cur\.rev/.test(save) && /409/.test(save))
  const page = readFileSync(join(ROOT, 'web', 'assets.html'), 'utf8')
  ok('接线 · 页面三块都在', ['bot 名册', '模板库', '术语表'].every(t => page.includes(t)) && page.includes('/assets.js') && page.includes('/assets.css'))
  const app = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')
  ok('接线 · 群聊能进资产层', /href="\/assets.html"/.test(app))
  ok('接线 · 名册里不放 skill（内功不进产品）', !JSON.stringify(botRoster()).includes('script-align'))
  ok('接线 · 模板库把声明和实现对出来', templateLibrary().every(t => t.built === null || t.built.layouts))
}

function firstDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return '第 ' + (i + 1) + ' 行：' + JSON.stringify(x[i]) + ' / ' + JSON.stringify(y[i])
  return ''
}

const head = 'check-terms：' + pass + ' 条通过' + (fails.length ? '，' + fails.length + ' 条失败' : '')
console.log(head)
for (const f of fails) console.log('  × ' + f)
process.exit(fails.length ? 1 : 0)
