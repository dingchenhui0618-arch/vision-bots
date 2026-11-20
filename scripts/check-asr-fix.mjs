/**
 * 错字治理的自检：术语表、模型提案的校验器、句子回流、硬断言。
 * 模型提案用固定样本喂进来，不联网；拼音校验在本机有 uv 时额外验一遍。
 */
import { applyTerms, applyToSegments, validate, correct, hotwordPrompt, pinyinOf, loadTerms } from '../src/asr-fix.mjs'

let pass = 0
const fails = []
function ok(name, cond, detail = '') {
  if (cond) { pass++; return }
  fails.push(name + (detail ? '：' + detail : ''))
}

const W = (w, start, p) => ({ w, start, end: +(start + 0.32).toFixed(2), ...(p === undefined ? {} : { p }) })
const words = [
  W('很多', 0.0), W('人', 0.32), W('做', 0.64), W('口', 0.96), W('播', 1.28), W('视频，', 1.6),
  W('观众', 2.0, 0.92), W('三', 2.32, 0.42), W('秒', 2.64), W('就', 2.96), W('化', 3.28, 0.51), W('走了。', 3.6),
]

// ── 1. 术语表：单字条目靠后一个词定位（ASR 把「划走」拆成「化」+「走」）──
const terms = [
  { from: ['画走'], to: '划走', kind: 'homophone' },
  { from: ['化'], to: '划', kind: 'homophone', next: ['走'] },
  { from: ['视频'], to: '短视频', kind: 'term' },
]
const g = applyTerms(words, terms)
ok('术语表 · 后接定位命中', g.words[10].w === '划', JSON.stringify(g.words[10]))
ok('术语表 · 只改文本不动时间码', g.words[10].start === 3.28 && g.words[10].end === 3.6)
ok('术语表 · 字数不一致的不换', g.words[5].w === '视频，', g.words[5].w)
ok('术语表 · 换了的记进 hits', g.hits.length === 1 && g.hits[0].from === '化' && g.hits[0].to === '划', JSON.stringify(g.hits))
ok('术语表 · 字数不一致的记进 skipped', g.skipped.some(s => s.from === '视频'), JSON.stringify(g.skipped))

// ── 2. 低置信才覆盖：识别得够准的词，术语表不硬改 ──
const g2 = applyTerms(words, [{ from: ['观众'], to: '看客', kind: 'term', onlyIfLowConfidence: true }])
ok('术语表 · 高置信不覆盖', g2.words[6].w === '观众' && g2.skipped.length === 1, JSON.stringify(g2.skipped))

// ── 3. 校验器：四类之外的、改字数的、越界的、重复的，一律打回 ──
const V = async (proposals, opts = {}) => validate(proposals, words, { terms, pinyin: null, ...opts })
const v1 = await V([{ i: 10, to: '画', kind: 'homophone', why: '同音' }])
ok('校验 · 没有拼音能力就保守', v1.accepted.length === 0 && /保守模式/.test(v1.rejected[0].why), JSON.stringify(v1.rejected[0]))
const v2 = await V([{ i: 10, to: '划', kind: 'term', why: '术语表' }])
ok('校验 · 专有名词命中术语表才放行', v2.accepted.length === 1 && v2.accepted[0].to === '划', JSON.stringify(v2))
const v3 = await V([{ i: 10, to: '去', kind: 'term' }])
ok('校验 · 术语表里没有的专有名词拦下', v3.accepted.length === 0 && /术语表里没有/.test(v3.rejected[0].why), JSON.stringify(v3.rejected[0]))
const v4 = await V([{ i: 10, to: '划走', kind: 'homophone' }])
ok('校验 · 改字数拦下', v4.accepted.length === 0 && /字数变了/.test(v4.rejected[0].why), JSON.stringify(v4.rejected[0]))
const v5 = await V([{ i: 99, to: '划', kind: 'term' }, { i: -1, to: '划', kind: 'term' }])
ok('校验 · 越界拦下', v5.accepted.length === 0 && v5.rejected.length === 2)
const v6 = await V([{ i: 10, to: '划', kind: 'term' }, { i: 10, to: '划', kind: 'term' }])
ok('校验 · 同一词位只认一次', v6.accepted.length === 1 && /改了两次/.test(v6.rejected[0].why), JSON.stringify(v6.rejected[0]))
const v7 = await V([{ i: 10, to: '化', kind: 'term' }])
ok('校验 · 改完和原来一样拦下', v7.accepted.length === 0 && /一样/.test(v7.rejected[0].why), JSON.stringify(v7.rejected[0]))
const v8 = await V([{ i: 10, to: '划', kind: 'punct' }])
ok('校验 · 标点类不用改', v8.accepted.length === 0 && /标点/.test(v8.rejected[0].why), JSON.stringify(v8.rejected[0]))
const v9 = await V([{ i: 10, to: '划', kind: 'rewrite' }])
ok('校验 · 四类之外拦下', v9.accepted.length === 0 && /不在允许的四类里/.test(v9.rejected[0].why), JSON.stringify(v9.rejected[0]))

