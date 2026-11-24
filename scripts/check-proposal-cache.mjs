/**
 * 提案缓存自检：模型不保证可复现，产品就得自己保证。
 *
 * 这一层的存在理由是一条实测：同一份输入、同一个提示词连问两次模型，分镜、图形块、强调词
 * 没有一次完全一样；把温度钉到 0 也一样不一样（自测 22 探针，三组配置各问两次，全都不一致）。
 * 所以「同一素材、同一需求、出同一版」只能靠「问过一次就记住」。
 *
 * 断言分三组：指纹怎么算 / 落盘与命中 / 接线（谁在用、坏输出不许进缓存）。
 *   node scripts/check-proposal-cache.mjs
 */
import { readFileSync, mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { proposalKey, cacheRead, cacheWrite, CACHE_VERSION } from '../src/proposal-cache.mjs'

process.env.DSH_MEDIA_LLM_KEY = process.env.DSH_MEDIA_LLM_KEY || 'test-key'
const { chatJSONCached, chatCached, useProposalCache, proposalCacheDir, LLM } = await import('../src/llm.mjs')

const ROOT = process.cwd()
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }
const src = f => readFileSync(join(ROOT, 'src', f), 'utf8')
const tmp = () => mkdtempSync(join(tmpdir(), 'p-cache-'))

// ── 1) 指纹 ──
const base = { prompt: '把这几句排成分镜', model: 'M1', temperature: 0, maxTokens: 2400, kind: 'json' }
ok('同样的输入算出同样的指纹', proposalKey(base) === proposalKey({ ...base }))
ok('改一个字就是新问题', proposalKey(base) !== proposalKey({ ...base, prompt: '把这几句排成分镜。' }))
ok('换模型就是新问题（接 Opus 会自动重问）', proposalKey(base) !== proposalKey({ ...base, model: 'M2' }))
ok('温度不同是新问题', proposalKey(base) !== proposalKey({ ...base, temperature: null }))
ok('预算不同是新问题', proposalKey(base) !== proposalKey({ ...base, maxTokens: 1800 }))
ok('输出形态不同是新问题', proposalKey(base) !== proposalKey({ ...base, kind: 'text' }))
ok('指纹是定长十六进制', /^[0-9a-f]{20}$/.test(proposalKey(base)))

// ── 2) 落盘 / 命中 ──
const d1 = tmp()
ok('目录不存在时读不到东西（不报错）', cacheRead(join(d1, 'nope'), 'k') === null)
const p1 = cacheWrite(d1, 'abc', { kind: 'json', value: { a: 1 } })
ok('写盘会自己建目录', Boolean(p1) && existsSync(p1))
ok('读回来是同一份', cacheRead(d1, 'abc')?.value?.a === 1)
ok('写盘带版本号和时间', cacheRead(d1, 'abc')?.v === CACHE_VERSION && Boolean(cacheRead(d1, 'abc')?.at))
writeFileSync(join(d1, 'bad.json'), '{ 半截', 'utf8')
ok('坏文件当没命中（缓存坏了不许让片子停住）', cacheRead(d1, 'bad') === null)
writeFileSync(join(d1, 'old.json'), JSON.stringify({ v: 'p0', value: { a: 1 } }), 'utf8')
ok('旧版本的缓存不认', cacheRead(d1, 'old') === null)

// ── 3) 行为：命中就不再问模型 ──
const d2 = tmp()
const realFetch = globalThis.fetch
let asked = 0
globalThis.fetch = async () => {
  asked++
  return { ok: true, text: async () => JSON.stringify({ model: 'stub', choices: [{ message: { content: '{"pages":[]}' } }], usage: { total_tokens: 7 } }) }
}
useProposalCache(d2)
const r1 = await chatJSONCached({ prompt: 'p', maxTokens: 1000 })
const r2 = await chatJSONCached({ prompt: 'p', maxTokens: 1000 })
ok('第一次真问了模型', r1.ok === true && r1.cached !== true && asked === 1, 'asked=' + asked)
ok('第二次直接交回上次那份，没有网络', r2.ok === true && r2.cached === true && asked === 1, 'asked=' + asked)
ok('指纹一样才命中：换个 prompt 要重问', (await chatJSONCached({ prompt: 'p2', maxTokens: 1000 })).cached !== true && asked === 2)
ok('换模型要重问（接 Opus 不会被旧答案钉住）', (await chatJSONCached({ prompt: 'p', maxTokens: 1000, model: 'OTHER' })).cached !== true && asked === 3)
const rText = await chatCached({ prompt: 'p', maxTokens: 1000 })
const rText2 = await chatCached({ prompt: 'p', maxTokens: 1000 })
ok('文本通道也走缓存（错字治理的提案）', rText.cached !== true && rText2.cached === true && typeof rText2.content === 'string')

// 坏输出不进缓存：下一次还得重问
const d3 = tmp()
useProposalCache(d3)
globalThis.fetch = async () => { asked++; return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '这不是 JSON' } }] }) } }
const bad = await chatJSONCached({ prompt: 'q', maxTokens: 100 })
ok('模型输出坏了就不缓存', bad.ok === false && readdirSync(d3).filter(f => f.endsWith('.json')).length === 0)
ok('缓存目录一直是那个（handler 指定）', proposalCacheDir() === d3)

// 模型连不上：不许写成缓存
const d4 = tmp()
useProposalCache(d4)
globalThis.fetch = async () => { throw new Error('boom') }
const off = await chatJSONCached({ prompt: 'z', maxTokens: 100 })
ok('模型连不上时不写缓存', off.ok === false && readdirSync(d4).length === 0, off.skipped || '')
useProposalCache(null)
globalThis.fetch = realFetch
ok('关掉缓存就退回直连模型', proposalCacheDir() === null)

// ── 4) 接线：谁在用 ──
for (const [f, label] of [['prune.mjs', '整句删'], ['shots.mjs', '分镜'], ['headlines.mjs', '段落大字'], ['section-titles.mjs', '段落标题'], ['qa-semantic.mjs', '语义审读']]) {
  const s = src(f)
  ok(label + '走缓存通道', /chatJSONCached\(/.test(s) && !/[^C]chatJSON\(/.test(s.replace(/chatJSONCached\(/g, '')), f)
}
ok('错字治理的提案走文本缓存', /chatCached\(/.test(src('asr-fix.mjs')))
ok('剪辑开跑前指定了缓存目录', /useProposalCache\(join\(group\.dir, 'proposals'\)\)/.test(src('handlers/cut.mjs')))
ok('质检开跑前指定了缓存目录', /useProposalCache\(join\(group\.dir, 'proposals'\)\)/.test(src('handlers/qc.mjs')))
ok('缓存写在群里、不进仓库', /groups\//.test(readFileSync(join(ROOT, '.gitignore'), 'utf8')))

console.log('提案缓存自检：' + pass + ' 通过，' + fails.length + ' 失败')
for (const f of fails) console.log('  ✗ ' + f)
try { rmSync(tmp, { recursive: true, force: true }) } catch {}
if (fails.length) process.exit(1)
