/**
 * 语义层与段落标题的离线检查：不联网、不调模型、不碰仓库里的术语表。
 * 这里验的是「模型说的话能不能被采信」，模型本身的质量靠真素材跑片看。
 */
import { checkTitle, validateBatch, TITLE } from '../src/section-titles.mjs'
import { groundIssues, verifyHomophones, judgeSemantic, confirmsReading, adjudicateByAudio, KINDS, SEMANTIC, semanticBudget, reviewText } from '../src/qa-semantic.mjs'
import { sectionsOf, applyTitles } from '../src/sections.mjs'
import { mergeSections } from '../src/chapters.mjs'

let pass = 0
const fails = []
function ok(cond, name, extra = '') {
  if (cond) { pass++; return }
  fails.push(name + (extra ? ' — ' + extra : ''))
}
const P = () => { console.log(''); }

// ── 1. 段落标题：长度门 ──
const sec = { index: 1, start: 0, end: 8, text: '观众三秒就划走了', lines: ['观众三秒就划走了'] }
ok(checkTitle('三秒划走', sec, { maxChars: 12 }).ok, '标题：6 字以内且字字来自原文 → 过', checkTitle('三秒划走', sec).why)
ok(!checkTitle('三秒', sec, { maxChars: 12 }).ok, '标题：少于 4 字 → 不过')
ok(!checkTitle('观众三秒就划走了而已啊', sec, { maxChars: 12 }).ok, '标题：超过硬上限 → 不过')
ok(!checkTitle('观众三秒就划走了啊', sec, { maxChars: 8 }).ok, '标题：超过这段字数预算 → 不过')

// ── 2. 段落标题：接地门（模型最爱编的那几种）──
const sec2 = { index: 2, start: 8, end: 16, text: '内容生产效率翻倍', lines: ['内容生产效率翻倍'] }
ok(!checkTitle('效率提升百分之九十', sec2, { maxChars: 12 }).ok, '标题：编原文没有的数字 → 不过')
ok(checkTitle('内容效率翻倍', sec2, { maxChars: 12 }).ok, '标题：重组原文里的字 → 过', checkTitle('内容效率翻倍', sec2).why)
const sec3 = { index: 3, start: 16, end: 24, text: '这件事很难', lines: ['这件事很难'] }
ok(!checkTitle('小红书爆款方法论', sec3, { maxChars: 16 }).ok, '标题：整句都不是原文的字 → 不过')

// ── 2.5 半句话结尾不许上屏（实测模型常给的形态）──
const sec4 = { index: 4, start: 24, end: 32, text: '都能做出你想要的工具', lines: ['都能做出你想要的工具'] }
ok(!checkTitle('都能做出你想要的', sec4, { maxChars: 12 }).ok, '标题：结尾是「的」→ 判为半句话')
ok(!checkTitle('东西都在这里了', { index: 5, text: '东西都在这里了', lines: ['东西都在这里了'] }, { maxChars: 12 }).ok, '标题：结尾是「了」→ 不过')
ok(checkTitle('做出你想要的工具', sec4, { maxChars: 12 }).ok, '标题：结尾落在实词上 → 过', checkTitle('做出你想要的工具', sec4).why)
const sec5 = { index: 6, start: 32, end: 40, text: '但是AI来做内容也很强', lines: ['但是AI来做内容也很强'] }
ok(!checkTitle('但是AI来做内容很强', sec5, { maxChars: 12 }).ok, '标题：以「但是」开头 → 不过')

// ── 3. applyTitles：只贴 ok 的，索引一一对应 ──
const base = [{ index: 1, text: '原句一' }, { index: 2, text: '原句二' }]
const applied = applyTitles(base, [{ index: 1, text: '模型标题', ok: true }, { index: 2, text: '没过校验', ok: false }])
ok(applied.sections.length === 2 && applied.applied === 1, 'applyTitles：段数不变，只贴通过的一条')
ok(applied.sections[0].text === '模型标题' && applied.sections[1].text === '原句二', 'applyTitles：没通过的那段保留原句')
ok(applyTitles(base, null).applied === 0, 'applyTitles：没给标题时原样返回')

