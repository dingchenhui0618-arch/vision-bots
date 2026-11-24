/**
 * 错字治理的自检：术语表、模型提案的校验器、句子回流、硬断言。
 * 模型提案用固定样本喂进来，不联网；拼音校验在本机有 uv 时额外验一遍。
 */
import { applyTerms, applyToSegments, mergeAsciiRuns, breaksWord, validate, validateSpans, sentenceView, correct, hotwordPrompt, pinyinOf, phoneticOf, phonOnly, oneCharSwap, loadTerms, LEN_NUDGE, openQuestions, vetoPlan, nearEqual } from '../src/asr-fix.mjs'

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

// ── 10. 跨词重排：ASR 把词切错了位置，只能按总字数不变重排 ──
const cw = [W('就', 0), W('化', 1), W('走', 2), W('了', 3)]
const cwCalm = cw.map(w => ({ ...w, p: 0.99 }))
const s1 = await validate([{ i: 1, n: 2, to: '划走', kind: 'homophone' }], cwCalm, { terms: [], pinyin: undefined })
if (py) {
  ok('跨词 · 相邻两词按原字长重排', s1.accepted.length === 1 && s1.accepted[0].parts.join('') === '划走', JSON.stringify(s1.rejected[0] || s1.accepted[0]))
} else {
  ok('跨词 · 没有拼音时保守（不采纳）', s1.accepted.length === 0 && s1.rejected.length === 1)
}
const s2 = await validate([{ i: 1, n: 2, to: '划走啊', kind: 'homophone' }], cwCalm, { terms: [], pinyin: null })
ok('跨词 · 总字数变了要拦', s2.accepted.length === 0 && /字数变了/.test(s2.rejected[0].why), JSON.stringify(s2.rejected[0]))
const s3 = await validate([{ i: 1, n: 2, to: '划，走', kind: 'homophone' }], cwCalm, { terms: [], pinyin: null })
ok('跨词 · 片段里带标点要拦', s3.accepted.length === 0 && /标点/.test(s3.rejected[0].why), JSON.stringify(s3.rejected[0]))
const s4 = await validate([{ i: 2, n: 9, to: '划走', kind: 'homophone' }], cwCalm, { terms: [], pinyin: null })
ok('跨词 · 区间越界要拦', s4.accepted.length === 0 && /越界/.test(s4.rejected[0].why), JSON.stringify(s4.rejected[0]))
const cwPunct = [W('就', 0), W('化', 1), W('走了。', 2)]
const s5 = await validate([{ i: 1, n: 2, to: '划走了', kind: 'homophone' }], cwPunct.map(w => ({ ...w, p: 0.99 })), { terms: [], pinyin: py ? undefined : null })
if (py) {
  ok('跨词 · 标点留在原位', s5.accepted.length === 1 && s5.accepted[0].parts[1] === '走了。', JSON.stringify(s5.accepted[0] || s5.rejected[0]))
}
const cwFixed = cw.map((w, i) => i === 1 ? { ...w, fixed: true } : w)
const s6 = await validate([{ i: 1, n: 2, to: '划走', kind: 'homophone' }], cwFixed, { terms: [], pinyin: null })
ok('跨词 · 术语表改过的词位不许再动', s6.accepted.length === 0 && /术语表或整句纠错改过/.test(s6.rejected[0].why), JSON.stringify(s6.rejected[0]))

