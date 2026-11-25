/**
 * 折光模板自检：版式编排的硬不变量。
 *   node scripts/check-zheguang.mjs                 用自测06群的真实数据（离线，不启动浏览器）
 *   node scripts/check-zheguang.mjs --group 07-xxxx 指定群
 *   node scripts/check-zheguang.mjs --render        额外跑一遍版式采样，验「大字不压字幕、块不压大字」
 *
 * 这一层只验「编排是否自洽」：页、版式、大字、图形块的边界和接地。
 * 观感（对比度、压脸）由质检从成片像素里量，不在这里假装。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildScene, chapterHoldUntil } from '../templates/zheguang/scene.mjs'
import { segment } from '../src/segment.mjs'
import { qaBoxes } from '../templates/zheguang/render.mjs'
import { layoutBoxes, pageAtFor } from '../src/layout-boxes.mjs'

const ROOT = process.cwd()
const argv = process.argv.slice(2)
const arg = (k, d = null) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d
}
const GROUP = arg('group', '06-0ivkz')
const DO_RENDER = Boolean(arg('render', false))
let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }

const pipe = JSON.parse(readFileSync(join(ROOT, 'groups', GROUP, 'pipeline.json'), 'utf8'))
const tpl = JSON.parse(readFileSync(join(ROOT, 'templates', 'zheguang', 'template.json'), 'utf8').replace(/^\uFEFF/, ''))
const scene = buildScene({
  words: pipe.transcript.words, segments: pipe.transcript.segments, plan: pipe.plan,
  brief: { ...pipe.brief, ratio: '9:16', template: 'zheguang', shots: pipe.shots || pipe.brief.shots || null },
  tpl, cards: pipe.captions.cards, ratio: '9:16',
})
const bare = s => String(s || '').replace(/[\s，。！？、；：,.!?;:""''…—~·\-]/g, '')
const inside = (t, src) => { const pool = new Map(); for (const ch of bare(src)) pool.set(ch, (pool.get(ch) || 0) + 1); for (const ch of bare(t)) { const n = pool.get(ch) || 0; if (!n) return false; pool.set(ch, n - 1) } return true }
const overlap = (a, b) => a.f0 < b.f1 && b.f0 < a.f1

// 1) 页：连续、覆盖全片
ok('页数在 3–8 之间', scene.pages.length >= 3 && scene.pages.length <= 8, String(scene.pages.length))
// 页之间允许空隙：段与段之间本来就有静音，页是按段落切的，不是按秒铺满的
let badOrder = null
for (let i = 1; i < scene.pages.length; i++) if (scene.pages[i].start < scene.pages[i - 1].start - 0.001) badOrder = i
ok('页起点递增', !badOrder, badOrder ? '第 ' + badOrder + ' 页' : '')
ok('页与页不重叠', scene.pages.every((p, i) => i === 0 || p.start >= scene.pages[i - 1].end - 0.05))
ok('第一页从 0 开始', scene.pages[0].start === 0)
ok('最后一页到片尾', scene.pages.at(-1).end >= scene.duration - 1.0, (scene.pages.at(-1).end - scene.duration).toFixed(2) + 's')

// 2) 版式：覆盖全片、无重叠、种类合法
const kinds = ['full', 'frame', 'corner', 'card', 'outro']
let sorted = true
for (let i = 1; i < scene.shots.length; i++) if (scene.shots[i].f0 < scene.shots[i - 1].f1 - 0.001) sorted = false
ok('版式按时间有序且不重叠', sorted)
ok('版式从 0 铺到片尾', scene.shots[0].f0 === 0 && Math.abs(scene.shots.at(-1).f1 - scene.duration) < 0.1)
ok('版式种类都认识', scene.shots.every(s => kinds.includes(s.kind)), scene.shots.map(s => s.kind).join(','))
ok('全屏字卡不超过 2 次', scene.shots.filter(s => s.kind === 'card').length <= 2, String(scene.shots.filter(s => s.kind === 'card').length))
ok('竖框不超过 1 次', scene.shots.filter(s => s.kind === 'frame').length <= 1, String(scene.shots.filter(s => s.kind === 'frame').length))
ok('小窗不超过 4 次', scene.shots.filter(s => s.kind === 'corner').length <= 4, String(scene.shots.filter(s => s.kind === 'corner').length))
ok('结尾一定是画中画', scene.shots.at(-1).kind === 'outro')

// 3) 大字：接地、不越界、不相叠、不超过 8 字
let ungrounded = []
for (const b of scene.bigs) {
  const page = scene.pages.find(p => b.f0 >= p.start - 0.4 && b.f0 < p.end)
  const src = scene.sections.find(s => s.index === (page ? page.index : 1))
  if (!src || !inside(b.text, src.text)) ungrounded.push(b.index + '「' + b.text + '」')
}
ok('每条大字都取自本页原话', ungrounded.length === 0, ungrounded.join('、'))
ok('大字不超过 8 字', scene.bigs.every(b => bare(b.text).length <= 8), scene.bigs.filter(b => bare(b.text).length > 8).map(b => b.text).join('、'))
let bigOverlap = null
for (let i = 1; i < scene.bigs.length; i++) if (overlap(scene.bigs[i - 1], scene.bigs[i])) bigOverlap = scene.bigs[i].index
ok('大字之间不重叠（同一时刻只有一条）', !bigOverlap, String(bigOverlap))
// 大字区间 = 字幕卡区间，版式切点也可能落在卡中间：只要求「每条大字至少落在一个版式里」
ok('每条大字都有版式归', scene.bigs.every(b => scene.shots.some(s => overlap(b, s))))

// 折行只是「一屏放不下」的妥协，不是句读：相邻两行如果能并回一行（按 bigMin 还排得下整幅宽），
// 就该并回去。自测08 抽帧里「机会在 / OPC / 内容」三行堆叠，明明一行放得下——那看起来像字幕，不像大字。
const emOf = (s) => [...String(s)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)
const LZ = tpl.layouts['9:16']
const availW = LZ.size[0] - (LZ.big.left || 62) - (LZ.big.right || 150)
const bigMin = (tpl.type && tpl.type.bigMin) || 64
const mergeable = []
for (const b of scene.bigs) {
  for (let i = 1; i < b.lines.length; i++) {
    if (emOf(b.lines[i - 1] + b.lines[i]) * bigMin <= availW) mergeable.push(b.index + '「' + b.lines[i - 1] + '+' + b.lines[i] + '」')
  }
}
ok('大字能一行就一行（不许把放得下的行拆开堆叠）', mergeable.length === 0, mergeable.join('、'))
ok('品牌胶囊不为空（右上角要有项目名，不只是时间码）', !!String(scene.labels.brand || '').trim(), String(scene.labels.brand))
ok('出镜人名字不会被品牌名顶替', !scene.blocks.some(b => b.kind === 'avatar' && b.name === scene.labels.brand), scene.blocks.filter(b => b.kind === 'avatar').map(b => b.name).join('、'))

// 4) 图形块：只能出现在支持的版式里、文字接地
const kindsOk = { tagwall: ['frame', 'corner'], check: ['full', 'corner', 'frame'], banner: ['full'], gauge: ['full', 'corner', 'frame'], avatar: ['full', 'corner', 'frame', 'outro'] }
let badBlock = null
for (const b of scene.blocks) {
  const shot = scene.shots.find(s => b.f0 >= s.f0 && b.f0 < s.f1)
  if (!shot) { badBlock = b.kind + ' 不在任何版式里'; continue }
  if (kindsOk[b.kind] && !kindsOk[b.kind].includes(shot.kind)) badBlock = b.kind + ' 跑到了 ' + shot.kind
}
ok('图形块都在支持的版式里', !badBlock, badBlock || '')
const blockTexts = scene.blocks.flatMap(b => b.items || (b.text ? [b.text] : []))
const allText = scene.sections.map(s => s.text).join('')
ok('图形块文字都来自原话', blockTexts.every(t => inside(t, allText)), blockTexts.filter(t => !inside(t, allText)).join('、'))

// 4b) 句子级小标签：词要接地、只挂单字词、只走两侧、别和别的器件抢地方
const chips = scene.chips || []
const LCH = (tpl.layouts['9:16'] || {}).chips || { lanes: [0.255, 0.345, 0.435], left: 56, right: 150, h: 46, padX: 20 }
const chipSize = (tpl.type && tpl.type.chip) || 24
const chipW = text => Math.round(emOf(text) * chipSize + LCH.padX * 2)
// 和 film.js / layout-boxes 同一套几何：泳道 + 每张自己的偏移（偏移存在 scene.json 里）
const chipBox = c => {
  const cw = chipW(c.text)
  const x0 = c.side ? LZ.size[0] - LCH.right - cw : LCH.left
  const x = Math.max((LZ.margin || 56), Math.min(LZ.size[0] - (LZ.margin || 56) - cw, x0 + (c.dx || 0)))
  return { x, y: LZ.size[1] * LCH.lanes[c.lane] + (c.dy || 0) - LCH.h / 2, w: cw, h: LCH.h, f0: c.f0, f1: c.f1 }
}
const chipOut = []
for (const c of chips) {
  const page = scene.pages.find(p => p.index === c.page)
  const src = scene.sections.find(s2 => s2.index === c.page)
  if (!src || !inside(c.text, src.text)) chipOut.push('词不接地「' + c.text + '」')
  if (segment(c.text).length !== 1) chipOut.push('不是单个词「' + c.text + '」')
  // 标签是画面上的注脚，允许跨页、跨版式继续挂着（参考片就是攒着不走的）；
  // 只要求它的起点落在它标注的那一页里。
  if (!page || c.f0 < page.start - 0.01 || c.f0 > page.end + 0.01) chipOut.push('起点不在本页「' + c.text + '」')
  if (c.f1 - c.f0 < 1.2 || c.f1 - c.f0 > 4.9) chipOut.push('时长 ' + (c.f1 - c.f0).toFixed(2) + 's「' + c.text + '」')
  const shot = scene.shots.find(s2 => c.f0 >= s2.f0 && c.f0 < s2.f1)
  if (!shot || !['full', 'frame', 'corner'].includes(shot.kind)) chipOut.push('排进了 ' + (shot ? shot.kind : '片外'))
}
ok('小标签的规矩（接地 / 单个词 / 起点在本页 / 时长 / 版式）', chipOut.length === 0, chipOut.slice(0, 4).join('、'))
// 两个字的标签最容易是分词碎片（ICU 把「生产力」拆成「生产」、把「来去做」拆成「来去」）：
// 两字词必须在全片被说过两遍以上才许挂，三四个字的词本身有信息量，说一遍也行。
const gFreq = new Map()
for (const s2 of scene.sections) for (const tok of segment(bare(s2.text || ''))) gFreq.set(tok, (gFreq.get(tok) || 0) + 1)
const thin = chips.filter(c => bare(c.text).length === 2 && (gFreq.get(bare(c.text)) || 0) < 2)
ok('两个字的标签都是全片说过两遍以上的词（不是分词碎片）', thin.length === 0, thin.map(c => c.text + '×' + (gFreq.get(bare(c.text)) || 0)).slice(0, 5).join('、'))
// 密度下限：参考片每一屏都挂着几张，我们至少要做到「每页有标签挂着」这个量级，
// 不然画面会退化成「人 + 一句大字」（自测22 全片只有 4 张，28 秒之后一张都没有）。
ok('标签密度（不少于页数的四分之三）', chips.length >= Math.ceil(scene.pages.length * 0.75), chips.length + ' 张 / ' + scene.pages.length + ' 页')
// 构图节奏：参考族的切点密度是 0.20–0.23/s。老规则「满幅连续 11 秒才换」在 8.8 秒一页的
// 真实素材上永远触发不了，全片只有 8 个切点（0.13/s）。这条守住下限，别再退回去。
const cutRate = (scene.shots.length - 1) / scene.duration
ok('构图切点密度不低于 0.18/s（参考族 0.20–0.23）', cutRate >= 0.18 && cutRate <= 0.4, cutRate.toFixed(3) + '/s，' + scene.shots.length + ' 段 / ' + scene.duration.toFixed(1) + 's')
// 同时在场最多 4 张（多了就是贴纸墙，不是标签）
let peak = 0
for (let t = 0; t <= scene.duration; t += 0.25) {
  const n = chips.filter(c => t >= c.f0 && t < c.f1).length
  if (n > peak) peak = n
}
ok('同一时刻的小标签不超过 4 张', peak <= 4, '最多 ' + peak + ' 张')
// 标签不压人物：小窗/竖框页贴窗口边排，满幅页在画面两侧（中间 26%–74% 留空）
const prOf = kind => {
  if (kind === 'frame') { const dw = Math.round(LZ.size[0] * ((LZ.frame && LZ.frame.w) || 0.52)); return { x: Math.round((LZ.size[0] - dw) / 2), y: Math.round(LZ.size[1] * ((LZ.frame && LZ.frame.y) || 0.2)), w: dw, h: Math.round(dw * LZ.size[1] / LZ.size[0]) } }
  if (kind === 'corner') { const dw = Math.round(LZ.size[0] * ((LZ.corner && LZ.corner.w) || 0.52)); return { x: LZ.size[0] - dw - (LZ.margin || 56), y: Math.round(LZ.size[1] * ((LZ.corner && LZ.corner.top) || 0.2)), w: dw, h: Math.round(dw * LZ.size[1] / LZ.size[0]) } }
  return null
}
const mid = []
for (const c of chips) {
  const b = chipBox(c)
  const shot = scene.shots.find(s2 => c.f0 >= s2.f0 && c.f0 < s2.f1)
  const pr = prOf(shot && shot.kind)
  const hit = pr
    ? !(b.x + b.w <= pr.x - 4 || pr.x + pr.w + 4 <= b.x || b.y + b.h <= pr.y - 4 || pr.y + pr.h + 4 <= b.y)
    : (b.x < LZ.size[0] * 0.74 && b.x + b.w > LZ.size[0] * 0.26)
  if (hit) mid.push('「' + c.text + '」')
}
ok('小标签不压人物（窗口页贴边、满幅页只走两侧）', mid.length === 0, mid.join('、'))
// 标签不压大字：离大字墨水顶还有余量
const bigTops = scene.bigs.map(b => {
  const lines = Math.max(1, (b.lines || []).length)
  const size = Math.max((tpl.type && tpl.type.bigMin) || 62, Math.min((tpl.type && tpl.type.big) || 96, Math.floor(((LZ.size[0] - LZ.big.left - LZ.big.right) * 0.98) / Math.max(1, ...b.lines.map(emOf)))))
  return (b.shotBottom || LZ.size[1] * 0.775) - lines * size * (LZ.big.lineGap || 1.06)
})
const chipBottom = Math.max(...chips.map(c => chipBox(c).y + chipBox(c).h), 0)
ok('小标签不压大字（最低一张在大字墨水顶之上）', chips.length === 0 || chipBottom < Math.min(...bigTops) - 40, Math.round(chipBottom) + ' vs ' + Math.round(Math.min(...bigTops)))
// 标签墙 / 红条在场时不叠标签：那块地方自己就是密度
const clash = chips.filter(c => scene.blocks.some(b => (b.kind === 'tagwall' || b.kind === 'banner') && c.f0 < b.f1 && b.f0 < c.f1))
ok('标签和标签墙/红条不同时在场', clash.length === 0, clash.map(c => c.text).join('、'))
// 内容到位就要挂：一页里真说了两个以上术语/专名，至少得挂上一张
const miss = []
for (const p of scene.pages) {
  const src = scene.sections.find(s2 => s2.index === p.index)
  if (!src) continue
  const terms = [...new Set(segment(src.text).filter(w => /^[A-Za-z][A-Za-z0-9+#.]*$/.test(w) && w.length >= 2))]
  const has = chips.some(c => c.page === p.index)
  if (terms.length >= 2 && !has && p.end - p.start >= 5) miss.push('P' + p.index + '（' + terms.join('/') + '）')
}
ok('说了两个以上专名的页都挂上了标签', miss.length === 0, miss.join('、'))

// 5) 章节名：不空就别是半句话
const BAD_END = /[的了是在和就都也才把给对从但而很太更不没有着过吧呢吗啊嘛去来出要会能说看用做你我他她它们这那越]$/
ok('章节名不以虚词收尾', scene.pages.every(p => !p.title || !BAD_END.test(p.title)), scene.pages.filter(p => p.title && BAD_END.test(p.title)).map(p => p.title).join('、'))
ok('章节名不超过 10 字', scene.pages.every(p => bare(p.title).length <= 10))

// 6) HUD：页码、品牌、进度线三件都在
ok('HUD 品牌/平台字段在', scene.labels && scene.labels.template === '折光')
ok('时间线统计齐', scene.stats && scene.stats.out > 0 && scene.frames > 0)

// 7) 对勾卡给大字让位：让到**底板**上沿，而且整段只算一次
//
// 这一节来自自测21 的一条真失败：第 1104 帧质检报「big × block:check 重叠 11px」。
// 查下去是三件事叠在一起——
//   · 自测18 给大字加了底板（0.14×字号内边距），可对勾卡还按「墨迹顶 − 22」让位，
//     到板只剩 5px，卡贴着板边；
//   · 卡跨两句大字（size 106 → 121）时按当前帧算，卡会在中途往上跳 16px；
//   · 质检那份盒子按「区间起点那一帧」算，拿短的那句去比，报出画面里并不存在的重叠（假失败）。
// 现在两条实现都改成「区间内最高那块板 − 22」，这一节把这条钉住。
{
  const L7 = tpl.layouts['9:16']
  const W7 = 1080, H7 = 1920
  const em7 = s => [...String(s)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)
  const sizeOf = lines => {
    const n = lines.length
    const cap = n >= 3 ? Math.min(tpl.type.big, 104) : tpl.type.big
    const longest = Math.max(1, ...lines.map(em7))
    return Math.max(tpl.type.bigMin, Math.min(cap, Math.floor(((W7 - L7.big.left - L7.big.right) * 0.98) / longest)))
  }
  const plateTopOf = lines => {
    const size = sizeOf(lines)
    const lh = size * (L7.big.lineGap || 1.06)
    return Math.round(H7 * 0.775 - lines.length * lh - Math.round(size * 0.14))
  }
  const A = ['知道的人会做的人'], B = ['我现在要花一千']
  const synth = {
    template: 'zheguang', ratio: '9:16', size: [W7, H7], fps: 30, frames: 480, duration: 16,
    shots: [{ f0: 0, f1: 16, kind: 'full' }], subs: [], chips: [], sections: [], pages: [],
    bigs: [
      { f0: 8, f1: 11, lines: A, text: A[0], hot: '' },
      { f0: 11, f1: 15, lines: B, text: B[0], hot: '' },
    ],
    // 卡从 10s 活到 13.5s：跨了两句大字，后半段那句更大
    blocks: [{ kind: 'check', text: '做出一周的工作量', f0: 10, f1: 13.5 }],
  }
  const b7 = layoutBoxes({ scene: synth, template: tpl })
  const card = (b7.items || []).find(x => x.tag === 'block:check')
  const bigs7 = (b7.items || []).filter(x => x.tag === 'big')
  const expect = Math.min(plateTopOf(A), plateTopOf(B)) - 22
  ok('对勾卡让到底板上沿 22px（不是墨迹顶）', Boolean(card) && card.y + card.h === expect, card ? '卡底 ' + (card.y + card.h) + '，应为 ' + expect : '没有卡')
  const hitBig = bigs7.filter(b => !(card.x + card.w <= b.x || b.x + b.w <= card.x || card.y + card.h <= b.y || b.y + b.h <= card.y))
  ok('对勾卡和它整段里的两句大字都不压', Boolean(card) && hitBig.length === 0, hitBig.length + ' 处')
  ok('对勾卡没有被打到 0.30h 上限以外', Boolean(card) && card.y >= Math.round(H7 * 0.30) - 1, card ? String(card.y) : '-')
  // 大字盒子的上沿必须比墨迹顶再高一档内边距：这一条错了，「让 22px」就变成「贴 5px」
  const inkTopB = Math.round(H7 * 0.775 - B.length * sizeOf(B) * (L7.big.lineGap || 1.06))
  const boxB = bigs7.find(b => Math.abs(b.t0 - 11) < 0.01)
  ok('大字盒子上沿 = 墨迹顶 − 内边距', Boolean(boxB) && boxB.y === plateTopOf(B) && boxB.y < inkTopB - 8, boxB ? boxB.y + ' vs 墨迹 ' + inkTopB : '-')
  // 反向验证：把卡挪到贴墨迹顶，同一条相交判断必须报出来——尺子得有分辨力
  const bad = { ...card, y: inkTopB - card.h + 4 }
  const badHit = bigs7.some(b => !(bad.x + bad.w <= b.x || b.x + b.w <= bad.x || bad.y + bad.h <= b.y || b.y + b.h <= bad.y))
  ok('贴墨迹顶的卡会被判成压字（尺子有分辨力）', badHit === true)
}

// 8) 刻度卡与大字：谁也别压谁；给章节卡让位的大字，盒子从让位结束起算
//
// 自测22 质检报「10 帧 big × block:gauge，第 492 帧」，量下去一半真一半假：
//   · 真的：第 545 帧「越来越低 ↓」被大字板沿切掉——短句子按内容顶到 168px，板顶升到 1286px，
//     正好插进刻度卡底部 1314px；
//   · 假的：492–519 帧大字被章节卡压着根本没画，盒子却照样算它，还报了重叠。
// 两条口径，渲染器和盒子都认：① 有刻度卡在场就把字号缩到板顶落在卡底 22px 以下；
// ② 大字的可见起点 = 数据里的 holdUntil（自测29 起不再按「页首 + 1.5s」重算）。
{
  const H8 = 1920
  const base8 = {
    template: 'zheguang', ratio: '9:16', size: [1080, H8], fps: 30, frames: 600, duration: 20,
    shots: [{ f0: 0, f1: 20, kind: 'full' }], subs: [], chips: [], sections: [],
    pages: [{ index: 1, total: 1, start: 0, end: 20, title: '技术门槛越来越低' }],
  }
  const bigOf = s => (layoutBoxes({ scene: s, template: tpl }).items || []).find(x => x.tag === 'big')
  const bigW = bigOf({ ...base8, bigs: [{ f0: 5, f1: 9, lines: ['生产力工具'], text: '生产力工具', hot: '' }], blocks: [{ kind: 'gauge', label: '门槛', f0: 6, f1: 10 }] })
  const bigN = bigOf({ ...base8, bigs: [{ f0: 5, f1: 9, lines: ['生产力工具'], text: '生产力工具', hot: '' }], blocks: [] })
  const gaugeBottom = Math.round(H8 * 0.575 + 210)
  ok('刻度卡在场时，大字的板顶落在卡底 22px 以下', Boolean(bigW) && bigW.y >= gaugeBottom + 22, bigW ? '板顶 ' + bigW.y + '，卡底 ' + gaugeBottom : '没有大字')
  ok('没有刻度卡时字号回到内容上限（不被白缩一档）', Boolean(bigN) && Boolean(bigW) && bigN.y < bigW.y, bigN && bigW ? bigN.y + ' vs ' + bigW.y : '-')
  ok('缩的是字号，不是把板切一刀', Boolean(bigW) && Boolean(bigN) && bigW.h < bigN.h, bigW && bigN ? bigW.h + ' vs ' + bigN.h : '-')
  // 让位规则落在数据里（b.holdUntil）：页首 1.5 秒内、且和章节名说的是同一句 → 让位。
  const bigHold = bigOf({ ...base8, bigs: [{ f0: 0.2, f1: 4, lines: ['技术门槛'], text: '技术门槛', hot: '', holdUntil: 1.5 }], blocks: [] })
  ok('让位的大字，盒子从让位结束起算', Boolean(bigHold) && bigHold.t0 >= 1.5 - 1e-6, bigHold ? String(bigHold.t0) : '-')
  // 反向验证：页首 1.5 秒内**不和章节名重复**的大字必须从 f0 就进盒子。
  // 老实现（页首 + 1.5 一刀切）在这里会给出 1.5，正是自测28 白丢的那 1.5 秒。
  const bigNoHold = bigOf({ ...base8, bigs: [{ f0: 0.2, f1: 4, lines: ['泼一瓶冷水'], text: '泼一瓶冷水', hot: '' }], blocks: [] })
  ok('不和章节名重复的页首大字从 f0 就出场（不再按时间一刀切）', Boolean(bigNoHold) && Math.abs(bigNoHold.t0 - 0.2) < 0.02, bigNoHold ? String(bigNoHold.t0) : '-')
}

// 8b) 章节卡与大字：按内容判，不按时间切（自测29）
//
// 自测28 的成片里这条规矩闯了两类祸：页首新出的大字白丢 1.5 秒（5.54 / 17.93 / 34.98
// / 50.65 四处，画面上只剩一行小字幕），跨页的大字中途消失 1.5 秒再闪回来（28.59s /
// 41.41s 那两条）。所以规则从「时间」改成「内容」：只有说的是同一句才让位。
{
  const pg = { index: 2, start: 5.54, end: 17.63, title: '真正的机会是在OPC' }
  const pg7 = { index: 7, start: 50.65, end: 59.93, title: '卷内容生产力才是王道' }
  ok('页首、和章节名同一句：让位到 1.5 秒', chapterHoldUntil('机会是在OPC', 5.6, pg) === 7.04, String(chapterHoldUntil('机会是在OPC', 5.6, pg)))
  ok('页首、被章节名包含：也算同一句', chapterHoldUntil('卷内容生产力', 50.65, pg7) === 52.15, String(chapterHoldUntil('卷内容生产力', 50.65, pg7)))
  ok('页首、和章节名不搭：不让位（老实现会白丢 1.5 秒）', chapterHoldUntil('今天大家都在卷', 5.54, pg) === 0, String(chapterHoldUntil('今天大家都在卷', 5.54, pg)))
  ok('跨页的大字不让位（不让它在中途消失再闪回来）', chapterHoldUntil('AI来去做内容', 28.59, { index: 4, start: 29.41, end: 34.98, title: '知道的人会做的人太少' }) === 0)
  ok('页首 1.5 秒之外的大字不按这条判', chapterHoldUntil('机会是在OPC', 8.0, pg) === 0, String(chapterHoldUntil('机会是在OPC', 8.0, pg)))
  ok('没有页名就不让位（不许凭空白压 1.5 秒）', chapterHoldUntil('机会是在OPC', 5.6, { start: 5.54, end: 17.63, title: '' }) === 0)
  // 真 scene 上再验一遍：跨页的大字一条都不许带 holdUntil；带了的必须落在本页头 1.5 秒内
  const straddle = scene.bigs.filter(b => {
    const pg2 = scene.pages.find(p2 => p2.start > b.f0 + 0.05 && p2.start < b.f1)
    return pg2 && b.holdUntil
  })
  ok('真 scene：跨页的大字一条都不带让位', straddle.length === 0, straddle.map(b => b.text).join('、'))
  const badHold = scene.bigs.filter(b => b.holdUntil && (b.holdUntil < b.f0 || b.holdUntil > b.f0 + 1.5 + 0.02))
  ok('真 scene：让位只会落在开头 1.5 秒内（不会把整条大字吃掉）', badHold.length === 0, badHold.map(b => b.text + '@' + b.holdUntil).join('、'))
  const held = scene.bigs.filter(b => b.holdUntil).length
  ok('真 scene：确实有被让位的大字（这条规矩没被绕过）', held >= 1, held + ' 条 / ' + scene.bigs.length + ' 条')
  // 页间空档不许把页码打回第一页。自测28 的 17.63–17.93s 那 0.3 秒里 HUD 跳回了「P. 01 / 07」。
  const synthPages = [{ index: 1, start: 0, end: 5 }, { index: 2, start: 5.3, end: 10 }, { index: 3, start: 10.4, end: 15 }]
  const gapAt = t => (pageAtFor(synthPages, t) || {}).index
  ok('页间空档取最近的前一页（页码不倒回 P. 01）', gapAt(5.1) === 1 && gapAt(10.2) === 2, gapAt(5.1) + ',' + gapAt(10.2))
  ok('页内仍取当前页', gapAt(5.35) === 2, String(gapAt(5.35)))
  ok('空档在片头之前也只取第一页', gapAt(-1) === 1, String(gapAt(-1)))
  // 真 scene 里如果正好有空档，也得落在前一页上
  const realGap = (() => { for (let i = 1; i < scene.pages.length; i++) { const a = scene.pages[i - 1].end, b = scene.pages[i].start; if (b - a > 0.05) return { t: (a + b) / 2, expect: scene.pages[i - 1].index } } return null })()
  ok('真 scene：页间空档也落在前一页', !realGap || (pageAtFor(scene.pages, realGap.t) || {}).index === realGap.expect, realGap ? '空档 ' + realGap.t.toFixed(2) + 's' : '本片页是连着的')
}

// 9) 字卡页的大字：居中排版，盒子必须跟着居中（自测28）
//
// 以前 layout-boxes 不分版式：字卡页的大字盒子按满幅页那条（压在 0.775h）算，
// 量的就不是画面上的那块字——先量出 1.03:1 的假失败，后来干脆一个盒子都量不到。
// 现在两个分支分开算，这条盯住「盒子和画面是同一套几何」。
{
  const W9 = 1080, H9 = 1920
  const sc9 = {
    template: 'zheguang', ratio: '9:16', size: [W9, H9], fps: 30, frames: 180, duration: 6,
    shots: [{ f0: 0, f1: 2, kind: 'full' }, { f0: 2, f1: 5, kind: 'card' }, { f0: 5, f1: 6, kind: 'full' }],
    subs: [], chips: [], sections: [], pages: [{ index: 1, total: 1, start: 0, end: 6, title: '最赚钱的不是技术' }],
    bigs: [
      { f0: 0.2, f1: 1.9, lines: ['今天大家都在卷'], text: '今天大家都在卷', hot: '' },
      { f0: 2.2, f1: 4.8, lines: ['知道的人会做的人太少'], text: '知道的人会做的人太少', hot: '' },
    ],
    blocks: [],
  }
  const bx = (layoutBoxes({ scene: sc9, template: tpl }).items || []).filter(x => x.tag === 'big')
  const cardBig = bx.find(x => x.shot === 'card'), fullBig = bx.find(x => x.shot === 'full')
  const mid = cardBig ? (cardBig.y + cardBig.h / 2) / H9 : 0
  // 墨迹中心定在 0.62h：压胸口，不压嘴（自测28 第一次重出把字卡画在正中，正好切在嘴上）
  ok('字卡页的大字盒子压胸口（0.62h 附近，不是满幅页那条 0.775h、也不是正中的 0.50h）', Boolean(cardBig) && mid > 0.56 && mid < 0.68, cardBig ? mid.toFixed(2) : '没有')
  ok('字卡页的大字盒子是满宽减页边距', Boolean(cardBig) && cardBig.w === W9 - ((tpl.layouts['9:16'].margin) || 56) * 2, cardBig ? String(cardBig.w) : '-')
  ok('同一场景里，字卡页和满幅页的大字盒子不相同', Boolean(cardBig) && Boolean(fullBig) && cardBig.y !== fullBig.y)
  // 反向验证：把字卡页的字号按满幅页那条算，这条就必须报出来——尺子得有分辨力
  const wrongY = Math.round(H9 * 0.775 - (Math.min(96, Math.floor((W9 - 124) / 10)) * 1.06))
  ok('按满幅页算出来的盒子会被这条判成不合格', Math.abs((cardBig ? cardBig.y : 0) - wrongY) > 60, cardBig ? cardBig.y + ' vs 满幅 ' + wrongY : '-')
}

console.log('折光自检：' + pass + ' 通过，' + fails.length + ' 失败')
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f) }

if (DO_RENDER) {
  const work = join(ROOT, '.test', 'zcheck')
  const { mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'scene.json'), JSON.stringify(scene), 'utf8')
  writeFileSync(join(work, 'template.json'), JSON.stringify(tpl), 'utf8')
  const media = join(ROOT, 'groups', GROUP, 'cache', 'zheguang', 'media')
  const out = join(ROOT, '.test', 'zcheck.jsonl')
  const r = await qaBoxes({ work, mediaDir: media, size: scene.size, frames: scene.frames, fps: scene.fps, out, log: m => console.log('  ' + m) })
  const boxes = r.boxes
  let bad = 0
  for (const b of boxes) {
    if (b.tag === 'big') {
      const sub = boxes.find(x => x.tag === 'sub' && Math.abs(x.t0 - b.t0) < 0.01)
      if (sub) { const hit = !(b.x + b.w <= sub.x || sub.x + sub.w <= b.x || b.y + b.h <= sub.y || sub.y + sub.h <= b.y); if (hit) bad++ }
    }
  }
  console.log('版式采样：' + r.samples + ' 个时间点，' + boxes.length + ' 个盒子；大字压字幕 ' + bad + ' 处')
}
if (fails.length) process.exit(1)
