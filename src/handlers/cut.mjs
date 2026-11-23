/** 剪辑：转写 → 错字治理 → 气口检测 → 保留区间 → 字幕卡。只报数字和决定。 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { probe } from '../probe.mjs'
import { extractAudio } from '../ffmpeg.mjs'
import { transcribe } from '../asr.mjs'
import { buildPlan } from '../plan.mjs'
import { buildCaptions, toSRT } from '../captions.mjs'
import { correct, loadTerms, hotwordPrompt, applyToSegments } from '../asr-fix.mjs'
import { sectionsOf } from '../sections.mjs'
import { titleSections } from '../section-titles.mjs'

const TPL_ROOT = fileURLToPath(new URL('../../templates/', import.meta.url))

/**
 * 这个模板这一段能放多少字的大字。只有画布模板（有 big 布局）才有：
 * PPT 底座的章节卡按契约必须用原话，不许改写，所以那边不接标题模型。
 */
function bigBudget(templateId, ratio) {
  if (!templateId) return 0
  try {
    const tpl = JSON.parse(readFileSync(join(TPL_ROOT, templateId, 'template.json'), 'utf8').replace(/^\uFEFF/, ''))
    const layouts = tpl.layouts || {}
    const R = (ratio && layouts[ratio]) ? ratio : (layouts[tpl.ratio] ? tpl.ratio : Object.keys(layouts)[0])
    const big = R && layouts[R] && layouts[R].big
    if (!big || !big.lineChars) return 0
    return Math.max(6, Math.min(16, (big.lineChars || 6) * (big.maxLines || 2) - 2))
  } catch { return 0 }
}

const KIND_LABEL = { homophone: '同音字', term: '专有名词', number: '数字' }

export async function runCut({ group, job, log, artifact, brief, state }) {
  const input = group.meta.assets[0]
  if (!input) throw new Error('没有素材')

  const work = join(group.dir, 'work', job.id)
  mkdirSync(work, { recursive: true })

  const info = await probe(input)
  log(`素材 ${info.duration.toFixed(2)}s · ${info.width}×${info.height} · ${info.fps.toFixed(0)}fps · 音轨${info.hasAudio ? '有' : '无'}`)
  if (!info.hasAudio) throw new Error('素材没有音轨，没法转写')

  const wav = join(work, 'audio.wav')
  await extractAudio(input, wav)

  // 第一层治理：转写前把术语表当热词喂进去，让它一开始就别写错
  const terms = loadTerms(group.dir)
  const hot = hotwordPrompt(terms)
  if (hot) log('热词注入：' + hot)

  const t0 = Date.now()
  log('转写中（faster-whisper，本地 CPU）')
  // 原始转写留一份给审计，纠错后的才是下游真正用的 transcript.json
  const asr = await transcribe(wav, { out: join(work, 'asr-raw.json'), model: brief.asrModel || 'small', hotwords: hot })
  const raw = asr.json.words
  const asrSeconds = (Date.now() - t0) / 1000
  log(`转写完成：${raw.length} 词 · ${asrSeconds.toFixed(1)}s`)

  // 第二层治理：受约束纠错。只改词文本，时间码和词数由模块内部断言
  const fix = await correct({ words: raw, terms, log })
  const words = fix.words
  const fixPath = join(work, 'fix-report.json')
  writeFileSync(fixPath, JSON.stringify(fix.report, null, 2), 'utf8')
  artifact('fix', fixPath, { changed: fix.report.stats.changed, pending: fix.report.stats.pending })

  const plan = buildPlan(words, info.duration, { speed: brief.speed ?? 1, pauseThreshold: brief.pauseThreshold ?? 0.45 })
  const captions = buildCaptions(words, plan, { maxChars: brief.maxChars ?? 14 })

  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 1), 'utf8')
  writeFileSync(join(work, 'subs.srt'), toSRT(captions.cards), 'utf8')
  artifact('timeline', join(work, 'plan.json'), { duration: plan.outDuration })
  artifact('subs', join(work, 'subs.srt'))

  // 句子文本也要跟着纠错走，否则大字用的还是错的（字幕改了、片子里没改）
  const segments = applyToSegments(words, asr.json.segments)
  const transcript = { ...asr.json, words, segments }
  writeFileSync(join(work, 'transcript.json'), JSON.stringify(transcript, null, 1), 'utf8')
  state.transcript = transcript
  state.plan = plan
  state.captions = captions
  state.source = info
  state.fixReport = fix.report
  state.lowConfidence = fix.report.pending

  // 段落大字标题：模型提案，接地校验（字必须来自这一段自己说过的话）。
  // 时间码还是时间码：模型只产出文本，段落边界仍由 mergeSections 决定。
  const secs = sectionsOf({ segments, plan })
  const budget = bigBudget(group.meta.template || brief.template, brief.ratio)
  if (budget && secs.length) {
    group.emit({ type: 'progress', bot: 'cutter', text: '剪辑在给 ' + secs.length + ' 段起大字标题…', transient: true })
    const t = await titleSections({ sections: secs, maxChars: budget, log })
    state.sectionTitles = t.titles
    brief.sectionTitles = t.titles
    state.titleStats = t.stats || null
    const adopted = t.titles.filter(x => x.source === 'model')
    if (adopted.length) {
      log('大字标题：' + adopted.map(x => x.index + '「' + x.text + '」').join(' '))
      group.emit({ type: 'progress', bot: 'cutter', text: '大字标题定了 ' + adopted.length + ' / ' + secs.length + ' 段', transient: true })
    }
  }

  // 交付之后「改一句」要基于这一份：词、句、时间线、字幕卡全在，不用重跑转写。
  // 只存状态，不存媒体；素材路径还在 group.json 里，渲染时按它取帧。
  writeFileSync(join(group.dir, 'pipeline.json'), JSON.stringify({
    version: 1,
    at: new Date().toISOString(),
    template: group.meta.template,
    brief,
    source: info,
    plan,
    captions,
    transcript: { words, segments },
    fixReport: fix.report,
  }), 'utf8')

  const fixed = fix.report.applied
  const pending = fix.report.pending
  group.say('cutter',
    `读完了：${info.duration.toFixed(1)}s 素材，${words.length} 个词，剪掉 ${plan.cutSeconds.toFixed(1)}s（${plan.removedPauses} 个长停顿），成片 ${plan.outDuration.toFixed(1)}s，${plan.keep.length} 段。` +
    (fixed.length
      ? `\n错字改了 ${fixed.length} 处：` + fixed.slice(0, 3).map(f => `「${f.from}」→「${f.to}」@${f.at}s（${KIND_LABEL[f.kind] || f.kind}，${f.verified || '命中术语表'}）`).join('、') + (fixed.length > 3 ? ' 等' : '') + '。'
      : '\n没有需要改的错字。') +
    (fix.report.rejected.length ? `\n模型提的 ${fix.report.rejected.length} 处改法没通过校验，退回了：` + fix.report.rejected.slice(0, 2).map(r => `「${r.from}」→「${r.to}」${r.why}`).join('、') + '。' : '') +
    (pending.length
      ? `\n还有 ${pending.length} 个词识别把握不高：${pending.slice(0, 4).map(w => `「${w.w}」@${w.at}s`).join('、')}${pending.length > 4 ? ' 等' : ''}，没把握就不动它，全部列在错字清单里。`
      : '\n低置信词都处理干净了。'),
    { job: job.id })

  return { plan, captions, transcript, fixReport: fix.report, slow: asrSeconds }
}