// ── 11. 近音：「千」和「天」本来就不同音，必须有低置信词做独立证据 ──
const nw = [W('我', 0), W('要', 1), W('花', 2), W('一', 3, 0.54), W('千', 4, 0.83), W('的', 5), W('时间', 6)]
const nCalm = nw.map(w => w.w === '一' ? { ...w, p: 0.99 } : w)
if (py) {
  const h1 = await validate([{ i: 4, to: '天', kind: 'near', why: '一千的时间不通' }], nw, { terms: [], pinyin: undefined })
  ok('近音 · 韵母声调一致、声母不同才放行', h1.accepted.length === 1 && /ian1/.test(h1.accepted[0].verified), JSON.stringify(h1.rejected[0] || h1.accepted[0]))
  const h2 = await validate([{ i: 4, to: '天', kind: 'near' }], nCalm, { terms: [], pinyin: undefined })
  ok('近音 · 没有低置信邻居就拦', h2.accepted.length === 0 && /独立证据/.test(h2.rejected[0].why), JSON.stringify(h2.rejected[0]))
  const h3 = await validate([{ i: 4, to: '就', kind: 'near' }], nw, { terms: [], pinyin: undefined })
  ok('近音 · 韵母或声调不同就拦', h3.accepted.length === 0 && /韵母或声调不同/.test(h3.rejected[0].why), JSON.stringify(h3.rejected[0]))
  const h4 = await validate([{ i: 4, to: '签', kind: 'near' }], nw, { terms: [], pinyin: undefined })
  ok('近音 · 本来就是同音的要改报同音', h4.accepted.length === 0 && /本来就是同音/.test(h4.rejected[0].why), JSON.stringify(h4.rejected[0]))
  const cap3 = [W('花', 0), W('一', 1, 0.5), W('千', 2), W('花', 3), W('一', 4, 0.5), W('千', 5), W('花', 6), W('一', 7, 0.5), W('千', 8)]
  const h5 = await validate([{ i: 2, to: '天', kind: 'near' }, { i: 5, to: '天', kind: 'near' }, { i: 8, to: '天', kind: 'near' }], cap3, { terms: [], pinyin: undefined })
  ok('近音 · 全片最多 2 处', h5.accepted.length === 2 && h5.rejected.some(r => /最多 2 处/.test(r.why)), h5.accepted.length + '/' + h5.rejected.length)
} else {
  console.log('· mkdir 拼音不可用，近音 5 条跳过')
}

// ── 12. 整句复读：整段等字数替换（第二遍），证据只认「这一段都是低置信词」 ──
const sw = [W('指', 0, 0.33), W('纹', 0.4, 0.55), W('住', 0.8, 0.31), W('在', 1.2, 0.62), W('做', 1.6), W('内容', 2.0), W('为什么', 2.4)]
const sv = sentenceView(sw, [{ start: 0, end: 3.0, text: '指纹住在做内容为什么' }])
const S = (items, opts) => validateSpans(items, sw, sv, opts)
const p1 = await S([{ s: 1, from: '指纹住在', to: '真正在做', why: '听成了指纹' }])
ok('整句 · 只有低置信推断的整段改法不再自动落地，标记成候选', p1.accepted.length === 0 && p1.rejected[0].need === true && p1.rejected[0].weak === true, JSON.stringify(p1.rejected[0] || {}))
const p1b = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做' }], sw, sv, { duals: new Set(['1|指纹住在|真正在做']), dualModel: 'smart' })
ok('整句 · 等字数替换 + 两个模型一致才放行', p1b.accepted.length === 1 && p1b.accepted[0].kind === 'span' && p1b.accepted[0].n === 4, JSON.stringify(p1b.rejected[0] || {}))
ok('整句 · 换完字数没变（字幕卡不会撑破）', p1b.accepted.length === 1 && p1b.accepted[0].parts.join('').length === 4, JSON.stringify(p1b.accepted[0] && p1b.accepted[0].parts))
// 「内容」是一个词：只取里面的「容」就切在词中间（这种改法会把半个词改掉）
const p2 = await S([{ s: 1, from: '容', to: '差' }])
ok('整句 · 首尾切在词中间就拦', p2.accepted.length === 0 && /词中间/.test(p2.rejected[0].why), JSON.stringify(p2.rejected[0]))
const p3 = await S([{ s: 1, from: '没有这段', to: '同样字数吧' }])
ok('整句 · from 不在句子里就拦', p3.accepted.length === 0 && /逐字出现/.test(p3.rejected[0].why), JSON.stringify(p3.rejected[0]))
const p4 = await S([{ s: 1, from: '指纹住在', to: '真正在做呢' }])
ok('整句 · 加字一律拦（撑破字幕卡）', p4.accepted.length === 0 && /字数变了/.test(p4.rejected[0].why), JSON.stringify(p4.rejected[0]))
const p4b = await S([{ s: 1, from: '指纹住在', to: '真正在' }])
ok('整句 · 删字不当场拦，但要等第二意见', p4b.accepted.length === 0 && /删字必须有第二个模型/.test(p4b.rejected[0].why), JSON.stringify(p4b.rejected[0]))
const sureSpan = sw.map((w, i) => i === 1 ? { ...w, p: 0.93 } : w)
const sv2 = sentenceView(sureSpan, [{ start: 0, end: 3.0 }])
const p5 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做' }], sureSpan, sv2, {})
ok('整句 · 段里有识别很确定的词就不许整段改', p5.accepted.length === 0 && /识别得很确定/.test(p5.rejected[0].why), JSON.stringify(p5.rejected[0]))
const p6 = await S([{ s: 1, from: '指纹住在', to: '真正在做' }], { skip: new Set([0, 1, 2, 3]) })
ok('整句 · 已经改过的段不再动（和术语表/第一遍不打架）', p6.accepted.length === 0 && /已经改过/.test(p6.rejected[0].why), JSON.stringify(p6.rejected[0]))
const dup = [W('看', 0, 0.4), W('看', 0.4, 0.4), W('这', 0.8, 0.4), W('个', 1.2, 0.4)]
const dsv = sentenceView(dup, [{ start: 0, end: 2.0 }])
const p7 = await validateSpans([{ s: 1, from: '看', to: '听' }], dup, dsv, {})
ok('整句 · from 出现两次以上定位不了', p7.accepted.length === 0 && /两次以上/.test(p7.rejected[0].why), JSON.stringify(p7.rejected[0]))
const manySpans = [
  { s: 1, from: '指纹住在', to: '真正在做' },
  { s: 1, from: '住在做', to: '在装配' },
]
const p8 = await validateSpans(manySpans, sw, sv, { duals: new Set(['1|指纹住在|真正在做', '1|住在做|在装配']) })
ok('整句 · 同一段只认一条', p8.accepted.length === 1 && p8.rejected.some(r => /已经改过/.test(r.why)), p8.accepted.length + '/' + p8.rejected.length)