// ── 3.5 真 bug 回归：validateBatch 的产物必须带 ok:true，否则一条标题都上不了屏 ──
const secsForBatch = [
  { index: 1, start: 0, end: 8, text: '观众三秒就划走了', lines: ['观众三秒就划走了'] },
  { index: 2, start: 8, end: 16, text: '这件事真的很难', lines: ['这件事真的很难'] },
]
const batch = validateBatch(secsForBatch, [{ index: 1, text: '三秒就划走' }, { index: 2, text: '根本没出现过的词' }], 12, new Set())
ok(batch[0].ok === true && batch[0].source === 'model', 'validateBatch：通过的标题带 ok:true')
ok(batch[1].ok === false && batch[1].source === 'rules', 'validateBatch：打回的标题带 ok:false')
const landed = applyTitles(secsForBatch, batch)
ok(landed.applied === 1 && landed.sections[0].text === '三秒就划走', '回归：validateBatch 的产物真的贴上了 scene')
ok(landed.sections[1].text === '这件事真的很难', '回归：打回的那段保留原句')

// ── 4. 段落推导只有一条路：剪辑和包装算出的是同一批 ──
const plan = { keep: [[0, 20]], options: { speed: 1 } }
const segments = [
  { start: 0, end: 5, text: '第一句。' }, { start: 5, end: 10, text: '第二句。' },
  { start: 10, end: 15, text: '第三句。' }, { start: 15, end: 20, text: '第四句。' },
]
const s1 = sectionsOf({ segments, plan })
const s2 = mergeSections((await import('../src/sections.mjs')).sentencesOf({ segments, plan }))
ok(JSON.stringify(s1) === JSON.stringify(s2), '段落推导：sectionsOf 与 sentencesOf+mergeSections 结果一致')
ok(s1.every((s, i) => s.index === i + 1), '段落推导：索引从 1 连续')

// ── 5. 接地门：模型编的引用不采信 ──
const cards = [{ text: '观众三秒就画走了' }, { text: '这件事真的很难' }]
const sections = [{ index: 1, text: '观众三秒就画走了', lines: ['观众三秒就画走了'] }]
const g1 = groundIssues({ issues: [
  { kind: 'homophone', quote: '画走', to: '划走', why: '同音错' },
  { kind: 'semantic', quote: '这句根本没出现过', why: '编的' },
  { kind: 'unknown', quote: '很难', why: '类别不对' },
  { kind: 'repeat', quote: '难', why: '太短' },
], cards, sections })
ok(g1.kept.length === 1 && g1.kept[0].kind === 'homophone', '接地：只有逐字存在的引用被采信', JSON.stringify(g1.dropped.map(d => d.why)))
ok(g1.dropped.length === 3, '接地：编的/类别不对/太短的都丢掉')
ok(g1.kept[0].groundedIn === 'caption', '接地：标出来自字幕卡')
ok(Object.keys(KINDS).length === 4, '接地：只认四类问题')

// ── 6. 同音错必须过硬校验，验不过只算疑似 ──
const words = [
  { w: '观众', start: 0, end: 0.4 }, { w: '三秒', start: 0.4, end: 0.9 },
  { w: '就', start: 0.9, end: 1.1 }, { w: '画走', start: 1.1, end: 1.6 }, { w: '了', start: 1.6, end: 1.9 },
]
const acceptAll = async () => ({ accepted: [{ i: 3, to: '划走', verified: '拼音 huazou 一致' }], rejected: [], pinyinMode: 'on' })
const rejectAll = async (p) => ({ accepted: [], rejected: [{ i: p[0].i, from: '画走', to: p[0].to, why: '不同音：huazou vs huazou2' }], pinyinMode: 'on' })
const h1 = await verifyHomophones({ issues: [{ kind: 'homophone', quote: '画走', to: '划走', why: 'x', severity: 'block' }], words, validateFn: acceptAll })
ok(h1[0].severity === 'block' && h1[0].fix, '同音：校验通过 → 拦得住')
const h2 = await verifyHomophones({ issues: [{ kind: 'homophone', quote: '画走', to: '划走', why: 'x', severity: 'block' }], words, validateFn: rejectAll })
ok(h2[0].severity === 'warn', '同音：校验不过 → 降级成疑似，不判不通过')
const h3 = await verifyHomophones({ issues: [{ kind: 'homophone', quote: '就画走', to: '就划走', why: 'x', severity: 'block' }], words, validateFn: acceptAll })
ok(h3[0].severity === 'warn', '同音：跨了多个词 → 只报不改')
const h4 = await verifyHomophones({ issues: [{ kind: 'homophone', quote: '画走', to: '划走了', why: 'x', severity: 'block' }], words, validateFn: acceptAll })
ok(h4[0].severity === 'warn', '同音：改法字数变了 → 只报不改')
const h5 = await verifyHomophones({ issues: [{ kind: 'semantic', quote: '就画走', why: 'x', severity: 'block' }], words })
ok(h5[0].severity === 'block', '同音：非同类问题原样透传')

