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
import { buildScene } from '../templates/zheguang/scene.mjs'
import { segment } from '../src/segment.mjs'
import { qaBoxes } from '../templates/zheguang/render.mjs'

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
const chipBox = c => ({ x: c.side ? LZ.size[0] - LCH.right - chipW(c.text) : LCH.left, y: LZ.size[1] * LCH.lanes[c.lane] - LCH.h / 2, w: chipW(c.text), h: LCH.h, f0: c.f0, f1: c.f1 })
const chipOut = []
for (const c of chips) {
  const page = scene.pages.find(p => p.index === c.page)
  const src = scene.sections.find(s2 => s2.index === c.page)
  if (!src || !inside(c.text, src.text)) chipOut.push('词不接地「' + c.text + '」')
  if (segment(c.text).length !== 1) chipOut.push('不是单个词「' + c.text + '」')
  if (!page || c.f0 < page.start - 0.01 || c.f1 > page.end + 0.01) chipOut.push('跨页「' + c.text + '」')
  if (c.f1 - c.f0 < 1.2 || c.f1 - c.f0 > 4.9) chipOut.push('时长 ' + (c.f1 - c.f0).toFixed(2) + 's「' + c.text + '」')
  const shot = scene.shots.find(s2 => c.f0 >= s2.f0 && c.f0 < s2.f1)
  if (!shot || !['full', 'frame', 'corner'].includes(shot.kind)) chipOut.push('排进了 ' + (shot ? shot.kind : '片外'))
}
ok('小标签的规矩（接地 / 单个词 / 不跨页 / 时长 / 版式）', chipOut.length === 0, chipOut.slice(0, 4).join('、'))
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