// ── 13. 证据词条（from 空）：只让校验器认得这个词，不做替换 ──
const evTerms = [{ kind: 'term', to: 'GPT', from: [] }, { kind: 'term', to: 'Claude', from: [] }]
const evT = loadTerms()
ok('证据词条 · 仓库表里有 from 空的专有名词', evT.some(t => t.to === 'GPT' && Array.isArray(t.from) && t.from.length === 0), JSON.stringify(evT.filter(t => !t.from.length).map(t => t.to)))
const evG = applyTerms([W('用', 0), W('GDP', 0.4)], evTerms)
ok('证据词条 · 不做确定性替换（用户真说 GDP 不许被改）', evG.words[1].w === 'GDP' && evG.hits.length === 0, JSON.stringify(evG.words.map(w => w.w)))

// ── 14. 拉丁词：等字数放宽，但只放给「命中术语表」的专有名词 ──
const lw = [W('大家', 0), W('用', 0.4), W('Cloud', 0.8, 0.97), W('做', 1.2), W('内容', 1.6)]
const L1 = await validate([{ i: 2, to: 'Claude', kind: 'term' }], lw, { terms: evTerms, pinyin: null })
ok('拉丁 · Cloud→Claude 字数 +1 放行（字母不占等量时间）', L1.accepted.length === 1 && L1.accepted[0].parts[0] === 'Claude' && /术语表/.test(L1.accepted[0].verified), JSON.stringify(L1.rejected[0] || L1.accepted[0]))
const L2 = await validate([{ i: 2, to: 'Claude', kind: 'term' }], lw, { terms: [], pinyin: null })
ok('拉丁 · 术语表里没有就不许改字数', L2.accepted.length === 0 && /术语表里没有/.test(L2.rejected[0].why), JSON.stringify(L2.rejected[0]))
const L3 = await validate([{ i: 2, to: 'ClaudeCode', kind: 'term' }], lw, { terms: evTerms, pinyin: null })
ok('拉丁 · 差 5 个字母还是要拦', L3.accepted.length === 0 && /字数变了/.test(L3.rejected[0].why), JSON.stringify(L3.rejected[0]))
const L4 = await validate([{ i: 2, to: 'claude', kind: 'term' }], lw, { terms: evTerms, pinyin: null })
ok('拉丁 · 大小写是 ASR 的写法，认词不认大小写', L4.accepted.length === 1 && L4.accepted[0].parts[0] === 'claude', JSON.stringify(L4.rejected[0] || L4.accepted[0]))
const lowLatin = [W('用', 0), W('Cloud', 0.4), W('做', 0.8)]
const LV = sentenceView(lowLatin, [{ start: 0, end: 2.0 }])
const L5 = await validateSpans([{ s: 1, from: 'Cloud', to: 'Claude' }], lowLatin, LV, { duals: new Set(['1|Cloud|Claude']), dualModel: 'm' })
ok('拉丁 · 连双模型一致也不许改拉丁词字数（要有术语证据）', L5.accepted.length === 0 && /拉丁词改字数/.test(L5.rejected[0].why), JSON.stringify(L5.rejected[0]))