// ── 7. 语义层没跑不许算通过（这是用户定的规矩）──
ok(!judgeSemantic(null).ok, '判定：语义层没跑 → 不通过')
ok(!judgeSemantic({ ok: false, skipped: 'timeout' }).ok, '判定：模型超时 → 不通过')
ok(!judgeSemantic({ ok: false, skipped: 'cap-count-mismatch', detail: 'checkedCaps=3 / cards=26' }).ok, '判定：模型没看全 → 不通过')
ok(!judgeSemantic({ ok: true, issues: [{ severity: 'block', kindLabel: '同音错字', quote: '画走', to: '划走', at: 1.2 }] }).ok, '判定：报出拦得住的问题 → 不通过')
ok(judgeSemantic({ ok: true, issues: [{ severity: 'warn', kindLabel: '同音错字', quote: '画走', why: '疑似' }] }).ok, '判定：只有疑似 → 通过（疑似不进拦截面）')
const jd = judgeSemantic({ ok: true, issues: [{ severity: 'block', kindLabel: '同音错字', quote: '画走', to: '划走', at: 1.2 }] })
ok(jd.detail.includes('画走') && jd.detail.includes('划走'), '判定：失败说明里带具体词，不写「有问题」了事')

// ── 7.5 读全性：只看条数不够，首尾卡开头也要对得上 ──
const rc = [{ text: '观众三秒就画走了' }, { text: '这件事真的很难' }, { text: '内容红利窗口来了' }]
ok(confirmsReading({ checkedCaps: 3, firstQuote: '观众三秒', lastQuote: '内容红利' }, rc).ok, '读全：条数 + 首尾开头都对 → 采信')
ok(!confirmsReading({ checkedCaps: 2, firstQuote: '观众三秒', lastQuote: '内容红利' }, rc).ok, '读全：条数不对 → 不采信')
ok(!confirmsReading({ checkedCaps: 3, lastQuote: '内容红利' }, rc).ok, '读全：没有首卡证据 → 不采信')
ok(!confirmsReading({ checkedCaps: 3, firstQuote: '完全另一句', lastQuote: '内容红利' }, rc).ok, '读全：首卡开头对不上 → 不采信')

// ── 7b. 语义审读的输出预算按卡数给（自测19：24 张卡 2600 token 又被截断，整层没查成）──
ok(semanticBudget(Array.from({ length: 24 }, () => ({}))) >= 24 * 100, '语义预算：24 张卡时够写满 8 条问题')
ok(semanticBudget([]) === SEMANTIC.maxTokens, '语义预算：没有卡时退回下限，不会给 0')
ok(semanticBudget(Array.from({ length: 500 }, () => ({}))) === SEMANTIC.tokensCap, '语义预算：有上限，卡再多也不会把预算开到天边')
ok(SEMANTIC.retryFactor > 1, '语义预算：截断后要能抬一档重试')

// ── 8. 门槛常量不许被随手改小 ──
ok(TITLE.minChars === 4 && TITLE.maxChars === 12 && TITLE.hardMax === 16, '门槛：标题长度常量在位')
ok(TITLE.groundRatio >= 0.8, '门槛：接地比例不得低于 80%')


