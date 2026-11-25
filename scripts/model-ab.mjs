/**
 * 换模型之前先量一遍：同一份素材、同一套输入，把「整句删」的提案重放 N 次，比稳不稳、比多慢。
 *
 * 为什么要有这个脚本（2026-11-25 接 Opus 5.5）：那次的预期是「更强的模型让选句更稳」，
 * 实测相反——qwen3.8-max 三次完全相同、票 3/3 一致；Opus 三次里一次正文空白（不删、片子停
 * 66.56s）、一次只点名 1 句靠降档补，单次 25–49s 对 5–6s。没有这套重放，这些结论只能靠感觉。
 *
 * 用法：
 *   node scripts/model-ab.mjs <群 id> <标签> <第几次> [目标秒数]
 *   例：DSH_MEDIA_LLM_SMART="codesome:claude-opus-5-5" node scripts/model-ab.mjs 27-0r3y0 opus 1
 *
 * 它只读 groups/<id>/pipeline.json 和该群最近一次的 work/<job>/plan.json（取其中的剪辑参数与包络），
 * 不写产品状态、不碰成片；结果落在 .test/ab/<标签>-<n>.json。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildPlan } from '../src/plan.mjs'
import { planPrune } from '../src/prune.mjs'
import { loadTerms } from '../src/asr-fix.mjs'
import { LLM } from '../src/llm.mjs'
import { botConfig } from '../src/bots/config.mjs'

const [groupId, tag = 'run', n = '1', targetArg] = process.argv.slice(2)
if (!groupId) {
  console.log('用法：node scripts/model-ab.mjs <群 id> <标签> <第几次> [目标秒数]')
  process.exit(1)
}
const G = join(process.cwd(), 'groups', groupId)
const pipe = JSON.parse(readFileSync(join(G, 'pipeline.json'), 'utf8'))
// 最近一次包装留下的 plan.json：里面的 options 是那一次真正用过的参数（含音频包络）
const workRoot = join(G, 'work')
const dirs = readdirSync(workRoot).map(d => join(workRoot, d)).filter(d => { try { return statSync(join(d, 'plan.json')).isFile() } catch { return false } })
dirs.sort((a, b) => statSync(join(b, 'plan.json')).mtimeMs - statSync(join(a, 'plan.json')).mtimeMs)
if (!dirs.length) { console.log('这个群还没有 plan.json，先出过一版片子再来'); process.exit(1) }
const planJ = JSON.parse(readFileSync(join(dirs[0], 'plan.json'), 'utf8'))
const words = pipe.transcript.words
const segments = pipe.transcript.segments
const terms = loadTerms()
const opts = { ...planJ.options }
delete opts.ranges
const plan0 = buildPlan(words, planJ.sourceDuration, opts)
const target = Number(targetArg) || Number((pipe.brief && pipe.brief.duration) || 0) || 0
const params = { ...(botConfig('cutter').params.prune || {}) }
const tol = Number(params.tolerance) || 0.02
const fit = d => d <= target * (1 + tol)

const outDir = join(process.cwd(), '.test', 'ab')
mkdirSync(outDir, { recursive: true })
const runTag = tag + '-' + n
const log = []
const rec = { tag: runTag, group: groupId, model: LLM.models.smart, target, before: Number(plan0.outDuration.toFixed(2)), rounds: [] }
let cur = plan0
const applied = []
for (let k = 0; k < 2; k++) {
  if (fit(cur.outDuration)) break
  const pr = await planPrune({ segments, words, plan: cur, target, terms, params, log: m => log.push(m) })
  rec.rounds.push({
    round: k + 1,
    inDuration: Number(cur.outDuration.toFixed(2)),
    ok: Boolean(pr && pr.ok),
    skipped: (pr && (pr.skipped || (pr.model && pr.model.skipped))) || null,
    asks: (pr && pr.model && pr.model.asks) || 0,
    ms: (pr && pr.model && pr.model.ms) || 0,
    tokens: (pr && pr.model && pr.model.tokens) || null,
    picked: (pr && pr.picks || []).map(x => x.text),
    blocked: (pr && pr.model && pr.model.blocked || []).slice(0, 6),
    votes: (pr && pr.model && pr.model.votes || []).map(v => ({ i: v.index ?? v.idx, yes: v.yes, no: v.no })),
    log: log.slice(-2),
  })
  if (!pr || !pr.picks || !pr.picks.length) break
  applied.push(...pr.picks.map(x => ({ i0: x.i0, i1: x.i1, reason: 'content', text: x.text })))
  cur = buildPlan(words, planJ.sourceDuration, { ...opts, ranges: applied })
}
rec.after = Number(cur.outDuration.toFixed(2))
rec.hit = fit(cur.outDuration)
rec.cutTexts = applied.map(x => x.text)
rec.asks = rec.rounds.reduce((a, r) => a + r.asks, 0)
rec.ms = rec.rounds.reduce((a, r) => a + r.ms, 0)
writeFileSync(join(outDir, runTag + '.json'), JSON.stringify(rec, null, 1), 'utf8')
console.log(JSON.stringify({ tag: runTag, model: rec.model, before: rec.before, after: rec.after, hit: rec.hit, asks: rec.asks, sec: Number((rec.ms / 1000).toFixed(1)), cut: rec.cutTexts, rounds: rec.rounds.map(r => ({ r: r.round, skipped: r.skipped, picked: r.picked.length, votes: r.votes })) }))
