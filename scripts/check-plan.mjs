/**
 * 剪辑表 v2 自检：删词规则、停机分级、能量接缝、不切词、不丢字。
 *
 * 全部是合成数据 + 合成包络，不碰素材、不转写、不渲染，几秒钟跑完。
 * 真素材上的对照在 docs/PROGRESS.md 里（38.24s 那句重复）。
 */
import { buildPlan } from '../src/plan.mjs'
import { buildCaptions } from '../src/captions.mjs'

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { if (cond) { pass++; console.log('  ✓ ' + name) } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')) } }
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol

/** 造词：texts 按顺序排，每个词 dur 秒，词间 gap 秒 */
function make(texts, { dur = 0.25, gap = 0.05, start = 0.2, longAt = {} } = {}) {
  const words = []
  let t = start
  texts.forEach((w, i) => {
    words.push({ w, start: +t.toFixed(3), end: +(t + dur).toFixed(3) })
    t += dur + (longAt[i] != null ? longAt[i] : gap)
  })
  return { words, total: t + 0.3 }
}
const fillerCfg = { enabled: true, minGapSec: 0.12, words: ['嗯', '啊'], markers: ['那个'] }

// ── 1. 相邻重复：删后一遍，留前一遍
{
  const { words, total } = make(['我们', '今天', '聊', '剪', '辑', '我们', '今天', '聊', '剪', '辑', '好'])
  const p = buildPlan(words, total, { dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 }, filler: { enabled: false } })
  const del = p.deletions.filter(d => d.reason === 'repeat')
  ok(del.length === 1 && del[0].text === '我们今天聊剪辑', '相邻重复删一遍（后一遍）', JSON.stringify(p.deletions))
  ok(del[0].from > words[0].start + 1, '删的是后一遍（位置在后）', 'from=' + del[0].from)
  ok(p.seamCuts >= 1, '重复删除产生一个接缝刀口')
}
// ── 2. 中间隔太久的不算重复（不是紧邻）
{
  const { words, total } = make(['我们', '今天', '聊', '剪', '辑', '我们', '今天', '聊', '剪', '辑'], { longAt: { 4: 1.5 } })
  const p = buildPlan(words, total, { dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 }, filler: { enabled: false } })
  ok(p.deletions.filter(d => d.reason === 'repeat').length === 0, '隔了 1.5s 的重复不删（那是强调，不是口误）')
}
// ── 3. 太短的重复不删（好 好 好）
{
  const { words, total } = make(['好', '好', '好', '很', '好'])
  const p = buildPlan(words, total, { dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 }, filler: { enabled: false } })
  ok(p.deletions.length === 0, '少于 4 个字的重复不删')
}
// ── 4. 口头语：语气词一侧有停顿就删
{
  const { words, total } = make(['今天', '嗯', '聊', '片子'], { longAt: { 0: 0.3 } })
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg })
  ok(p.deletions.length === 1 && p.deletions[0].text === '嗯', '语气词在停顿里被删')
  ok(p.byReason.filler === 1, '按理由计数对得上')
}
// ── 5. 「那个人」是指示词，后面没停顿，不许删
{
  const { words, total } = make(['我觉得', '那个', '人', '很', '厉害'])
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg })
  ok(p.deletions.length === 0, '「那个」后面紧跟名词时不删（删了就改了原意）')
}
// ── 6. 「那个」说完停一下，才当口头语删
{
  const { words, total } = make(['我觉得', '那个', '人', '很', '厉害'], { longAt: { 1: 0.4 } })
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg })
  ok(p.deletions.length === 1 && p.deletions[0].text === '那个', '「那个」后面有停顿才算口头语')
}
// ── 7. 显式口误：按文本 + 大致时间定位
{
  const { words, total } = make(['国家', '数据', '集团', '中心', '挂牌', '了'], { longAt: { 2: 0.4 } })
  const p = buildPlan(words, total, { deletions: [{ text: '中心', reason: 'mistake' }], dedupe: { enabled: false }, filler: { enabled: false } })
  ok(p.deletions.length === 1 && p.deletions[0].reason === 'mistake', '显式口误进删除表')
  ok(p.deletions[0].from > 1, '定位到正确位置')
}
// ── 8. 显式删除找不到原文：不删，也不炸
{
  const { words, total } = make(['甲', '乙', '丙'])
  const p = buildPlan(words, total, { deletions: [{ text: '丁戊', reason: 'mistake' }], dedupe: { enabled: false }, filler: { enabled: false } })
  ok(p.deletions.length === 0 && p.keep.length >= 1, '找不到原文就跳过（宁可少删，不乱删）')
}
// ── 9. 删过头：超过 maxDeleteShare 退回口头语
{
  const { words, total } = make(['嗯', '啊', '嗯', '内容', '啊', '嗯'], { gap: 0.2 })
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg, maxDeleteShare: 0.3 })
  ok(p.deletions.length === 0, '删掉的字超过 30% 就退回口头语（那不是剪辑，是重写）', JSON.stringify(p.deletions))
}
// ── 10. 全片都是口头语也不能删空
{
  const { words, total } = make(['嗯', '啊', '嗯'])
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg })
  ok(p.keep.length >= 1 && p.outDuration > 0, '删到没有词时兜住（片子不能没声）')
}
// ── 11. 停机按标点分级：句号 0.30 / 逗号 0.22 / 无标点 0.20
{
  for (const [text, target, label] of [['好。', 0.3, '句号 0.30'], ['好，', 0.22, '逗号 0.22'], ['好', 0.2, '无标点 0.20']]) {
    const { words, total } = make([text, '下一句'], { longAt: { 0: 1.0 } })
    const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: { enabled: false } })
    const c = p.cuts[0]
    ok(c && near(c.to - c.from, 1.0 - target, 0.03), label + '：这一刀长度 = 空档 − 目标停顿', c ? (c.to - c.from).toFixed(3) + ' vs ' + (1.0 - target).toFixed(3) : 'no cut')
  }
}
// ── 12. 能量接缝：给了包络，刀口挪到安静处
{
  // 两个词，中间 1.0s 空档（0.7 → 1.7）；安静点放在吸附窗口内：0.85–0.89 和 1.55–1.59
  const words = [{ w: '说完了', start: 0.2, end: 0.7 }, { w: '下一句', start: 1.7, end: 2.2 }]
  const total = 2.5
  const hopSec = 0.005
  const db = new Float32Array(Math.ceil(total / hopSec) + 20).fill(-10)
  for (let i = 0; i < db.length; i++) {
    const x = i * hopSec
    if ((x >= 0.85 && x < 0.89) || (x >= 1.55 && x < 1.59)) db[i] = -60
  }
  const env = { db, hopSec }
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: { enabled: false }, envelope: env })
  const c = p.cuts[0]
  ok(c && c.from > 0.9 && c.to < 1.55, '刀口被吸到两个安静点之间（不是名义位置）', c ? c.from + '–' + c.to : 'no cut')
  ok(c && near(c.from, 0.95, 0.03) && near(c.to, 1.49, 0.03), '两侧各让一半，落在安静区内')
  const pn = buildPlan(words, total, { dedupe: { enabled: false }, filler: { enabled: false } })
  ok(pn.cuts[0].from === 0.8 && pn.cuts[0].to === 1.6, '没给包络时用名义值（0.8–1.6）', pn.cuts[0].from + '–' + pn.cuts[0].to)
}
// ── 13. 包络太窄：退回名义值，切口不许反过来
{
  const { words, total } = make(['说完', '下一句'], { longAt: { 0: 0.5 } })
  const hopSec = 0.005
  const db = new Float32Array(Math.ceil(total / hopSec) + 10).fill(-10)
  for (let i = 0; i < db.length; i++) { const t = i * hopSec; if (t >= 0.72 && t < 0.76) db[i] = -60 }
  const env = { db, hopSec }
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: { enabled: false }, envelope: env })
  for (const c of p.cuts) ok(c.to > c.from + 0.02, '切口方向永远是对的（to > from）', c.from + '–' + c.to)
  ok(p.cuts.length === 1, '安静区太窄时仍按名义值剪一刀')
}
// ── 14. 一刀都不许切在词内部
{
  const { words, total } = make(['今天我们', '聊聊', '剪辑', '这件事', '很难'])
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: { enabled: false }, pauseThreshold: 0.05 })
  let inside = 0
  for (const [a, b] of p.keep) for (const w of words) {
    if (a > w.start + 1e-6 && a < w.end - 1e-6) inside++
    if (b > w.start + 1e-6 && b < w.end - 1e-6) inside++
  }
  ok(inside === 0, '所有保留段边界都在词与词之间（没有切开一个词）')
}
// ── 15. 字幕一个字都不许丢
{
  const { words, total } = make(['嗯', '观众三秒就划走了', '所以', '开头很重要'])
  const p = buildPlan(words, total, { dedupe: { enabled: false }, filler: fillerCfg })
  const c = buildCaptions(words, p, {})
  ok(c.coverage.missing === 0, '删词之后字幕覆盖率仍是 100%', JSON.stringify(c.coverage))
  ok(!c.cards.some(k => /嗯/.test(k.text)), '被删的口头语不进字幕')
}
// ── 16. 真素材回归：折光那条的重复句（有 pipeline 就跑）
{
  try {
    const { readFileSync } = await import('node:fs')
    const pipe = JSON.parse(readFileSync('groups/group-08snn/pipeline.json', 'utf8'))
    const p = buildPlan(pipe.transcript.words, pipe.source.duration, { dedupe: { enabled: true, minWords: 3, minChars: 4, maxGapSec: 0.8 }, filler: fillerCfg })
    const dup = p.deletions.find(d => /但是AI来去做内容/.test(d.text))
    ok(Boolean(dup), '折光真素材：38s 那句「但是AI来去做内容」被抓到', JSON.stringify(p.deletions))
    ok(p.outDuration < pipe.plan.outDuration, '成片比原来短（' + p.outDuration.toFixed(2) + 's vs ' + pipe.plan.outDuration.toFixed(2) + 's）')
  } catch (err) {
    console.log('  · 跳过真素材回归（' + String(err.message).slice(0, 40) + '）')
  }
}

console.log('')
if (fail) { console.log('FAIL  ' + pass + ' 条通过，' + fail + ' 条不通过'); process.exit(1) }
console.log('PASS  ' + pass + ' 条全过（重复 / 口头语 / 口误 / 停机分级 / 能量接缝 / 不切词 / 不丢字）')