// ── 9. 听音复核仲裁：没验过的建议不许拦交付 ──
// 自测22 实测：4 条语义建议、仲裁上限 2 处，第 3 条直接原样留着 block——
// 于是「要…就能…句式杂糅」这种语气建议成了拦交付的理由，而它一次音频都没对过。
{
  const issue = { kind: 'semantic', quote: '我现在要花一天的时间就能做出', to: '我现在花一天时间就能做出', why: '句式杂糅', severity: 'block' }
  // 仲裁一进门就短路的情况（没素材 / 没词）保持原样，这条另有断言在 check-qa 里；
  // 这里要验的是「有素材、但这一条轮不到验证」——cap 用完和定位不到都算没验。
  const words1 = [{ w: '我', start: 0, end: 0.2 }]
  const c0 = await adjudicateByAudio({ issues: [issue], words: words1, media: 'x.mp4', cap: 0 })
  ok(c0[0].severity === 'warn', '仲裁 · 次数用完的建议降级为疑似，不许拦交付', c0[0].severity)
  ok(/没轮到验证/.test(c0[0].why || ''), '仲裁 · 理由说清是没轮到验', c0[0].why)
  const noHit = await adjudicateByAudio({ issues: [issue], words: words1, media: 'x.mp4', cap: 2 })
  ok(noHit[0].severity === 'warn', '仲裁 · 定位不到原话的建议也不许拦交付', noHit[0].severity)
  const done = await adjudicateByAudio({ issues: [{ ...issue, severity: 'warn' }], words: words1, media: 'x.mp4', cap: 2 })
  ok(done[0].severity === 'warn', '仲裁 · 已经降级的原样留着', done[0].severity)
}


// ── 模型回了个空 JSON：换一个采样重问一次，别把空回答当成「查过了、没问题」（自测25） ──
// 真素材上连跑两次质检都报「没给 checkedCaps，模型返回空」：空回答会被缓存，不换采样就一直是空的。
const scards = { cards: [{ start: 0, text: '今天说个事' }, { start: 2, text: '内容红利来了' }] }
const goodAns = { ok: true, ms: 1, model: 'fake', content: '{"checkedCaps":2}', value: { checkedCaps: 2, firstQuote: '今天说个', lastQuote: '内容红利', verdict: 'ok', issues: [] } }
const emptyAns = { ok: true, ms: 1, model: 'fake', content: '', value: {} }
let calls1 = 0
const retry = await reviewText({ captions: scards, brief: { platform: '抖音', duration: 60 }, propose: async () => { calls1++; return calls1 === 1 ? emptyAns : goodAns } })
ok('第一次回空 → 换采样重问一次就采信', retry.ok === true && calls1 === 2, JSON.stringify({ ok: retry.ok, calls: calls1, skipped: retry.skipped }))
let calls2 = 0
const twice = await reviewText({ captions: scards, brief: { platform: '抖音', duration: 60 }, propose: async () => { calls2++; return emptyAns } })
ok('两次都回空 → 判不通过，不装作查过了', twice.ok === false && twice.skipped === 'reading-unverified' && calls2 === 2, JSON.stringify({ ok: twice.ok, skipped: twice.skipped, calls: calls2 }))
ok('两次回空时，两次的原因都写进 detail（能查）', /没给 checkedCaps/.test(String(twice.detail || '')) && /重问一次/.test(String(twice.detail || '')), String(twice.detail).slice(0, 120))
let calls3 = 0
const direct = await reviewText({ captions: scards, brief: { platform: '抖音', duration: 60 }, propose: async () => { calls3++; return goodAns } })
ok('第一次就读全 → 不多问一次（不白花 token）', direct.ok === true && calls3 === 1, JSON.stringify({ ok: direct.ok, calls: calls3 }))

console.log(fails.length ? 'FAIL ' + fails.length + ' / ' + (pass + fails.length) : 'PASS ' + pass)
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exit(1) }