// ── 4. 数字：只修「本来就是阿拉伯数字、但写错了」，两个方向都不许改写 ──
const numWords = [W('今天', 0), W('讲', 0.3), W('3', 0.6), W('个', 0.9), W('3', 1.2), W('点', 1.5)]
const n1 = await validate([{ i: 2, to: '4', kind: 'number' }], numWords, { terms, pinyin: null })
ok('数字 · 阿拉伯换阿拉伯放行', n1.accepted.length === 1 && n1.accepted[0].to === '4', JSON.stringify(n1))
const n2 = await validate([{ i: 4, to: '三', kind: 'number' }], numWords, { terms, pinyin: null })
ok('数字 · 数字改汉字算改写，拦下', n2.accepted.length === 0 && /改写/.test(n2.rejected[0].why), JSON.stringify(n2.rejected[0]))
const n3 = await validate([{ i: 3, to: '2', kind: 'number' }], numWords, { terms, pinyin: null })
ok('数字 · 汉字改阿拉伯也拦下', n3.accepted.length === 0 && /改写/.test(n3.rejected[0].why), JSON.stringify(n3.rejected[0]))

// ── 5. 上限：改太多说明模型在瞎猜 ──
const many = Array.from({ length: 10 }, (_, i) => ({ i, to: '啊', kind: 'term' }))
const capTerms = [{ from: ['很'], to: '啊', kind: 'term' }, { from: ['多'], to: '啊', kind: 'term' }]
const vc = await validate(many, words, { terms: capTerms, pinyin: null })
ok('校验 · 超过本轮上限就拦', vc.accepted.length <= 4 && vc.rejected.some(r => /上限/.test(r.why)), vc.accepted.length + '/' + vc.rejected.length)

// ── 6. 主入口：关掉模型只跑术语表也能修干净，且硬断言成立 ──
const c1 = await correct({ words, terms, askModel: false })
ok('主入口 · 术语表修好了', c1.words[10].w === '划', c1.words[10].w)
ok('主入口 · 词数不变', c1.words.length === words.length)
ok('主入口 · 每个词起止时间一个没动', c1.words.every((w, i) => w.start === words[i].start && w.end === words[i].end))
ok('主入口 · 断言写进报告', c1.report.assertion.wordCount === true && c1.report.assertion.timingUntouched === true, JSON.stringify(c1.report.assertion))
ok('主入口 · 低置信词进待确认', c1.report.pending.some(p => p.w === '三' && p.at === 2.32), JSON.stringify(c1.report.pending))
ok('主入口 · 台账带统计', c1.report.stats.changed === 1 && c1.report.stats.words === words.length, JSON.stringify(c1.report.stats))

// ── 7. 句子回流：字幕和画面大字用的是句子，不能只改词 ──
const segments = [{ start: 0, end: 3.0, text: '很多人做口播视频，观众三秒就化' }, { start: 3.2, end: 4.0, text: '走了。' }]
const seg = applyToSegments(c1.words, segments)
ok('句式 · 按词重建句子', seg[1].text === '划走了。', seg[1].text)
ok('句式 · 时间不动', seg[1].start === 3.2 && seg[1].end === 4.0)

// ── 8. 热词串 ──
const t = loadTerms()
ok('术语 · 仓库词表能读出来', Array.isArray(t) && t.length > 0 && t.hotwords.length > 0, t.length + ' 条')
ok('术语 · 热词串不超长', (() => { const h = hotwordPrompt([{ from: ['x'], to: '很长的专有名词' }], 20); return h.length <= 20 })())

// ── 9. 有拼音能力时，同音才放行（本机没 uv 就跳过）──
const py = await pinyinOf(['划走', '画走'])
if (py) {
  ok('拼音 · 同音', py[0] === py[1], JSON.stringify(py))
  const py2 = await pinyinOf(['划走', '溜走'])
  ok('拼音 · 不同音', py2[0] !== py2[1], JSON.stringify(py2))
  const vh = await validate([{ i: 10, to: '画', kind: 'homophone', why: '同音' }], words, { terms, pinyin: undefined })
  ok('拼音 · 同音提案放行', vh.accepted.length === 1 && /拼音/.test(vh.accepted[0].verified), JSON.stringify(vh))
  const vh2 = await validate([{ i: 10, to: '去', kind: 'homophone', why: '同音' }], words, { terms, pinyin: undefined })
  ok('拼音 · 不同音提案拦下', vh2.accepted.length === 0 && /不同音/.test(vh2.rejected[0].why), JSON.stringify(vh2.rejected[0]))
} else {
  console.log('· 本机没有拼音校验（uv/pypinyin 不可用），同音相关 4 条跳过')
}

const total = pass + fails.length
if (fails.length) {
  console.log('FAIL · ' + fails.length + '/' + total + ' 条没过')
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('PASS · ' + total + ' 条全过（术语表 5 / 低置信 1 / 校验器 9 / 数字 3 / 上限 1 / 主入口 6 / 句式 2 / 热词 2' + (py ? ' / 拼音 4' : '') + '）')
}