// ── 15. 双模型一致：语义型错的唯一证据档，要两条独立事实 + 单独配额 ──
const dualKey = (s, f, t) => s + '|' + f + '|' + t
const D1 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做' }], sureSpan, sv2, { duals: new Set([dualKey(1, '指纹住在', '真正在做')]), dualModel: 'qwen3.8-max' })
ok('双模型 · 两个模型逐字一致就放行', D1.accepted.length === 1 && /双模型一致（qwen3.8-max）/.test(D1.accepted[0].verified), JSON.stringify(D1.rejected[0] || D1.accepted[0]))
const D2 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做' }], sureSpan, sv2, { duals: new Set([dualKey(1, '指纹住在', '真正在')]) })
ok('双模型 · 不在一致清单里照样打回，并标记 need（留给第二意见）', D2.accepted.length === 0 && D2.rejected[0].need === true, JSON.stringify(D2.rejected[0]))
const dw = [W('甲', 0, 0.95), W('乙', 0.3, 0.95), W('丙', 0.6, 0.95), W('丁', 0.9, 0.95)]
const dv = sentenceView(dw, [{ start: 0, end: 2.0 }])
const threeDual = new Set([dualKey(1, '甲', '戊'), dualKey(1, '乙', '己'), dualKey(1, '丙', '庚')])
const D3 = await validateSpans([{ s: 1, from: '甲', to: '戊' }, { s: 1, from: '乙', to: '己' }, { s: 1, from: '丙', to: '庚' }], dw, dv, { duals: threeDual, dualModel: 'm' })
ok('双模型 · 全片最多 2 处', D3.accepted.length === 2 && D3.rejected.some(r => /双模型一致全片最多 2 处/.test(r.why)), D3.accepted.length + '/' + D3.rejected.length)
const D4 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做呢' }], sureSpan, sv2, { duals: new Set([dualKey(1, '指纹住在', '真正在做呢')]) })
const nudge = LEN_NUDGE([{ from: '指纹住在', to: '真正在' }])
ok('字数回问 · 提示里摆出具体字数（4 字 / 3 字）', /4 字/.test(nudge) && /3 字/.test(nudge) && /补不齐/.test(nudge), nudge.slice(0, 80))
ok('双模型 · 加字谁来提都不认', D4.accepted.length === 0 && /字数变了/.test(D4.rejected[0].why), JSON.stringify(D4.rejected[0]))

