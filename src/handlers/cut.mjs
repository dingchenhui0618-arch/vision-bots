/** 剪辑：转写 → 错字治理 → 气口检测 → 保留区间 → 字幕卡。只报数字和决定。 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

export async function runCut({ group, job, log, artifact, brief, state, narrate = true }) {
  const input = group.meta.assets[0]
  if (!input) throw new Error('没有素材')

  const work = join(group.dir, 'work', job.id)
  mkdirSync(work, { recursive: true })

  const info = await probe(input)
  log(`素材 ${info.duration.toFixed(2)}s · ${info.width}×${info.height} · ${info.fps.toFixed(0)}fps · 音轨${info.hasAudio ? '有' : '无'}`)
  if (!info.hasAudio) throw new Error('素材没有音轨，没法转写')

  // 第一层治理：转写前把术语表当热词喂进去，让它一开始就别写错
  const terms = loadTerms(group.dir)
  const hot = hotwordPrompt(terms)

  // 转写很贵（这条素材 62s）。素材、术语表、识别模型都没变就复用上次结果：
  // 「返工」「重跑」不该再从零听一遍素材。
  const cached = readCutCache({ dir: group.dir, input, terms, brief })
  let words, segments, fixReport, language
  let asrSeconds = 0
  let reused = false
  if (cached) {
    words = cached.words
    segments = cached.segments
    fixReport = cached.fixReport
    language = cached.language || 'zh'
    asrSeconds = cached.asrSeconds || 0
    reused = true
    log(`复用上次转写：${words.length} 词（素材、术语表、识别模型都没变）`)
  } else {
    const wav = join(work, 'audio.wav')
    await extractAudio(input, wav)
    if (hot) log('热词注入：' + hot)
    const t0 = Date.now()
    log('转写中（faster-whisper，本地 CPU）')
    // 原始转写留一份给审计，纠错后的才是下游真正用的 transcript.json
    const asr = await transcribe(wav, { out: join(work, 'asr-raw.json'), model: brief.asrModel || 'small', hotwords: hot })
    const raw = asr.json.words
    asrSeconds = (Date.now() - t0) / 1000
    language = asr.json.language || 'zh'
    log(`转写完成：${raw.length} 词 · ${asrSeconds.toFixed(1)}s`)

    // 第二层治理：受约束纠错。只改词文本，时间码和词数由模块内部断言
    const fix = await correct({ words: raw, terms, log })
    words = fix.words
    fixReport = fix.report
    // 句子文本也要跟着纠错走，否则大字用的还是错的（字幕改了、片子里没改）
    segments = applyToSegments(words, asr.json.segments)
    writeCutCache({ dir: group.dir, input, terms, brief, words, segments, fixReport, asrSeconds, language })
  }
  const fixPath = join(work, 'fix-report.json')
  writeFileSync(fixPath, JSON.stringify(fixReport, null, 2), 'utf8')
  artifact('fix', fixPath, { changed: fixReport.stats.changed, pending: fixReport.stats.pending, reused })

  const plan = buildPlan(words, info.duration, { speed: brief.speed ?? 1, pauseThreshold: brief.pauseThreshold ?? 0.45 })
  const captions = buildCaptions(words, plan, { maxChars: brief.maxChars ?? 14 })

  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 1), 'utf8')
  writeFileSync(join(work, 'subs.srt'), toSRT(captions.cards), 'utf8')
  artifact('timeline', join(work, 'plan.json'), { duration: plan.outDuration })
  artifact('subs', join(work, 'subs.srt'))

  const transcript = { language, words, segments }
  writeFileSync(join(work, 'transcript.json'), JSON.stringify(transcript, null, 1), 'utf8')
  state.transcript = transcript
  state.plan = plan
  state.captions = captions
  state.source = info
  state.fixReport = fixReport
  state.lowConfidence = fixReport.pending

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
    fixReport,
  }), 'utf8')

  const fixed = fixReport.applied
  const pending = fixReport.pending
  if (narrate) group.say('cutter',
    `读完了：${info.duration.toFixed(1)}s 素材，${words.length} 个词，剪掉 ${plan.cutSeconds.toFixed(1)}s（${plan.removedPauses} 个长停顿），成片 ${plan.outDuration.toFixed(1)}s，${plan.keep.length} 段。` +
    (fixed.length
      ? `\n错字改了 ${fixed.length} 处：` + fixed.slice(0, 3).map(f => `「${f.from}」→「${f.to}」@${f.at}s（${KIND_LABEL[f.kind] || f.kind}，${f.verified || '命中术语表'}）`).join('、') + (fixed.length > 3 ? ' 等' : '') + '。'
      : '\n没有需要改的错字。') +
    (fixReport.rejected.length ? `\n模型提的 ${fixReport.rejected.length} 处改法没通过校验，退回了：` + fixReport.rejected.slice(0, 2).map(r => `「${r.from}」→「${r.to}」${r.why}`).join('、') + '。' : '') +
    (pending.length
      ? `\n还有 ${pending.length} 个词识别把握不高：${pending.slice(0, 4).map(w => `「${w.w}」@${w.at}s`).join('、')}${pending.length > 4 ? ' 等' : ''}，没把握就不动它，全部列在错字清单里。`
      : '\n低置信词都处理干净了。'),
    { job: job.id })

  // 给 bot 说话用的事实（数字都在这儿，模型不许自己再算一遍）
  const narrative = {
    sourceSec: Number(info.duration.toFixed(1)),
    words: words.length,
    outSec: Number(plan.outDuration.toFixed(1)),
    targetSec: Number(brief.duration) || null,
    gapSec: brief.duration ? Number((Number(brief.duration) - plan.outDuration).toFixed(1)) : null,
    cutSec: Number(plan.cutSeconds.toFixed(1)),
    pauses: plan.removedPauses,
    segments: plan.keep.length,
    sections: secs.length,
    fixed: fixed.map(f => ({ from: f.from, to: f.to, at: f.at, kind: f.kind })),
    pending: pending.map(w => ({ w: w.w, at: w.at })),
    asrSec: Number(asrSeconds.toFixed(1)),
  }
  return { plan, captions, transcript, fixReport, slow: asrSeconds, narrative }
}
// ── 转写缓存：素材/术语表/识别模型没变就别再听一遍 ──
// 返工和重跑都要走这里。素材指纹用 size + mtime，术语表用内容 hash。
const termsHash = terms => createHash('sha1')
  .update(JSON.stringify({ hotwords: terms.hotwords || [], terms: terms.terms || [] }))
  .digest('hex').slice(0, 16)

function readCutCache({ dir, input, terms, brief }) {
  const p = join(dir, 'work', 'cut-cache.json')
  if (!existsSync(p)) return null
  let c
  try { c = JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
  if (!c || c.version !== 1) return null
  const st = statSync(input)
  if (!c.asset || c.asset.size !== st.size || Math.abs(c.asset.mtimeMs - st.mtimeMs) > 1) return null
  if (c.terms !== termsHash(terms)) return null
  if ((c.asrModel || 'small') !== (brief.asrModel || 'small')) return null
  if (!Array.isArray(c.words) || !Array.isArray(c.segments)) return null
  if (!c.fixReport || !c.fixReport.stats) return null
  return c
}

function writeCutCache({ dir, input, terms, brief, words, segments, fixReport, asrSeconds, language }) {
  const st = statSync(input)
  const p = join(dir, 'work', 'cut-cache.json')
  writeFileSync(p, JSON.stringify({
    version: 1,
    at: new Date().toISOString(),
    asset: { size: st.size, mtimeMs: st.mtimeMs },
    terms: termsHash(terms),
    asrModel: brief.asrModel || 'small',
    language, asrSeconds,
    words, segments, fixReport,
  }), 'utf8')
}
