#!/usr/bin/env node
/** dsm cut：素材 → 转写 → 剪辑决策 → 成片 → 质检。 */
import { parseArgs } from 'node:util'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { probe } from '../src/probe.mjs'
import { buildPlan } from '../src/plan.mjs'
import { buildCaptions, toASS, toSRT } from '../src/captions.mjs'
import { renderCut } from '../src/render.mjs'
import { transcribe } from '../src/asr.mjs'
import { extractAudio } from '../src/ffmpeg.mjs'
import { qa } from '../src/qa.mjs'
import { correct, loadTerms, hotwordPrompt } from '../src/asr-fix.mjs'
import { assertTools } from '../src/env.mjs'

const { values: a } = parseArgs({
  options: {
    input: { type: 'string', short: 'i' },
    out: { type: 'string', short: 'o' },
    work: { type: 'string', short: 'w' },
    transcript: { type: 'string', short: 't' },
    model: { type: 'string', default: 'small' },
    speed: { type: 'string', default: '1' },
    pause: { type: 'string', default: '0.45' },
    size: { type: 'string' },
    target: { type: 'string' },
    dry: { type: 'boolean', default: false },
    'no-subs': { type: 'boolean', default: false },
  },
})

if (!a.input) { console.error('用法: dsm cut -i <视频> [-o 成片.mp4] [-t transcript.json] [--speed 1.2]'); process.exit(2) }
assertTools()

const input = resolve(a.input)
const stem = basename(input).replace(/\.\w+$/, '')
const work = resolve(a.work || join(dirname(input), 'work', stem))
mkdirSync(work, { recursive: true })
const out = resolve(a.out || join(dirname(input), stem + '.cut.mp4'))

const t0 = Date.now()
const step = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`)

step('读取素材')
const info = await probe(input)
step(`${info.width}x${info.height} ${info.fps.toFixed(2)}fps ${info.duration.toFixed(1)}s，音轨${info.hasAudio ? '有' : '无'}`)

const terms = loadTerms()
const hot = hotwordPrompt(terms)

let transcript
if (a.transcript) {
  step('使用已有转写')
  transcript = JSON.parse(readFileSync(resolve(a.transcript), 'utf8'))
} else {
  if (!info.hasAudio) throw new Error('没有音轨，无法转写')
  step('抽取音轨')
  const wav = join(work, 'audio.wav')
  await extractAudio(input, wav)
  step(`转写中（faster-whisper ${a.model}，CPU）`)
  if (hot) step('热词注入：' + hot)
  const r = await transcribe(wav, { out: join(work, 'transcript.json'), model: a.model, hotwords: hot })
  transcript = r.json
  step(`转写完成：${r.words} 个词，语言 ${r.language}`)
}

// 错字治理：只改词文本，词数与时间码由模块内部断言
const fix = await correct({ words: transcript.words, terms, log: m => step(m) })
transcript = { ...transcript, words: fix.words }
writeFileSync(join(work, 'fix-report.json'), JSON.stringify(fix.report, null, 1))
for (const f of fix.report.applied) step(`改字 ${f.at}s ${f.from} → ${f.to}（${f.kind}，${f.verified}）`)

const plan = buildPlan(transcript.words, info.duration, {
  speed: Number(a.speed),
  pauseThreshold: Number(a.pause),
})
step(`剪辑决策：${plan.keep.length} 段，剪掉 ${plan.cutSeconds.toFixed(1)}s（${plan.removedPauses} 个长停顿）${plan.speedSaved > 0.1 ? `，加速再省 ${plan.speedSaved.toFixed(1)}s` : ''}，成片约 ${plan.outDuration.toFixed(1)}s`)
writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 1))

const cap = buildCaptions(transcript.words, plan)
step(`字幕：${cap.cards.length} 张，覆盖率 ${cap.coverage.shownChars}/${cap.coverage.originalChars} 字`)
writeFileSync(join(work, 'subs.srt'), toSRT(cap.cards))

if (a.dry) {
  console.log(JSON.stringify({ plan, captions: cap.cards.slice(0, 5) }, null, 2))
  process.exit(0)
}

const size = a.size ? a.size.split('x').map(Number) : null
step('渲染中')
await renderCut({ input, plan, assText: a['no-subs'] ? null : toASS(cap.cards, size ? { width: size[0], height: size[1] } : {}), out, hasAudio: info.hasAudio, size })
step('质检')
const report = await qa({ file: out, plan, captions: cap, targetDuration: a.target ? Number(a.target) : null, asrFix: fix.report })
writeFileSync(join(work, 'qa.json'), JSON.stringify(report, null, 1))

console.log('\n成片: ' + out)
console.log('工作目录: ' + work)
console.log('质检: ' + (report.passed ? '通过' : '未通过 — ' + report.failed.join(', ')))
for (const c of report.checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.id}: ${c.detail}`)
process.exit(report.passed ? 0 : 1)
