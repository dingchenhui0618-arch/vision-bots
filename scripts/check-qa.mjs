#!/usr/bin/env node
/**
 * 质检规矩的自检：每条规矩都要能被一个具体坏例子打红。
 * 打不红的规矩就是没有的规矩（2026-11-23 用户否掉「6/6 全过」那版之后加的这道闸）。
 *
 * 用法：node scripts/check-qa.mjs
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ff } from '../src/ffmpeg.mjs'
import { qa, BAR, TARGET_TOLERANCE } from '../src/qa.mjs'
import { adjudicateByAudio } from '../src/qa-semantic.mjs'
import { cardLiveness } from '../src/frame-audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const TMP = join(ROOT, '.test', 'check-qa')
mkdirSync(TMP, { recursive: true })

const clip = join(TMP, 'clip.mp4')
if (!existsSync(clip)) {
  await ff(['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x101014:s=540x960:d=6:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6,volume=0.18', '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', clip])
}

let pass = 0, fail = 0
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  PASS ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

const plan = { keep: [[0, 6]], options: { speed: 1 }, sourceDuration: 6, keptSeconds: 6, cutSeconds: 0, removedPauses: 0 }
const cards = (n, text, each = 2) => Array.from({ length: n }, (_, i) => ({ start: i * each, end: i * each + each - 0.1, text: text(i), chars: [] }))
// 测试片是 540×960；盒子坐标按它给，别拿 1080×1920 的数字套
const goodBoxes = [
  { tag: 'big', x: 32, y: 630, w: 300, h: 60, frame: 0, t0: 0, t1: 5, outW: 540, outH: 960 },
  { tag: 'sub', x: 100, y: 800, w: 320, h: 50, frame: 0, t0: 0, t1: 5, outW: 540, outH: 960 },
  { tag: 'hud:rec', x: 20, y: 25, w: 130, h: 30, frame: 0, t0: 0, t1: 5, outW: 540, outH: 960 },
]
const darkFrames = [{ frame: 0, w: 54, h: 96, rgb: Buffer.alloc(54 * 96 * 3, 20) }]
const base = (extra = {}) => ({
  file: clip, plan, targetDuration: null, asrFix: null, scene: null, boxes: goodBoxes, layout: null, frames: darkFrames, source: null, engine: 'canvas',
  captions: { cards: cards(3, i => '第' + i + '句字幕内容占位'), coverage: { originalChars: 24, shownChars: 24, missing: 0 } },
  ...extra,
})

console.log('\n[1] 干净的一版：该过的都过')
{
  const r = await qa(base())
  ok(r.passed || r.failed.join() === 'loudness', '基础项全过（响度靠合成音，允许它不过）', r.failed.join(',') || 'none')
}

console.log('\n[2] 重复句（ASR 在同一段话上 loop）必须打红')
{
  const dup = { file: clip, plan, captions: { cards: [
    { start: 0, end: 1.9, text: '但是AI来去做内容', chars: [] },
    { start: 2, end: 3.9, text: '但是AI来去做内容', chars: [] },
    { start: 4, end: 5.9, text: '直到会做的人太少了', chars: [] },
  ], coverage: { originalChars: 24, shownChars: 24, missing: 0 } }, engine: 'canvas' }
  const r = await qa(dup)
  const c = r.checks.find(x => x.id === 'duplicate_lines')
  ok(c && !c.ok, 'duplicate_lines 打红', c && c.detail)
}

console.log('\n[3] 段落节奏：22 章那种碎法必须打红，4 段要过')
{
  const many = { ...base(), scene: { sections: Array.from({ length: 22 }, (_, i) => ({ index: i + 1, start: i * 0.27, end: i * 0.27 + 0.27, text: 'x' })) } }
  const r = await qa(many)
  const c = r.checks.find(x => x.id === 'section_pace')
  ok(c && !c.ok, '22 段判不过', c && c.detail)
  const few = { ...base(), scene: { sections: Array.from({ length: 6 }, (_, i) => ({ index: i + 1, start: i * 4, end: i * 4 + 4, text: 'x' })) } }
  const r2 = await qa(few)
  const c2 = r2.checks.find(x => x.id === 'section_pace')
  ok(c2 && c2.ok, '6 段判通过', c2 && c2.detail)
}

console.log('\n[4] 版式契约：文字进了上半屏必须打红（光轨穿脸那条 bug 的判据）')
{
  const boxes = [
    { tag: 'big', x: 32, y: 150, w: 300, h: 60, frame: 0, t0: 0, t1: 5 },
    { tag: 'sub', x: 100, y: 800, w: 320, h: 50, frame: 0, t0: 0, t1: 5 },
  ]
  const r = await qa(base({ boxes }))
  const c = r.checks.find(x => x.id === 'layout_zone')
  ok(c && !c.ok, '大字在 300px 判不过', c && c.detail)
  const okBoxes = goodBoxes
  const r2 = await qa(base({ boxes: okBoxes }))
  const c2 = r2.checks.find(x => x.id === 'layout_zone')
  ok(c2 && c2.ok, '大字在下半区判通过', c2 && c2.detail)
}

console.log('\n[5] 盒子互压必须打红（大字压轨道）')
{
  const boxes = [
    { tag: 'big', x: 32, y: 620, w: 300, h: 80, frame: 3, t0: 0.1, t1: 0.1 },
    { tag: 'rail', x: 28, y: 640, w: 484, h: 30, frame: 3, t0: 0.1, t1: 0.1 },
  ]
  const r = await qa(base({ boxes }))
  const c = r.checks.find(x => x.id === 'layout_overlap')
  ok(c && !c.ok, 'layout_overlap 打红', c && c.detail)
}

console.log('\n[6] 低置信词占比：25/251 = 10% 必须打红，5/500 要过')
{
  const bad = { ...base(), asrFix: { applied: [], rejected: [], pending: Array.from({ length: 25 }, (_, i) => ({ w: '某', at: i })), assertion: { wordCount: true, timingUntouched: true }, stats: { words: 251 } } }
  const r = await qa(bad)
  const c = r.checks.find(x => x.id === 'asr_confidence')
  ok(c && !c.ok, '10% 判不过', c && c.detail)
  ok(c && /10\.0%/.test(c.detail), '比率写进结论', c && c.detail)
  const good = { ...base(), asrFix: { applied: [], rejected: [], pending: [{ w: '某', at: 1 }], assertion: { wordCount: true, timingUntouched: true }, stats: { words: 500 } } }
  const r2 = await qa(good)
  const c2 = r2.checks.find(x => x.id === 'asr_confidence')
  ok(c2 && c2.ok, '0.2% 判通过', c2 && c2.detail)
}

console.log('\n[7] 改字动了时间码必须打红')
{
  const r = await qa(base({ asrFix: { applied: [{ from: 'a', to: 'b', kind: 'homophone', at: 1 }], rejected: [], pending: [], assertion: { wordCount: true, timingUntouched: false }, stats: { words: 100 } } }))
  const c = r.checks.find(x => x.id === 'asr_confidence')
  ok(c && !c.ok, '时间码被动过判不过', c && c.detail)
}

console.log('\n[8] 字幕流：互相压着必须打红')
{
  const overlap = { file: clip, plan, captions: { cards: [
    { start: 0, end: 2.5, text: '第一句', chars: [] },
    { start: 2.0, end: 4.0, text: '第二句', chars: [] },
    { start: 4.2, end: 5.9, text: '第三句', chars: [] },
  ], coverage: { originalChars: 9, shownChars: 9, missing: 0 } }, engine: 'canvas' }
  const r = await qa(overlap)
  const c = r.checks.find(x => x.id === 'caption_flow')
  ok(c && !c.ok, 'caption_flow 打红', c && c.detail)
}

console.log('\n[9] 画布模板拿不到盒子 = 审计没做，必须打红；烧字幕路径单独列明')
{
  const r = await qa(base({ boxes: null, frames: null, engine: 'canvas' }))
  const c = r.checks.find(x => x.id === 'layout_overlap')
  ok(c && !c.ok, '没有盒子判不过', c && c.detail)
  const r2 = await qa(base({ boxes: null, frames: null, engine: 'ffmpeg' }))
  const c2 = r2.checks.find(x => x.id === 'layout_evidence')
  ok(c2 && c2.ok && /烧字幕/.test(c2.detail), '烧字幕路径如实列明', c2 && c2.detail)
}

console.log('\n[10] 门槛常量与容差')
{
  ok(BAR.sections[0] === 4 && BAR.sections[1] === 14, '段落区间 4–14')
  ok(BAR.confidence === 0.08, '低置信上限 8%')
  // 自测16 起收到 6%：剪辑有了整句删，能把片子真正剪到目标上；再放 12% 等于允许交超 7 秒的片子
  ok(TARGET_TOLERANCE === 0.06, '目标时长容差 6%（自测16 起，剪辑能整句删了）')
  ok(BAR.zone.bodyTop === 0.56, '文字只在下半区（56% 以下）')
}

console.log('\n[11] 听不出来 ≠ 字幕错了')
{
  // 没有素材就不动结论（保持原状）：这一条保证「仲裁层不跑」不会被当成放行
  const keep = await adjudicateByAudio({ issues: [{ severity: 'block', kind: 'homophone', quote: '甲', to: '乙' }], words: [{ w: '甲', start: 0, end: 0.3 }], media: null })
  ok(keep[0].severity === 'block', '没有素材时结论不变（不会静默放行）')
  // 语义建议但没给改法 → 只记录（实测连跑四轮报了四句不同的「语句不通」）
  const noFix = await adjudicateByAudio({ issues: [{ severity: 'block', kind: 'semantic', quote: '一句', to: null }], words: [{ w: '一句', start: 0, end: 0.3 }], media: 'x.mp4' })
  ok(noFix[0].severity === 'warn' && /没给具体改法/.test(String(noFix[0].why)), '没给改法的「语句不通」只记录')
  // 建议与原文一字不差 → 等于没改
  const same = await adjudicateByAudio({ issues: [{ severity: 'block', kind: 'homophone', quote: '甲乙', to: '甲乙' }], words: [{ w: '甲', start: 0, end: 0.3 }], media: 'x.mp4' })
  ok(same[0].severity === 'warn' && /一字不差/.test(String(same[0].why)), '建议与原文相同的只记录')
}

console.log('\n[12] 「没解决」要分清：没听过 / 音频与字幕不一致（自测26）')
{
  const r = await qa(base({ asrFix: {
    applied: [], rejected: [],
    pending: [{ w: '大', at: 4.08, why: 'never-heard' }, { w: '街', at: 4.52, why: 'never-heard' }, { w: '卷', at: 62.5, why: 'audio-differs' }],
    assertion: { wordCount: true, timingUntouched: true }, stats: { words: 248 },
  } }))
  const c = r.checks.find(x => x.id === 'asr_confidence')
  ok(c && /没听过 2 个、音频与字幕不一致 1 个/.test(String(c.detail)), '两类分开计数写进 detail', c && c.detail)
  ok(c && c.evidence && c.evidence.never === 2 && c.evidence.differs === 1, '证据里带两个数', JSON.stringify(c && c.evidence))
  ok(c && c.ok === true, '3/248 = 1.2%，数量本身仍在门槛内 → 通过', c && c.detail)
}

console.log('\n[13] 字卡页的人还在不在（自测28）')
{
  // 对比度越高不等于画面越好：把底压黑，白字对比度反而更高。
  // 这一条量的是「字卡上半区相对满幅页的亮度」——人还在不在。
  const shots13 = [{ f0: 0, f1: 1, kind: 'full' }, { f0: 1, f1: 4, kind: 'card' }, { f0: 4, f1: 6, kind: 'full' }]
  const mk = (n, v) => { const b = Buffer.alloc(54 * 96 * 3); b.fill(v); return { frame: n, w: 54, h: 96, rgb: b } }
  const crushed = cardLiveness({ frames: [mk(15, 150), mk(45, 60)], shots: shots13, fps: 30 })
  ok(crushed.ok === false && Math.round((crushed.ratio || 0) * 100) === 40, '虚化压暗的字卡（60/150=40%）判不过', JSON.stringify(crushed))
  const alive = cardLiveness({ frames: [mk(15, 150), mk(45, 145)], shots: shots13, fps: 30 })
  ok(alive.ok === true && Math.round((alive.ratio || 0) * 100) === 97, '人清楚的卡（145/150=97%）判过', JSON.stringify(alive))
  const none = cardLiveness({ frames: [mk(15, 150)], shots: [{ f0: 0, f1: 6, kind: 'full' }], fps: 30 })
  ok(none.ok === true && /没有全屏字卡/.test(String(none.reason)), '没有字卡的片子不新增这一项', none.reason)
  const noFx = cardLiveness({ frames: [], shots: shots13, fps: 30 })
  ok(noFx.ok === false && /没取到成片像素/.test(String(noFx.reason)), '没有像素判不过（不许当通过）', noFx.reason)
  // 接到 qa() 上：真跑一遍，报告里要有这条，而且压暗那版要被打红
  const scene13 = { size: [540, 960], fps: 30, shots: shots13, duration: 6 }
  const r1 = await qa(base({ scene: scene13, frames: [mk(15, 150), mk(45, 145)] }))
  const c1 = r1.checks.find(x => x.id === 'card_subject')
  ok(c1 && c1.ok === true, '质检报告里出现 card_subject 且通过', c1 && c1.detail)
  const r2 = await qa(base({ scene: scene13, frames: [mk(15, 150), mk(45, 60)] }))
  const c2 = r2.checks.find(x => x.id === 'card_subject')
  ok(c2 && c2.ok === false, '同一版画面被压暗后质检打红', c2 && c2.detail)
}

console.log('\n' + (fail ? 'FAIL ' : 'PASS ') + pass + ' 条通过 / ' + fail + ' 条失败')
process.exit(fail ? 1 : 0)