// ── 16. 删字：ASR 多吐一个字时，等字数规则会把对的改法挡在门外 ──
// 真事件：口播是「真正在做内容」，whisper 吐成「指纹住在做内容」，模型两次正确地提「指纹住在→真正在」，
// 都被「字数变了」挡回来，最后这句错字上了屏。删字必须放，但只认第二个模型逐字同意。
const del = [W('指', 0, 0.5), W('纹', 0.4, 0.5), W('住', 0.8, 0.5), W('在', 1.2, 0.99), W('做', 1.6), W('内容', 2.0)]
const dv2 = sentenceView(del, [{ start: 0, end: 3.0 }])
const sp1 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在' }], del, dv2, { duals: new Set(['1|指纹住在|真正在']), dualModel: 'smart' })
ok('删字 · 两个模型逐字同意就放行（4 字→3 字）', sp1.accepted.length === 1 && sp1.accepted[0].deleted === 1, JSON.stringify(sp1.rejected[0] || sp1.accepted[0]))
ok('删字 · 最后一个词变空词，前面的字一位不错', sp1.accepted.length === 1 && JSON.stringify(sp1.accepted[0].parts) === JSON.stringify(['真', '正', '在', '']), JSON.stringify(sp1.accepted[0] && sp1.accepted[0].parts))
ok('删字 · 词数与时间码不动', sp1.accepted.length === 1 && del.length === 6 && del[3].start === 1.2, String(del.length))
const sp2 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在' }], del, dv2, {})
ok('删字 · 没有第二意见就不许删', sp2.accepted.length === 0 && /删字必须有第二个模型/.test(sp2.rejected[0].why), JSON.stringify(sp2.rejected[0]))
const sp3 = await validateSpans([{ s: 1, from: '指纹住在', to: '真正在做呢' }], del, dv2, { duals: new Set(['1|指纹住在|真正在做呢']), dualModel: 'smart' })
ok('加字 · 依然一律拦下（撑破字幕卡）', sp3.accepted.length === 0 && /字数变了/.test(sp3.rejected[0].why), JSON.stringify(sp3.rejected[0]))
const sp4 = await validateSpans([{ s: 1, from: '指', to: '真' }], del, dv2, {})
ok('删字 · 词层那条路不放宽（只走整句通道）', sp4.accepted.length === 0 && sp4.rejected[0].need === true, JSON.stringify(sp4.rejected[0]))

// 提案粒度不同、改的是同一个字：变更映射要能认出来（第二意见靠这个比，而不是比 from/to 字符串）
const mw = [W('我', 0, 0.5), W('要', 0.3, 0.5), W('花', 0.6, 0.5), W('一', 0.9, 0.5), W('千', 1.2, 0.5), W('的', 1.5, 0.5), W('时间', 1.8, 0.5)]
const mv = sentenceView(mw, [{ start: 0, end: 2.4 }])
const M1 = await validateSpans([{ s: 1, from: '花一千的时间', to: '花一天的时间' }], mw, mv, {})
ok('变更映射 · 只记真正改掉的字（千→天）', M1.rejected[0] && JSON.stringify(M1.rejected[0].map) === JSON.stringify([[4, '天']]), JSON.stringify(M1.rejected[0] && M1.rejected[0].map))
const M2 = await validateSpans([{ s: 1, from: '一千', to: '一天' }], mw, mv, {})
ok('变更映射 · 粒度更小的同一条改法映射相同', M2.rejected[0] && JSON.stringify(M2.rejected[0].map) === JSON.stringify([[4, '天']]), JSON.stringify(M2.rejected[0] && M2.rejected[0].map))

// ── 17. 英文碎片合并与拉丁词放宽：ASR 把专有名词拆碎、拼错，靠术语表兜住 ──
// 实测同一句「大家用GPT用Cloud用Codex这些工具」：GPT 被拆成「G」+「PT」，
// Codex 被拆成「C」+「ode」+「x」（「ode」时长为 0），Cloud 拼错（p=0.21）。
// 中文那套「等字数」在这里全都不适用：英文一个词就是一个词槽，字母数不占音节。
const ascii = [W('C', 33.72, 0.88), W('ode', 33.92, 0.18), W('x', 34.14, 0.77)]
const mg = mergeAsciiRuns(ascii, [{ to: 'Codex' }, { to: 'GPT' }])
ok('英文碎片 · C+ode+x 合成一个 Codex', mg.words.length === 1 && mg.words[0].w === 'Codex', JSON.stringify(mg.words))
ok('英文碎片 · 时间取这一段的起止（34.14 之后仍有长度）', mg.words[0].start === 33.72 && mg.words[0].end === 34.46, JSON.stringify(mg.words[0]))
ok('英文碎片 · 净词数变化如实记账（3→1）', mg.delta === -2 && mg.hits.length === 1, mg.delta)
const mg2 = mergeAsciiRuns([W('G', 31.28, 0.42), W('PT', 31.56, 0.97)], [{ to: 'GPT' }])
ok('英文碎片 · G+PT 合成 GPT', mg2.words.length === 1 && mg2.words[0].w === 'GPT', JSON.stringify(mg2.words))
ok('英文碎片 · 拼起来不是术语表里的词就不并', mergeAsciiRuns(ascii, [{ to: 'Claude' }]).words.length === 3)
ok('英文碎片 · 两个词都很有把握、时长也正常 → 不并', mergeAsciiRuns([W('AI', 0, 0.98), W('GPT', 0.32, 0.99)], [{ to: 'AIGPT' }]).words.length === 2)
const lt = applyTerms([W('Cloud', 32.54, 0.21)], [{ from: ['Cloud'], to: 'Claude', kind: 'term', onlyIfLowConfidence: true }])
ok('拉丁词 · 低置信的 Cloud → Claude（多一个字母不占音节）', lt.words[0].w === 'Claude' && lt.hits.length === 1 && lt.hits[0].latin === true, JSON.stringify(lt.hits))
ok('拉丁词 · 时间码一个字都不动', lt.words[0].start === 32.54 && lt.words[0].end === 32.86, JSON.stringify(lt.words[0]))
const lt2 = applyTerms([W('Cloud', 32.54, 0.96)], [{ from: ['Cloud'], to: 'Claude', kind: 'term', onlyIfLowConfidence: true }])
ok('拉丁词 · 识别得够准就不覆盖（真说「云」的时候不许改）', lt2.words[0].w === 'Cloud' && lt2.skipped.length === 1, JSON.stringify(lt2.skipped))
const lt3 = applyTerms([W('视频', 0, 0.5)], [{ from: ['视频'], to: '短视频', kind: 'term' }])
ok('中文 · 仍然不许改字数（会撑破字幕卡）', lt3.words[0].w === '视频' && /字数不一致/.test(lt3.skipped[0].why), JSON.stringify(lt3.skipped))

