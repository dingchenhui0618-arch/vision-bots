/**
 * 大字与口播对齐的离线断言（scripts/check-align.mjs）。
 *
 * 抓的是 2026-11-24 那个 bug：口播已经说到下一句，屏上的大字还停在上一句。
 * 判据只有一条，但必须钉死：**任意时刻，屏上那条大字的来源卡 == 此刻字幕在显示的那张卡**。
 * 大字区间 = 字幕卡区间，两边边界天然重合；这里把「重合」变成可回归的断言，
 * 而不是靠看片子时的印象。
 *
 * 用确定性夹具（不联网、不跑模型）：词级时间戳 → 字幕卡 → scene.bigs。
 * 最后还有反向验证：把老版「一段一句大字」的 scene 喂给同一套断言，必须判失败——
 * 否则这些断言只是摆设。
 */
import { readFileSync } from 'node:fs'
import { buildCaptions } from '../src/captions.mjs'
import { buildScene } from '../templates/lighttrail/scene.mjs'
import { HEADLINE, insideSentence, checkHeadline, pickHeadline } from '../src/headlines.mjs'

let pass = 0, fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log('  PASS ' + label) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')) }
}

const TPL = JSON.parse(readFileSync(new URL('../templates/lighttrail/template.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))

// ── 夹具：6 秒素材，词级时间戳带两处停顿（停顿会把字幕切成不同的卡）──
const words = []
const push = (text, start, dur) => {
  const chars = [...text]
  const per = dur / chars.length
  chars.forEach((ch, i) => words.push({ w: ch, start: +(start + per * i).toFixed(3), end: +(start + per * (i + 1)).toFixed(3), p: 0.95 }))
}
push('今天', 0.10, 0.50)
push('大家', 0.60, 0.45)
push('都在', 1.05, 0.45)
push('卷', 1.50, 0.25)
push('AI', 1.75, 0.45)
push('技术', 2.20, 0.55)
// 停顿 0.5s → 换句
push('但是', 3.20, 0.40)
push('真正', 3.60, 0.45)
push('赚钱的', 4.05, 0.60)
push('没几个', 4.65, 0.65)
// 停顿 0.5s → 再换句
push('所以', 5.80, 0.35)
push('要抓', 6.15, 0.40)
push('内容', 6.55, 0.45)
push('红利', 7.00, 0.40)
const segments = [
  { start: 0.10, end: 2.75, text: '今天大家都在卷AI技术' },
  { start: 3.20, end: 5.30, text: '但是真正赚钱的没几个' },
  { start: 5.80, end: 7.40, text: '所以要抓内容红利' },
]
const plan = {
  keep: [[0, 7.6]], cuts: [], deletions: [],
  options: { speed: 1 },
  sourceDuration: 7.6, keptSeconds: 7.6, cutSeconds: 0, outDuration: 7.6,
  removedPauses: 0, seamCuts: 0, speedSaved: 0,
  byReason: {}, deletedChars: 0, deletedSec: 0,
}
const captions = buildCaptions(words, plan, { maxChars: 14 })
const cards = captions.cards

console.log('夹具：' + cards.length + ' 张字幕卡 — ' + cards.map(c => c.text).join(' / '))
ok(cards.length >= 3, '夹具至少切出 3 张卡', String(cards.length))

// 模型标题：全部合格；其中第 2 张故意塞一个本卡没有的字（必须被当场打回、退回摘句）
const titles = cards.map((c, i) => ({ index: i + 1, text: pickHeadline(c.text), source: 'model', ok: true }))
titles[1] = { index: 2, text: '赚钱就是未来', source: 'model', ok: true } // 「未、来」不在第 2 卡里

const scene = buildScene({
  words, segments, plan, tpl: TPL,
  brief: { ratio: '9:16', sentenceTitles: titles },
  cards, ratio: '9:16',
})

// 大字和卡片一一对应：同序、同起点
const shortCards = cards.filter((c, i) => ((cards[i + 1] ? cards[i + 1].start : c.end) - c.start) >= HEADLINE.minSec)
console.log('\n[1] 大字条数与区间')
ok(scene.bigs.length === shortCards.length, '大字条数 == 够长的字幕卡数（' + shortCards.length + '）', String(scene.bigs.length))
const startsMatch = scene.bigs.every((b, i) => Math.abs(b.f0 - shortCards[i].start) < 1e-6)
ok(startsMatch, '每条大字的起点就是那张卡的起点')
const endMatch = scene.bigs.every((b, i) => Math.abs(b.f1 - Math.min(shortCards[i + 1] ? shortCards[i + 1].start : b.f1, Math.max(shortCards[i].end, shortCards[i].start + 0.35))) < 1e-3)
ok(endMatch, '每条大字的终点就是那张卡的终点（字幕一撤、大字也撤）')

console.log('\n[2] 标题只能来自本卡')
const grounded = scene.bigs.every((b, i) => insideSentence(b.text, shortCards[i].text))
ok(grounded, '大字每个字都来自它挂的那张卡')
ok(scene.bigs.every(b => [...b.text].length <= HEADLINE.maxChars), '大字都不超过 ' + HEADLINE.maxChars + ' 字')
const second = scene.bigs[1]
ok(second && !second.text.includes('未') && !second.text.includes('来'), '模型编的字被当场打回，退回本卡摘句', second && second.text)

console.log('\n[3] 对齐不变量：任意时刻，大字来源卡 == 字幕在显示的卡')
let wrong = 0, samples = 0, worst = null
for (let t = 0; t < scene.duration; t += 0.02) {
  const card = cards.findIndex(c => t >= c.start && t < c.end)
  const big = scene.bigs.findIndex(b => t >= b.f0 && t < b.f1)
  if (card < 0 && big < 0) continue
  samples++
  const bigCard = big >= 0 ? shortCards[big] : null
  const shown = card >= 0 ? cards[card] : null
  // 有字幕卡的时刻，大字必须是这张卡的大字；两边都空着的时刻也必须一致（静音里不许挂着上一句）
  const same = bigCard && shown && Math.abs(bigCard.start - shown.start) < 1e-6
  const idle = !bigCard && !shown
  if (!same && !idle) { wrong++; if (!worst) worst = { t: +t.toFixed(2), big: bigCard && bigCard.text, shown: shown && shown.text } }
}
ok(wrong === 0, '全片 ' + samples + ' 个采样点没有一次错位', worst ? JSON.stringify(worst) : '')

console.log('\n[4] 反向验证：老版「一段一句大字」必须判失败')
const oldScene = {
  ...scene,
  bigs: [{ index: 1, text: scene.bigs[0].text, f0: cards[0].start, f1: cards[2] ? cards[2].start : cards[0].end, words: [], lines: [scene.bigs[0].text] }],
}
let oldWrong = 0
for (let t = 0; t < oldScene.duration; t += 0.02) {
  const card = cards.findIndex(c => t >= c.start && t < c.end)
  if (card < 0) continue
  const big = oldScene.bigs[0]
  if (t >= big.f0 && t < big.f1 && Math.abs(cards[card].start - big.f0) > 1e-6) oldWrong++
}
ok(oldWrong > 0, '跨卡的大字会被抓出来（' + oldWrong + ' 个采样点错位）')

console.log('\n[5] 摘句兜底')
const real = ['大家在看这些满大街都是在做AI模型', '但是现在真正赚钱的有几个呢', '所以我认为OPC一定要抓住这个内容红利的窗口', '研究了一圈']
for (const s of real) {
  const h = pickHeadline(s)
  ok(insideSentence(h, s) && [...h].length <= HEADLINE.maxChars && [...h].length >= HEADLINE.minChars, '「' + s + '」→「' + h + '」')
}
ok(checkHeadline('赚钱就是未来', '但是真正赚钱的没几个').ok === false, '本卡没有的字会被 checkHeadline 拦住')
ok(checkHeadline('赚钱的', '但是真正赚钱的没几个').ok === false, '虚词结尾会被拦（半句话）')
ok(checkHeadline('但是赚钱', '但是真正赚钱的没几个').ok === false, '连接词开头会被拦')

console.log('\n' + (fail === 0 ? 'PASS' : 'FAIL') + '：' + pass + ' 条通过，' + fail + ' 条不通过')
process.exit(fail === 0 ? 0 : 1)
