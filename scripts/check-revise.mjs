/**
 * 改一句的自检：解析、定位、改字、时间码断言。
 * 用一小段合成词流（和真实 ASR 一样：中文常常一字一词、标点挂在词尾）跑，
 * 不依赖 groups/ 里的素材，任何机器上都能跑。
 */
import { parseEdit, locate, applyEdit, assertUntouched } from '../src/revise.mjs'

let pass = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  fails.push(name + (detail ? '：' + detail : ''))
}

// ── 合成词流：一字一词 + 标点挂在词尾，跟 faster-whisper 的真实输出一个样子 ──
const TEXTS = ['很多', '人', '做', '口', '播', '视频,', '最大', '的', '问题', '不是', '不会', '说话。',
  '不删', '吧,', '观众', '三', '秒', '就', '划', '走了。', '所以', '我们', '又', '划', '走了。']
const words = TEXTS.map((w, i) => ({ w, start: +(i * 0.4).toFixed(2), end: +((i + 1) * 0.4).toFixed(2) }))
const segments = [
  { start: 0, end: 4.8, text: '很多人做口播视频,最大的问题不是不会说话。' },
  { start: 4.8, end: 8.0, text: '不删吧,观众三秒就划走了。' },
  { start: 8.0, end: 10.0, text: '所以我们又划走了。' },
]

// ── 1. 解析 ──
const p1 = parseEdit('把划走改成溜走')
ok('解析 · 把X改成Y', p1 && p1.kind === 'edit' && p1.from === '划走' && p1.to === '溜走' && p1.chapter === null, JSON.stringify(p1))
const p2 = parseEdit('把第2章的划走改成溜走')
ok('解析 · 带章号', p2 && p2.chapter === 2 && p2.from === '划走', JSON.stringify(p2))
const p3 = parseEdit('「划走」→「溜走」')
ok('解析 · 引号+箭头', p3 && p3.from === '划走' && p3.to === '溜走', JSON.stringify(p3))
const p4 = parseEdit('把「划走」换成「溜走」')
ok('解析 · 换成+引号', p4 && p4.from === '划走' && p4.to === '溜走', JSON.stringify(p4))
ok('解析 · 重跑', parseEdit('重跑').kind === 'rerun')
ok('解析 · 不是改句', parseEdit('你看着办') === null)
ok('解析 · 空', parseEdit('') === null)

// ── 2. 定位：跨词匹配（「划」+「走了。」）──
const L1 = locate(words, '划走', {})
ok('定位 · 跨词命中', L1.matches.length === 2 && L1.matches[0].i === 18 && L1.matches[0].j === 19, JSON.stringify(L1.matches[0]))
ok('定位 · 有 2 处时先不猜', L1.ok === false && L1.ambiguous === true, JSON.stringify(L1.ok))

// ── 3. 两处重复：不给章号就拒绝，给了章号就只改那个 ──
const scene = { bigs: [{ index: 1, f0: 0, f1: 4 }, { index: 2, f0: 4, f1: 8 }, { index: 3, f0: 8, f1: 10 }] }
const plan = { keep: [[0, 10]], options: { speed: 1 } }
const L2 = locate(words, '划走', { plan, scene })
ok('定位 · 两处重复要问哪一章', L2.ok === false && L2.ambiguous && /2 处/.test(L2.reason), L2.reason)
const L3 = locate(words, '划走', { plan, scene, chapter: 3 })
ok('定位 · 章号圈定', L3.ok && L3.match.i === 23, JSON.stringify(L3.match))

// ── 4. 找不到：如实说，并给相近的词 ──
const L4 = locate(words, '划远', { plan, scene })
ok('定位 · 找不到', L4.ok === false && /没有/.test(L4.reason), L4.reason)
ok('定位 · 给了相近词', /「划」/.test(L4.hint || ''), L4.hint)

// ── 5. 等长替换：只动 1 个词，词数和时间码不变 ──
const L5 = locate(words, '划走', { plan, scene, chapter: 2 })
const E1 = applyEdit({ words, segments, match: L5.match, to: '溜走' })
ok('改字 · 等长只动 1 个词', E1.changed.length === 1 && E1.changed[0].i === 18 && E1.changed[0].to === '溜', JSON.stringify(E1.changed))
ok('改字 · 句子跟着改', E1.segments[1].text === '不删吧,观众三秒就溜走了。', E1.segments[1].text)
ok('改字 · 另一处没被碰', E1.words[23].w === '划' && E1.words[24].w === '走了。')
ok('改字 · 词数时间码不变', assertUntouched(words, E1.words, { changed: E1.changed }))

// ── 6. 不等长替换：不丢字、词数不变、多出来的字落在起始词上 ──
const E2 = applyEdit({ words, segments, match: L5.match, to: '溜达一下' })
ok('改字 · 不等长词数不变', E2.words.length === words.length && assertUntouched(words, E2.words, { changed: E2.changed }))
ok('改字 · 不等长不丢尾巴', E2.words[19].w === '了。' && E2.words[18].w === '溜达一下', E2.words[18].w + '|' + E2.words[19].w)
ok('改字 · 不等长句子对', E2.segments[1].text === '不删吧,观众三秒就溜达一下了。', E2.segments[1].text)

// ── 7. 断言真的会拦：时间码被动、词数变化、范围外的词被改 ──
const bad1 = words.map(w => ({ ...w })); bad1[18].start = 7.77
ok('断言 · 拦住时间码被改', (() => { try { assertUntouched(words, bad1, { changed: E1.changed }); return false } catch { return true } })())
const bad2 = words.slice(0, -1)
ok('断言 · 拦住词数变化', (() => { try { assertUntouched(words, bad2, { changed: E1.changed }); return false } catch { return true } })())
const bad3 = words.map(w => ({ ...w })); bad3[0].w = '许多人'
ok('断言 · 拦住范围外改动', (() => { try { assertUntouched(words, bad3, { changed: E1.changed }); return false } catch { return true } })())

// ── 8. 单字词直接命中（不跨词）──
const L6 = locate(words, '观众', {})
const E3 = applyEdit({ words, segments, match: L6.match, to: '看客' })
ok('改字 · 同词内替换', E3.changed.length === 1 && E3.words[14].w === '看客' && assertUntouched(words, E3.words, { changed: E3.changed }))

const total = pass + fails.length
if (fails.length) {
  console.log('FAIL · ' + fails.length + '/' + total + ' 条没过')
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('PASS · ' + total + ' 条全过（解析 7 / 定位 6 / 改字 6 / 断言 3）')
}