// ── 18. 别把词改碎：同音只看一个字，看不见「时代」是个词 ──
ok('分词 · AI时代 → AI是代 就是改碎', breaksWord('AI时代', 'AI是代') === true)
ok('分词 · 画走 → 划走 是把碎字改整，放行', breaksWord('画走', '划走') === false)
ok('分词 · 直到 → 知道 两边都是整词，放行', breaksWord('直到会做', '知道会做') === false)
ok('分词 · 一千 → 一天 两边都是整词，放行', breaksWord('一千的时间', '一天的时间') === false)
if (py) {
  const wV = [W('AI', 0, 0.87), W('时', 0.46, 0.23), W('代', 0.92, 1), W('最', 1.2, 0.92), W('赚钱', 1.66, 0.98)]
  const vV = await validate([{ i: 1, to: '是', kind: 'homophone', why: '同音' }], wV, { terms: [] })
  ok('校验 · 低置信的「时→是」虽然同音，但会把「时代」改碎 → 打回', vV.accepted.length === 0 && /切碎/.test(String(vV.rejected[0] && vV.rejected[0].why)), JSON.stringify(vV.rejected[0]))
}

// ── 19. 只差一个元音的那一类（捡 jiǎn / 卷 juǎn）：文本判不了，交听音复核 ──
// 自测18 交付片里「别再卷技术了」写成「别再捡技术了」：模型报了、规则按「不同音」打回，错字出厂。
// 现在这类不进采纳、也不简单打回，而是记成「待听」——只有音频说「卷」才改。
if (py) {
  const [pj, ju, qian, tian, pen, ping] = await phoneticOf(['捡', '卷', '千', '天', '盆', '瓶'])
  const c1 = phonOnly(pj, ju)
  ok('只差一个元音 · 捡/卷（同声母同声调、韵母 ian/uan）算待听', Boolean(c1) && c1.rimeA === 'ian' && c1.rimeB === 'uan' && c1.tone === '3', JSON.stringify(c1))
  ok('只差一个元音 · 千/天 声母不同，归近音不归这里', phonOnly(qian, tian) === null)
  ok('只差一个元音 · 盆/瓶 韵母差两个字母，不值得花一次重听', phonOnly(pen, ping) === null)
  ok('只差一个元音 · 同音（拼音全等）不算这一类', phonOnly(pj, pj) === null)

  const jw = [W('别', 0), W('再', 0.32), W('去', 0.64), W('捡', 0.96, 0.8), W('技', 1.28), W('术', 1.6), W('了', 1.92)]
  const vp = await validate([{ i: 3, to: '卷', kind: 'homophone', why: '应为卷' }], jw, { terms: [] })
  ok('只差一个元音 · 不进采纳（文本证据不够）', vp.accepted.length === 0)
  ok('只差一个元音 · 记成待听并写清理由', vp.phon.length === 1 && vp.phon[0].from === '捡' && vp.phon[0].to === '卷', JSON.stringify(vp.phon))
  ok('只差一个元音 · 报告里的理由是「已交听音复核」', /已交听音复核/.test(String(vp.rejected[0] && vp.rejected[0].why)), JSON.stringify(vp.rejected[0]))
  const vp2 = await validate([{ i: 3, to: '卷', kind: 'near', why: '应为卷' }], jw, { terms: [] })
  ok('只差一个元音 · 报成 near 也照样转听音，不会漏', vp2.phon.length === 1 && vp2.accepted.length === 0, JSON.stringify(vp2.phon))
  const bw = [W('一', 0), W('盆', 0.32, 0.8), W('花', 0.64)]
  const vb = await validate([{ i: 1, to: '瓶', kind: 'homophone', why: '应为瓶' }], bw, { terms: [] })
  ok('只差一个元音 · 差得远的提案不占重听预算', vb.phon.length === 0 && /不同音/.test(String(vb.rejected[0] && vb.rejected[0].why)), JSON.stringify(vb.rejected[0]))
}

