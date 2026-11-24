/** 剪辑：转写 → 错字治理 → 气口检测 → 保留区间 → 字幕卡。只报数字和决定。 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { probe } from '../probe.mjs'
import { extractAudio } from '../ffmpeg.mjs'
import { transcribe } from '../asr.mjs'
import { buildPlan } from '../plan.mjs'
import { envelope16 } from '../energy.mjs'
import { paramsOf } from '../bots/config.mjs'
import { buildCaptions, toSRT } from '../captions.mjs'
import { correct, loadTerms, hotwordPrompt, applyToSegments, FIXER_VERSION } from '../asr-fix.mjs'
import { sectionsOf } from '../sections.mjs'
import { titleSentences } from '../headlines.mjs'
import { pageSkeleton } from '../pages.mjs'
import { planPages } from '../shots.mjs'
import { planPrune } from '../prune.mjs'
import { useProposalCache } from '../llm.mjs'

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

const KIND_LABEL = { homophone: '同音字', near: '近音字', span: '整段纠错', term: '专有名词', number: '数字' }

export async function runCut({ group, job, log, artifact, brief, state, narrate = true }) {
  const input = group.meta.assets[0]
  if (!input) throw new Error('没有素材')

  const work = join(group.dir, 'work', job.id)
  mkdirSync(work, { recursive: true })
  // 提案缓存跟着群走，不跟着这次的任务目录：同一素材、同一需求重跑，
  // 分镜 / 大字 / 整句删 / 改字都交回上次那份，不重新掷骰子。
  // 模型同一输入两次会给两套结果（温度钉 0 也一样），「同一版片子」这件事只能靠这份缓存。
  useProposalCache(join(group.dir, 'proposals'))

  const info = await probe(input)
  log(`素材 ${info.duration.toFixed(2)}s · ${info.width}×${info.height} · ${info.fps.toFixed(0)}fps · 音轨${info.hasAudio ? '有' : '无'}`)
  if (!info.hasAudio) throw new Error('素材没有音轨，没法转写')

  // 音频只抽一次：转写要用，接缝吸附也要用（在刀口附近找最安静的下刀点）
  const wav = join(work, 'audio.wav')
  await extractAudio(input, wav)

  // 能量包络算在这里，两个地方要用：接缝吸附找最安静的下刀点，听音复核判断词槽里
  // 哪一段是静音（补回来的字必须放进静音里，不许挤掉已经说出声的音节）。
  let envelope = null
  try {
    envelope = envelope16(wav)
  } catch (err) {
    log('能量包络没算出来（' + String(err.message).slice(0, 60) + '），接缝按名义值切')
  }

  // 第一层治理：转写前把术语表当热词喂进去，让它一开始就别写错
  const terms = loadTerms(group.dir)
  const hot = hotwordPrompt(terms)

  // 转写很贵（70s 真素材要 12 分钟，本机还会 OOM）。两级缓存的键必须分开：
  //   · 原始转写只跟「素材 + 识别模型 + 实际喂给 whisper 的热词串」有关；
  //   · 纠错结果还跟「术语表内容 + 纠错层版本」有关。
  // 以前两件事共用一个键（键里是整份术语表），加一个术语就整条重听一遍素材——
  // 客户加一个行业词要等十几分钟，等于错字治理不敢动。现在分开算。
  // 质检留下的「音频与字幕不一致」线索：剪辑返工时优先重听这几句（qc handler 写，出片后清空）
  const hintPath = join(group.dir, 'revise-hints.json')
  let hints = []
  try {
    const j = JSON.parse(readFileSync(hintPath, 'utf8'))
    hints = (Array.isArray(j && j.hints) ? j.hints : []).filter(h => h && h.quote)
    if (hints.length) log('质检线索 ' + hints.length + ' 条：' + hints.map(h => '「' + h.quote + '」').join('、') + '（会优先重听这几句）')
  } catch { /* 没有线索文件是常态 */ }

  // 上一轮听音复核**已落地**的几处，重剪时必须重新听一遍。
  // 为什么：纠错每次从原始转写重跑，而重听的采集预算是有限的、排序还会变——
  // 实测自测15 第 4 次重剪时「指纹住在→专注在」那一句没被重新选中，修好的字就这么退回去了。
  // 所以把这些句子记成「带过来的复核点」：不占采集预算，先按音频再确认一次。
  const carryPath = join(group.dir, 'relisten-carry.json')
  let carried = []
  try {
    const j = JSON.parse(readFileSync(carryPath, 'utf8'))
    carried = (Array.isArray(j && j.quotes) ? j.quotes : []).filter(q => typeof q === 'string' && q)
    if (carried.length) log('带过来的复核点 ' + carried.length + ' 处：' + carried.map(q => '「' + q.slice(0, 12) + '」').join('、'))
  } catch { /* 第一次跑没有这个文件 */ }
  if (carried.length) {
    const seen = new Set(hints.map(h => String(h && h.quote || '').replace(/[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu, '')))
    for (const q of carried) {
      const k = q.replace(/[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu, '')
      if (!k || seen.has(k)) continue
      seen.add(k)
      hints = [...hints, { quote: q, by: 'relisten-carry' }]
    }
  }

  const forceFresh = /^(1|true|yes)$/i.test(String(process.env.VISION_BOTS_ASR_FRESH || ''))
  // 有线索时不复用纠错结果：键里没有线索，复用会把新线索吃掉
  const cached = forceFresh || hints.length ? null : readCutCache({ dir: group.dir, input, terms, brief })
  let words, segments, fixReport, language
  let asrSeconds = 0
  let reused = false        // 原始转写 + 纠错都复用
  let reusedRaw = false     // 只复用了原始转写
  let staleHot = false      // 复用原始转写时，热词表已经变了
  let raw = null
  let rawSegments = null
  if (cached && cached.fixHit) {
    words = cached.words
    segments = cached.segments
    fixReport = cached.fixReport
    language = cached.language || 'zh'
    asrSeconds = cached.asrSeconds || 0
    reused = true
    log(`复用上次转写：${words.length} 词（素材、术语表、热词、识别模型、纠错层版本都没变）`)
  } else if (cached && cached.rawHit) {
    raw = cached.raw.words
    rawSegments = cached.raw.segments
    language = cached.raw.language || 'zh'
    asrSeconds = cached.raw.asrSeconds || 0
    reusedRaw = true
    staleHot = Boolean(cached.hotChanged)
    if (staleHot) log(`复用上次的原始转写：${raw.length} 词；热词表变了，但重听一遍要十几分钟，按复用策略没有再听（真要重听说 VISION_BOTS_ASR_FRESH=1），纠错按新术语表重跑`)
    else log(`复用上次的原始转写：${raw.length} 词；纠错层换过版本（${cached.fixer || '旧版'} → ${FIXER_VERSION}）或术语表变了，只重跑纠错`)
  }
  if (!words) {
    if (!raw) {
      if (hot) log('热词注入：' + hot)
      const t0 = Date.now()
      log('转写中（faster-whisper，本地 CPU）')
      // 原始转写留一份给审计，纠错后的才是下游真正用的 transcript.json
      const asr = await transcribe(wav, { out: join(work, 'asr-raw.json'), model: brief.asrModel || 'small', hotwords: hot })
      raw = asr.json.words
      rawSegments = asr.json.segments
      asrSeconds = (Date.now() - t0) / 1000
      language = asr.json.language || 'zh'
      log(`转写完成：${raw.length} 词 · ${asrSeconds.toFixed(1)}s`)
    }
    // 第二层治理：受约束纠错。只改词文本，时间码和词数由模块内部断言
    const fix = await correct({
      words: raw, terms, log, segments: rawSegments,
      media: input, envelope,
      relistenDir: join(group.dir, 'cache', 'relisten'),
      hints,
    })
    // 线索已消费：这次已经重听过，别再让它影响下一次
    if (hints.length) { try { writeFileSync(hintPath, JSON.stringify({ hints: [], consumedAt: new Date().toISOString() }, null, 1), 'utf8') } catch { /* ignore */ } }
    // 把这一轮耳朵定过的句子记下来，下次重剪照样先听一遍（不然修好的字会退回去）
    try {
      const spans = (fix.report && fix.report.relisten && fix.report.relisten.spans) || []
      const quotes = []
      for (const s of spans) {
        if (!(s.applied || s.confirmed)) continue
        // 两条都记：改完的文字（下一轮正常命中）和改前的文字（万一这一轮没改上，下一轮还能定位）
        for (const q of [s.text, s.mine]) {
          const t = String(q || '').slice(0, 24)
          if (t && !quotes.includes(t)) quotes.push(t)
        }
      }
      // 合并而不是覆盖：上一轮的复核点下一轮还要再确认一次，覆盖会让修好的字过两轮又退回去。
      const keep = carried.filter(q => !quotes.includes(q))
      writeFileSync(carryPath, JSON.stringify({ at: new Date().toISOString(), quotes: [...quotes, ...keep].slice(0, 14) }, null, 1), 'utf8')
    } catch { /* 记账失败不影响出片 */ }
    words = fix.words
    fixReport = fix.report
    // 句子文本也要跟着纠错走，否则大字用的还是错的（字幕改了、片子里没改）
    segments = applyToSegments(words, rawSegments)
    writeCutCache({ dir: group.dir, input, terms, brief, raw: { words: raw, segments: rawSegments, language, asrSeconds }, words, segments, fixReport })
  }
  // 缓存怎么用的要进台账：客户看到「12 分钟转写被跳过」时得知道热词没重听
  fixReport.cache = { mode: reused ? 'all' : (reusedRaw ? 'fix-only' : 'none'), staleHotwords: staleHot, fresh: forceFresh }
  const fixPath = join(work, 'fix-report.json')
  writeFileSync(fixPath, JSON.stringify(fixReport, null, 2), 'utf8')
  artifact('fix', fixPath, { changed: fixReport.stats.changed, pending: fixReport.stats.pending, reused, staleHot })

  // 剪辑的所有口径来自它自己的配置（config/bots/cutter.json），不是散在代码里的常量。
  // 只有用户明确说的东西（语速）才算覆盖。
  const cutParams = paramsOf('cutter')
  const planOpts = {
    pauseThreshold: brief.pauseThreshold ?? cutParams.pauseThreshold,
    keepHead: cutParams.keepHead,
    keepTail: cutParams.keepTail,
    minSegment: cutParams.minSegment,
    leadIn: cutParams.leadIn,
    tailOut: cutParams.tailOut,
    gap: cutParams.gap,
    seam: cutParams.seam,
    dedupe: cutParams.dedupe,
    filler: cutParams.filler,
    maxDeleteShare: cutParams.maxDeleteShare,
    envelope,
    speed: brief.speed ?? 1,
  }
  let plan = buildPlan(words, info.duration, planOpts)

  // ── 内容预算：目标时长真正进剪辑决策 ──
  // 以前到这一步就结束了：删完气口是多少就交多少。用户要 60 秒、拿到 66.5 秒，
  // 根因不是素材，是 buildPlan 里根本没有 target。这里补「整句删」：
  // 模型提案哪几句是铺垫/重复，规则挡住不许删的（钩子、落点、主张、唯一数字），
  // 然后按「离目标最近」选一组删掉，重算一版保留区间。
  const pruneParams = { ...(cutParams.prune || {}) }
  const targetSec = Number(brief.duration) || 0
  let prune = null
  if (targetSec && pruneParams.enabled !== false) {
    const tol = Number(pruneParams.tolerance) || 0.02
    const rounds = Math.max(1, Math.min(3, Number(pruneParams.maxRounds) || 2))
    const fit = d => d <= targetSec * (1 + tol)
    const before = Number(plan.outDuration.toFixed(2))
    let cur = plan
    const applied = []   // 累积的整句删：第二轮只能往第一轮上加，不能把第一轮删过的句子又放回去
    const all = []
    let last = null
    for (let k = 0; k < rounds; k++) {
      if (fit(cur.outDuration)) {
        if (k === 0) log('选句删：成片 ' + cur.outDuration.toFixed(2) + 's 已经在目标 ' + targetSec + 's 以内，不删内容')
        break
      }
      if (k === 0) group.emit({ type: 'progress', bot: 'cutter', text: '剪辑在挑整句删：成片 ' + cur.outDuration.toFixed(1) + 's，目标 ' + targetSec + 's', transient: true })
      const pr = await planPrune({ segments, words, plan: cur, target: targetSec, terms, params: pruneParams, log })
      if (pr) last = pr
      if (!pr || !pr.picks || !pr.picks.length) break
      const ranges = pr.picks.map(x => ({ i0: Number(x.i0), i1: Number(x.i1), reason: 'content', text: x.text }))
      const bad = ranges.find(r => !Number.isInteger(r.i0) || !Number.isInteger(r.i1))
      if (bad) throw new Error('整句删丢了词下标：' + JSON.stringify(bad) + '（prune 返回的 picks 必须有 i0/i1）')
      applied.push(...ranges)
      all.push(...pr.picks)
      cur = buildPlan(words, info.duration, { ...planOpts, ranges: applied })
      log('选句删第 ' + (k + 1) + ' 轮：删 ' + applied.length + ' 句后成片 ' + cur.outDuration.toFixed(2) + 's（目标 ' + targetSec + 's）')
      if (fit(cur.outDuration)) break
    }
    prune = last
      ? { ...last, before, after: Number(cur.outDuration.toFixed(2)), picks: all, rounds: applied.length ? (last.rounds || 1) : 0 }
      : null
    if (prune) {
      prune.delta = Number((cur.outDuration - targetSec).toFixed(2))
      prune.hit = fit(cur.outDuration)
      // 删完还是不达标、而上一轮说「可删的都删完了」，才算真删不动（质检靠这一条放过超时）
      // 「能删的都删完了」有两种形态：上一轮自己判定删完了，或者最后一轮一句都没删成
      // （模型提的都被规则挡了 / 模型没再提）。只看 last.exhausted 会漏掉后一种，
      // 于是质检把「真删不动」判成「还有整句可删，没删够」——自测23 第一次跑就是这样。
      prune.exhausted = !prune.hit && Boolean(last && (last.exhausted || !(last.picks || []).length))
      plan = cur
    }
  }
  const delLabel = { repeat: '重复', filler: '口头语', mistake: '口误', content: '整句删' }
  if (plan.deletions.length) {
    const by = Object.entries(plan.byReason).map(([k, n]) => (delLabel[k] || k) + ' ' + n).join(' / ')
    log('删词 ' + plan.deletions.length + ' 处（' + by + '），' + plan.deletedChars + ' 字、约 ' + plan.deletedSec + 's：' +
      plan.deletions.slice(0, 6).map(d => '「' + d.text + '」@' + d.from + 's').join('、') + (plan.deletions.length > 6 ? ' 等' : ''))
  }
  const captions = buildCaptions(words, plan, { maxChars: brief.maxChars ?? 14 })

  // 内容预算的结论挂到 plan 上：质检要用它判断「超时」是真删不动，还是根本没试
  if (prune) {
    plan.prune = {
      target: targetSec,
      before: prune.before,
      after: prune.after,
      cuts: (prune.picks || []).length,
      hit: Boolean(prune.hit),
      exhausted: Boolean(prune.exhausted),
      widened: Boolean(prune.widened),
      texts: (prune.picks || []).map(x => x.text),
      model: prune.model ? (prune.model.model || prune.model.skipped || null) : null,
    }
  }
  writeFileSync(join(work, 'plan.json'), JSON.stringify(plan, null, 1), 'utf8')
  if (prune) {
    writeFileSync(join(work, 'prune.json'), JSON.stringify(prune, null, 1), 'utf8')
    artifact('prune', join(work, 'prune.json'), { cuts: (prune.picks || []).length, after: plan.outDuration })
  }
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

  // 句级大字：模型提案，接地校验（每个字都必须来自这一句自己）。
  // 时间码还是时间码：模型只产出文本，句子边界仍由 whisper 的时间戳决定；
  // 大字在句子开头换，所以画面上不会出现「说到下一句了、大字还停在上一句」。
  const secs = sectionsOf({ segments, plan })
  // 大字的上屏单位 = 字幕卡：字幕换卡那一刻大字就换，两套边界不许各切各的
  // （按 whisper 段切过一次，一段塞进 4 张卡、8.9 秒不换字，用户 2026-11-24 否掉）
  const sents = captions.cards.map((c, i) => ({ index: i + 1, start: c.start, end: c.end, text: c.text }))
  const budget = bigBudget(group.meta.template || brief.template, brief.ratio)
  if (budget && sents.length) {
    group.emit({ type: 'progress', bot: 'cutter', text: '剪辑在给 ' + sents.length + ' 张字幕卡起大字…', transient: true })
    const t = await titleSentences({ sentences: sents, log })
    state.sentenceTitles = t.titles
    brief.sentenceTitles = t.titles
    state.titleStats = t.stats || null
    const adopted = t.titles.filter(x => x.source === 'model')
    log('句级大字：' + t.titles.map(x => x.index + '「' + x.text + '」').join(' '))
    group.emit({ type: 'progress', bot: 'cutter', text: '大字定了 ' + adopted.length + ' / ' + sents.length + ' 句（模型），其余按原文摘句', transient: true })
  }

  // 分镜：这一段用哪种版式、章节名叫什么、要不要加图形块 —— 剪辑提案，规则校验（src/shots.mjs）。
  // 只对画布模板做（有 big 布局的才算「有设计」），PPT 底座那种章节卡按契约用原话，不需要。
  if (budget && captions.cards.length) {
    group.emit({ type: 'progress', bot: 'cutter', text: '剪辑在排分镜：哪几秒让位给字、哪句做成全屏字卡…', transient: true })
    const skel = pageSkeleton({ segments, plan, cards: captions.cards.map(c => ({ text: c.text, start: c.start, end: c.end })), duration: plan.outDuration, hotwords: (terms && terms.hotwords) || [] })
    const sp = await planPages({ pages: skel, log })
    state.shots = sp
    brief.shots = sp
    const used = sp.pages.filter(p => p.shot !== 'full').length
    const blocks = sp.pages.filter(p => p.block).length
    log('分镜落定：' + sp.pages.length + ' 页，' + used + ' 页换版式，图形块 ' + blocks + ' 个' + (sp.problems && sp.problems.length ? '；打回 ' + sp.problems.length + ' 条' : ''))
    group.emit({ type: 'progress', bot: 'cutter', text: '分镜定了 ' + sp.pages.length + ' 页：' + used + ' 页换版式、' + blocks + ' 个图形块', transient: true })
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
    shots: state.shots || null,
    sentenceTitles: state.sentenceTitles || null,
  }), 'utf8')

  const fixed = fixReport.applied
  const pending = fixReport.pending
  if (narrate) group.say('cutter',
    `读完了：${info.duration.toFixed(1)}s 素材，${words.length} 个词，剪掉 ${plan.cutSeconds.toFixed(1)}s（${plan.removedPauses} 个长停顿` +
    (plan.deletions.length ? ` + ${plan.deletions.length} 处删词：` + Object.entries(plan.byReason).map(([k, n]) => (delLabel[k] || k) + ' ' + n).join('、') : '') +
    `），成片 ${plan.outDuration.toFixed(1)}s，${plan.keep.length} 段。` +
    (prune && prune.picks && prune.picks.length
      ? `\n为了让片子进 ${targetSec}s，我整句删了 ${prune.picks.length} 句（${prune.before.toFixed(1)}s → ${plan.outDuration.toFixed(1)}s）：` +
        prune.picks.map(x => `「${x.text.slice(0, 12)}」${x.why ? '（' + x.why + '）' : ''}`).join('、') + '。' +
        (prune.hit ? '' : `\n删完还是 ${plan.outDuration.toFixed(1)}s，差 ${(plan.outDuration - targetSec).toFixed(1)}s——能删的整句都删完了，再删就伤到观点。`)
      : '') +
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
    prune: prune && prune.picks && prune.picks.length
      ? {
        cuts: prune.picks.length,
        sec: Number(prune.picks.reduce((n, x) => n + (Number(x.dur) || 0), 0).toFixed(1)),
        hit: Boolean(prune.hit),
        texts: prune.picks.map(x => x.text.slice(0, 14)),
        why: prune.picks.map(x => x.why || ''),
        refused: prune.refusedCount || 0,
        exhausted: Boolean(prune.exhausted),
      }
      : null,
    segments: plan.keep.length,
    deletions: plan.deletions.length,
    deletedChars: plan.deletedChars,
    deletedSec: plan.deletedSec,
    byReason: plan.byReason,
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
  // 原始转写只看素材 + 识别模型；术语表不再参与这一层（它就是「不敢改术语表」的根源）
  if ((c.asrModel || 'small') !== (brief.asrModel || 'small')) return null
  const rawHit = Boolean(c.raw && Array.isArray(c.raw.words) && c.raw.words.length && Array.isArray(c.raw.segments))
  // 旧缓存没有记热词串（undefined）→ 当成没变，别让一次升级把已有缓存全废掉
  const hotChanged = typeof c.hot === 'string' ? c.hot !== hotwordPrompt(terms) : false
  const fixHit = rawHit && c.fixer === FIXER_VERSION && c.terms === termsHash(terms) &&
    Array.isArray(c.words) && Array.isArray(c.segments) && c.fixReport && c.fixReport.stats
  if (!rawHit && !fixHit) return null
  return { ...c, fixHit, rawHit, hotChanged }
}

function writeCutCache({ dir, input, terms, brief, raw, words, segments, fixReport }) {
  const st = statSync(input)
  const p = join(dir, 'work', 'cut-cache.json')
  writeFileSync(p, JSON.stringify({
    version: 1,
    at: new Date().toISOString(),
    asset: { size: st.size, mtimeMs: st.mtimeMs },
    terms: termsHash(terms),
    hot: hotwordPrompt(terms),
    asrModel: brief.asrModel || 'small',
    fixer: FIXER_VERSION,
    language: raw.language || 'zh',
    asrSeconds: raw.asrSeconds || 0,
    raw: { words: raw.words, segments: raw.segments, language: raw.language || 'zh', asrSeconds: raw.asrSeconds || 0 },
    words, segments, fixReport,
  }), 'utf8')
}