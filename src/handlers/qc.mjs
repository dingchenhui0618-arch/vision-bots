/** 质检：每条结论必须带帧号和数值。没有证据不许说通过。 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { qa, BAR } from '../qa.mjs'
import { grabFilmFrames } from '../frame-audit.mjs'
import { layoutBoxes, boxesAtTime } from '../layout-boxes.mjs'
import { renderStill } from '../render.mjs'
import { probe } from '../probe.mjs'
import { reviewText } from '../qa-semantic.mjs'
import { loadTerms } from '../asr-fix.mjs'

const TPL_ROOT = fileURLToPath(new URL('../../templates/', import.meta.url))

export async function runQc({ group, job, log, artifact, brief, state, narrate = true }) {
  if (!state.video) throw new Error('没有成片可查')
  const dir = join(group.dir, 'work', job.id, 'frames')
  mkdirSync(dir, { recursive: true })

  const info = await probe(state.video)
  const dur = info.duration
  const times = [0.3, dur * 0.25, dur * 0.5, dur * 0.75, Math.max(0.3, dur - 0.3)]
  const frames = []
  for (let i = 0; i < times.length; i++) {
    const file = join(dir, `f${i + 1}.jpg`)
    await renderStill(state.video, times[i], file)
    frames.push({ t: Number(times[i].toFixed(2)), frame: Math.round(times[i] * info.fps), file })
  }
  artifact('audit', frames[2].file, { frames: frames.length })

  // ── 画面审计：盒子从版式数据算（不依赖浏览器），像素从成片里抽 ──
  // 以前问渲染器要盒子：要在机器紧张时再起一次 Chrome，起不来质检就整个失效（2026-11-23 实测踩到）。
  let boxes = null, layout = null, lbItems = null
  if (state.scene && state.templateId) {
    try {
      const tplPath = join(TPL_ROOT, state.templateId, 'template.json')
      const tpl = JSON.parse(readFileSync(tplPath, 'utf8').replace(/^\uFEFF/, ''))
      const lb = layoutBoxes({ scene: state.scene, template: tpl })
      if (lb.ok) {
        const step = Math.max(1, Math.round(state.scene.fps * 0.4))
        const samples = boxesAtTime(lb.items, state.scene.fps, 0, state.scene.frames - 1, step)
        boxes = samples.flatMap(s => s.list.map(b => ({ ...b, frame: s.frame })))
        // 盒子带上真实时间窗（lb.items 的 t0/t1），对比度才能「在每个盒子自己的时刻」量
        layout = { ...lb.layout, items: lb.items }
        lbItems = lb.items
        log('画面布局：' + lb.items.length + ' 个元素，' + samples.length + ' 个采样帧')
      } else {
        log('画面布局算不出：' + lb.reason)
      }
    } catch (e) { log('画面布局失败：' + e.message) }
  }

  let pxFrames = null
  if (boxes && boxes.length) {
    const uniq = [...new Set(boxes.map(b => b.frame))]
    const pick = []
    // 分辨率要够：216×384 时 22px 的 HUD 只剩 4px，字和 pill 的边界被缩放糊掉，
    // 「非文字像素中位数」会把抗锯齿像素算成背景，量出来的对比度严重偏低（假失败）。
    // 抽哪几帧：以前均匀抽 16 帧，于是和对比度有关的盒子大半「在样帧里没有出现」
    // （每条字幕只活 2.7 秒、每条大字 3 秒，16 帧摊到 59 秒上根本对不上）。
    // 现在每个要量对比度的盒子各取一次自己的中点——盒子在哪一刻真的在屏上，就量那一刻。
    const wantTags = new Set(['big', 'sub', 'rail', 'hud:rec', 'hud:sec'])
    const midFrames = new Set()
    for (const it of lbItems || []) {
      if (!wantTags.has(it.tag) || it.t0 == null || it.t1 == null) continue
      midFrames.add(Math.max(0, Math.round(((it.t0 + it.t1) / 2) * state.scene.fps)))
    }
    const sortedMid = [...midFrames].sort((a, b) => a - b)
    const stepMid = Math.max(1, Math.ceil(sortedMid.length / 200))
    for (let i = 0; i < sortedMid.length; i += stepMid) pick.push(sortedMid[i])
    const stride = Math.max(1, Math.ceil(uniq.length / 16))
    for (let i = 0; i < uniq.length; i += stride) if (!pick.includes(uniq[i])) pick.push(uniq[i])
    try { pxFrames = await grabFilmFrames({ file: state.video, frames: pick, size: [540, 960] }) } catch (e) { log('像素采样失败：' + e.message) }
  }

  // 语义层：模型读字幕全文。它只能加严——产出的问题进「新增失败项」，删不掉任何数值检查。
  let semantic = null
  try {
    semantic = await reviewText({
      words: (state.transcript && state.transcript.words) || [],
      captions: state.captions,
      // 不把 scene.sections 传给语义审读：段落文本来自 whisper 的整段句子，里面还带着
      // 「已经剪掉的那一句」（删词只动 plan.keep，不动转写）。传进去模型就会报
      // 「重复句：但是AI来去做内容」——片子里其实只剩一遍（2026-11-24 自测06 实测踩到）。
      // 它该看的是交付字幕卡本身；大字是这些卡的压缩词，不构成新的文案来源。
      sections: [],
      brief, terms: loadTerms(group.dir), log,
      // 听音复核仲裁要源素材：语义审读提的改法必须拿音频对一次（没有更强模型时会明说没验）
      media: (state.source && state.source.file) || null,
      relistenDir: join(group.dir, 'cache', 'relisten'),
    })
  } catch (e) {
    semantic = { ok: false, skipped: 'exception', detail: e.message }
    log('语义审读异常：' + e.message)
  }

  const report = await qa({
    file: state.video, plan: state.plan, captions: state.captions,
    targetDuration: brief.duration || null, asrFix: state.fixReport || null,
    scene: state.scene || null, boxes, layout, frames: pxFrames, source: state.source || null,
    engine: state.templateId ? 'canvas' : 'ffmpeg',
    semantic,
  })
  report.semantic = {
    ok: semantic.ok, skipped: semantic.skipped || null, model: semantic.model || null,
    ms: semantic.ms || null, tokens: semantic.tokens || null,
    stats: semantic.stats || null, issues: (semantic.issues || []), dropped: (semantic.dropped || []),
  }
  report.frames = frames
  state.report = report

  // 音频与字幕不一致的地方 = 真的听错了/吞字了。写成返工线索：下次剪辑先把这几句重听一遍，
  // 而不是让助手凭猜去改字（听音复核定案，四遍纠错照样不改时间码）。
  try {
    // 两类都要进线索：①音频与字幕不一致（听错了）；②模型给了逐字改法但过不了逐词校验的
    // （「AI是带」→「AI时代」：两字都同音，只是跨了词，四遍纠错的逐词规则改不了）。
    // 线索只负责「把这几句重听一遍」，改不改由听音复核的证据说了算。
    // 字数不一样的建议同样要写成线索：以前只收「等字数」的（因为四遍纠错只能等字数替换），
    // 于是「指纹住在→真正在做」这类字数变了、又确实可能听错的句子，从来不会被重听。
    // 线索只负责「把这句重听一遍」，能不能改由音频证据说了算——所以字数是不是一样不该是门槛。
    const diffs = (semantic.issues || []).filter(i =>
      (i.audioReview && i.audioReview.text && i.audioReview.tier === 'strong' && i.audioReview.contradicted === false) ||
      (i.to && i.quote)).slice(0, 8)
    report.hintWrite = { issues: (semantic.issues || []).length, hints: diffs.length, quotes: diffs.map(i => String(i.quote || '').slice(0, 20)) }
    log('质检线索：语义层 ' + (semantic.issues || []).length + ' 条疑似，其中 ' + diffs.length + ' 条值得重听')
    if (diffs.length) {
      writeFileSync(join(group.dir, 'revise-hints.json'), JSON.stringify({
        at: new Date().toISOString(),
        // 线索可能只是模型给的一条改法（没有听音信息），所以 audioReview 必须容错——
        // 原来这里无条件下标 .text，一遇到纯语义线索就抛异常，线索一条都写不出去（静默失败）。
        hints: diffs.map(i => ({ quote: i.quote, audio: (i.audioReview && i.audioReview.text) || null, at: i.at })),
      }, null, 1), 'utf8')
      log('质检线索：' + diffs.length + ' 处音频与字幕不一致，已写成返工线索（下次剪辑优先重听）')
    }
  } catch (e) { log('写质检线索失败：' + e.message) }
  const reportPath = join(group.dir, 'work', job.id, 'report.json')
  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')
  artifact('report', reportPath)

  // 失败项尽量挂帧证：能定位到时间点的，直接给那一帧
  const evidence = report.checks.filter(c => !c.ok && c.evidence && typeof c.evidence.lufs !== 'number')
  for (const c of evidence.slice(0, 2)) {
    const t = (c.evidence.long && c.evidence.long[0] && c.evidence.long[0].start) || dur / 2
    const file = join(dir, `${c.id}.jpg`)
    try { await renderStill(state.video, t, file); c.evidence.frame = Math.round(t * info.fps); c.evidence.file = file } catch { /* 帧证是加分项，失败不阻断 */ }
  }

  const passed = report.checks.filter(c => c.ok)
  if (report.passed) {
    if (narrate) group.say('qc', `${report.checks.length} 项全过。` + passed.map(c => `\n· ${c.detail}`).join('') + `\n抽了 ${frames.length} 帧：f1 ${frames[0].t}s / f3 ${frames[2].t}s / f5 ${frames[4].t}s。可以直接发。`, { job: job.id })
  } else {
    const bad = report.checks.filter(c => !c.ok)
    const withFrame = bad.filter(c => c.evidence && c.evidence.file)
    if (narrate) group.say('qc', `不通过，${bad.length} 项有问题：` + bad.map(c => `\n· ${c.id}：${c.detail}${c.evidence && c.evidence.file ? `（帧 ${c.evidence.frame}，已附）` : ''}`).join('') +
      `\n抽了 ${frames.length} 帧全在报告里${withFrame.length ? '，' + withFrame.length + ' 项带了定位帧' : '，数值类问题看报告里的数字'}。`, { job: job.id })
  }

  // 给 bot 说话用的事实：每项检查的结论和数字都在 checks 里
  const failedChecks = report.checks.filter(c => !c.ok)
  const targetChk = report.checks.find(c => c.id === 'target')
  return {
    ...report,
    narrative: {
      template: state.templateId || (group.meta.template || null),
      ratio: state.scene ? state.scene.ratio : null,
      width: state.scene ? state.scene.width : (state.source ? state.source.width : null),
      height: state.scene ? state.scene.height : (state.source ? state.source.height : null),
      checks: report.checks.length,
      passed: report.checks.filter(c => c.ok).length,
      failed: failedChecks.map(c => ({ id: c.id, detail: c.detail })),
      frames: frames.length,
      frameList: frames.map(f => ({ t: f.t, frame: f.frame })),
      // 差额由管线算好给出来：模型自己减会算出没出处的数，被校验器拦，白跑一轮
      targetSec: targetChk ? (Number(brief.duration) || null) : null,
      outSec: targetChk ? Number(dur.toFixed(1)) : null,
      gapSec: targetChk ? Number(Math.abs(dur - (Number(brief.duration) || dur)).toFixed(1)) : null,
      duration: targetChk && targetChk.evidence ? targetChk.evidence : null,
      semanticIssues: report.semantic && Array.isArray(report.semantic.issues)
        ? report.semantic.issues.slice(0, 6).map(i => ({ at: i.at, kind: i.kind, text: i.text }))
        : null,
      fix: state.fixReport && state.fixReport.applied ? { changed: state.fixReport.applied.length, pending: (state.fixReport.pending || []).length } : null,
      semantic: report.semantic ? { ok: report.semantic.ok, skipped: report.semantic.skipped, issues: (report.semantic.issues || []).length } : null,
    },
  }
}