// 闸门：音频只能在这一处换一个字，多一个字都不算「这一个音节听清了」
const gate = oneCharSwap('别再去捡技术了', '别再去卷技术了')
ok('听音闸门 · 只差一个字 → 认', Boolean(gate) && gate.from === '捡' && gate.to === '卷' && gate.at === 3, JSON.stringify(gate))
ok('听音闸门 · 差两个字 → 不认（那是另一次转写）', oneCharSwap('别再去捡技术了', '别再该卷技术了') === null)
ok('听音闸门 · 字数不同 → 不认', oneCharSwap('别再去捡技术了', '别再卷技术') === null)
ok('听音闸门 · 完全一致 → 不认（提案不成立）', oneCharSwap('别再去捡技术了', '别再去捡技术了') === null)

// ── 20. 「没解决」的两种：没听过 / 听过了但音频和字幕不一致（自测26）──
// 自测25 的报告只写「没把握 15/248 = 6.0%」，那 15 个字全在 10 句从没被听过的句子里：
// 数字看着像风险度量，实际没有对应动作，最后带着「今天大街→今天大家」交付。
const oqWords = [
  { w: '甲', start: 0.0, end: 0.3, p: 0.2 },
  { w: '乙', start: 0.3, end: 0.6, p: 0.95 },
  { w: '丙', start: 0.6, end: 0.9, p: 0.3 },
  { w: '丁', start: 0.9, end: 1.2, p: 0.1 },
]
const oq = openQuestions({ current: oqWords, heardRanges: [[0, 0.6]], openRanges: [[0.6, 0.9]] })
ok('强耳朵逐字读过且一致 → 不再算怀疑', !oq.some(x => x.w === '甲'), JSON.stringify(oq))
ok('高置信词不进来', !oq.some(x => x.w === '乙'), JSON.stringify(oq))
ok('听过了、音频和字幕不一致 → 记成 audio-differs', oq.some(x => x.w === '丙' && x.why === 'audio-differs'), JSON.stringify(oq))
ok('从没听过 → 记成 never-heard（这才该去听）', oq.some(x => x.w === '丁' && x.why === 'never-heard'), JSON.stringify(oq))
ok('已改过 / 听音改过的词不再列为怀疑', openQuestions({ current: oqWords, appliedIdx: new Set([3]), audioIdx: new Set([2]), heardRanges: [[0, 0.6]], openRanges: [[0.6, 0.9]] }).length === 0)
ok('两类混在一份名单里也能分开数', oq.filter(x => x.why === 'never-heard').length === 1 && oq.filter(x => x.why === 'audio-differs').length === 1, JSON.stringify(oq))

