/**
 * 错字治理的自检：术语表、模型提案的校验器、句子回流、硬断言。
 * 模型提案用固定样本喂进来，不联网；拼音校验在本机有 uv 时额外验一遍。
 */
import { applyTerms, applyToSegments, validate, validateSpans, sentenceView, correct, hotwordPrompt, pinyinOf, loadTerms, LEN_NUDGE } from '../src/asr-fix.mjs'

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

const total = pass + fails.length
if (fails.length) {
  console.log('FAIL · ' + fails.length + '/' + total + ' 条没过')
  for (const f of fails) console.log('  · ' + f)
  process.exitCode = 1
} else {
  console.log('PASS · ' + total + ' 条全过（术语表 5 / 低置信 1 / 校验器 9 / 数字 3 / 上限 1 / 主入口 6 / 句式 2 / 热词 2 / 跨词 6 / 近音 5 / 整句 8 / 证据词条 2 / 拉丁 5 / 双模型 4' + (py ? ' / 拼音 4' : '') + '）')
}
