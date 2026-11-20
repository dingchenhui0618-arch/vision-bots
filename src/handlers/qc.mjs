/** 质检：每条结论必须带帧号和数值。没有证据不许说通过。 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { qa } from '../qa.mjs'
import { renderStill } from '../render.mjs'
import { probe } from '../probe.mjs'

export async function runQc({ group, job, log, artifact, brief, state }) {
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

  const report = await qa({ file: state.video, plan: state.plan, captions: state.captions, targetDuration: brief.duration || null, asrFix: state.fixReport || null })
  report.frames = frames
  state.report = report
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
    group.say('qc', `${report.checks.length} 项全过。` + passed.map(c => `\n· ${c.detail}`).join('') + `\n抽了 ${frames.length} 帧：f1 ${frames[0].t}s / f3 ${frames[2].t}s / f5 ${frames[4].t}s。可以直接发。`, { job: job.id })
  } else {
    const bad = report.checks.filter(c => !c.ok)
    const withFrame = bad.filter(c => c.evidence && c.evidence.file)
    group.say('qc', `不通过，${bad.length} 项有问题：` + bad.map(c => `\n· ${c.id}：${c.detail}${c.evidence && c.evidence.file ? `（帧 ${c.evidence.frame}，已附）` : ''}`).join('') +
      `\n抽了 ${frames.length} 帧全在报告里${withFrame.length ? '，' + withFrame.length + ' 项带了定位帧' : '，数值类问题看报告里的数字'}。`, { job: job.id })
  }

  return report
}