// ── 21. 音频否决：我们改过的字，音频读的是改之前那句 → 退回去（自测26）──
// 实测 45.21–47.73s：「一千→一天」是两个文本模型一致同意的，medium 六个窗口却全读成「1000」（＝一千）。
// 两个文本模型的共识不是音频证据；这条通道能改字，就必须能被音频退回来。
const VPW = (w, w0, src) => ({ w, w0, src, start: 0, end: 0.3, p: 0.9 })
const vp1 = vetoPlan({
  current: [VPW('我', null), VPW('现在', null), VPW('要', null), VPW('花', null), VPW('一', null), VPW('天', '千', 'span'), VPW('的', null), VPW('时间', null)],
  ids: [0, 1, 2, 3, 4, 5, 6, 7],
  audio: '我现在要花1000的时间',
})
ok('音频读的是改之前那句（数字写法不同也算）→ 判定可以退回', vp1.ok === true, JSON.stringify(vp1))
ok('退回来是原话「要花一千的时间」，字数没变', vp1.ok && vp1.orig === '我现在要花一千的时间' && vp1.ids.length === 1 && vp1.ids[0] === 5, JSON.stringify(vp1))
const vp2 = vetoPlan({
  current: [VPW('大家用'), VPW('GPT', 'GDP', 'span'), VPW('用'), VPW('Claude'), VPW('用'), VPW('Codex'), VPW('这些工具')],
  ids: [0, 1, 2, 3, 4, 5, 6],
  audio: '大家用GDPCodexCodex这些工具',
})
ok('音频读得乱、和原话对不上 → 不退（不能拿一个烂窗口撤掉术语修正）', vp2.ok === false, JSON.stringify(vp2))
const vp3 = vetoPlan({ current: [VPW('甲'), VPW('乙', '乙'), VPW('丙')], ids: [0, 1, 2], audio: '甲乙丙' })
ok('这段没被改过 → 不适用否决', vp3.ok === false && /没被改过/.test(vp3.why), JSON.stringify(vp3))
const vp4 = vetoPlan({ current: [VPW('甲'), VPW('乙', '乙'), VPW('丙', '丁', 'relisten')], ids: [0, 1, 2], audio: '甲乙丙' })
ok('改字是听音复核定的 → 不许用否决把它翻回去', vp4.ok === false, JSON.stringify(vp4))
const vp5 = vetoPlan({ current: [VPW('甲'), VPW('乙', '乙丙'), VPW('丁')], ids: [0, 1, 2], audio: '甲乙丙丁' })
ok('退回来会改字数 → 不退（时间码会跟着动）', vp5.ok === false && /改字数/.test(vp5.why), JSON.stringify(vp5))
// 真实形态：medium 三个窗口都漏听了一个「要」——差一个字是读数噪声，不是「退不回」
const qianCur = [VPW('我'), VPW('现在'), VPW('要'), VPW('花'), VPW('一'), VPW('天', '千', 'span'), VPW('的'), VPW('时间')]
const QIDS = [0, 1, 2, 3, 4, 5, 6, 7]
const vp6 = vetoPlan({ current: qianCur, ids: QIDS, audio: '我现在花1000的时间' })
ok('音频漏听一个字（要）仍能判定否决', vp6.ok === true, JSON.stringify(vp6))
const vp7 = vetoPlan({ current: qianCur, ids: QIDS, audio: '我现在要花一天的时间' })
ok('音频读的就是我们改成的「天」→ 不否决（不能拿它给自己的改动背书）', vp7.ok === false, JSON.stringify(vp7))
const vp8 = vetoPlan({ current: qianCur, ids: QIDS, audio: '我现在要花一千的时间' })
ok('汉字写法的原话也能判', vp8.ok === true, JSON.stringify(vp8))
ok('差一个字以上就不认这条读数', vetoPlan({ current: qianCur, ids: QIDS, audio: '现在花1000时间' }).ok === false)
ok('nearEqual：差一个字 true，差得多 false', nearEqual('我现在要花一千的时间', '我现在花一千的时间') === true && nearEqual('我现在要花一千的时间', '我现在花一千') === false)

const total = pass + fails.length
if (fails.length) {
  console.log('FAIL · ' + fails.length + '/' + total + ' 条没过')
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('PASS · ' + total + ' 条全过（术语表 5 / 低置信 1 / 校验器 9 / 数字 3 / 上限 1 / 主入口 6 / 句式 2 / 热词 2 / 跨词 6 / 近音 5 / 整句 8 / 证据词条 2 / 拉丁 5 / 双模型 4 / 听音闸门 4' + (py ? ' / 拼音 4 / 只差一个元音 7' : '') + '）')
}
