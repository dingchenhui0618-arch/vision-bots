/**
 * 选句删（内容预算）的规则：哪几句永远不许删、删完落在哪、删不出来怎么报。
 * 纯逻辑：不联网、不解码、不调模型（propose 是注入口）。
 *
 * 这一层要守住的是一条底线：**目标时长不是装饰**。用户说 60 秒，就得到 60 秒附近；
 * 到不了要说出「差几秒、为什么」，不许悄悄交一条 66.5 秒的片子还说达标。
 */
import { buildPlan } from '../src/plan.mjs'
import { planPrune, buildSentences, hardRefuse, chooseSubset, similarity, isDup, outroStart, reasonFits, fragmentFlags, DEFAULT_PRUNE, verdictsOf } from '../src/prune.mjs'
import { proposalKey } from '../src/proposal-cache.mjs'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }

/** 造一段词流：每行一句，字 0.18s，句间 0.6s 停顿。 */
function corpus(lines, { charSec = 0.2 } = {}) {
  const words = [], segments = []
  let t = 0
  for (const line of lines) {
    const start = t
    for (const ch of line) {
      words.push({ i: words.length, w: ch, start: t, end: t + charSec * 0.9 })
      t += charSec
    }
    segments.push({ start, end: t - 0.02, text: line })
    t += 0.6
  }
  return { words, segments, duration: t }
}

// ── 分句：只分「成片还留着的词」，被删掉的不算 ──
const c1 = corpus(['今天说个事', '我最近研究了一圈', '真正的机会在这里'])
const s1 = buildSentences({ segments: c1.segments, words: c1.words })
ok('三行 → 三句', s1.length === 3 && s1[0].idx === 0 && s1[2].idx === 2, JSON.stringify(s1.map(s => s.text)))
ok('句子文本逐字还原', s1[1].text === '我最近研究了一圈', s1[1].text)
const delAll = new Set(c1.words.filter(w => w.start >= c1.segments[1].start).map(w => w.i))
const s2 = buildSentences({ segments: c1.segments, words: c1.words, deleted: delAll })
ok('整句已经被删掉 → 不再出现在候选里', s2.length === 1, JSON.stringify(s2.map(s => s.text)))
const delHalf = new Set(c1.words.filter(w => w.w === '研').map(w => w.i))
const s3 = buildSentences({ segments: c1.segments, words: c1.words, deleted: delHalf })
ok('句内删了几个词 → 句子仍在，标记为部分删', s3.length === 3 && s3[1].partial === true, JSON.stringify(s3[1]))

// ── 谁永远不许删：每条都能对着原话指出来 ──
const c2 = corpus([
  '今天说个事',            // 0 钩子
  '我最近研究了一圈',      // 1 普通铺垫（可删）
  '真正的机会是在OPC',     // 2 主张
  '只有别人看到你',        // 3 从句起头
  '但是真正赚钱的有几个',  // 4 连接词起头（也含真正，双重挡）
  '这个月涨了3倍',         // 5 唯一数字
  '大家用Claude写东西',    // 6 唯一术语
  '我是杨团长',            // 7 落点区
  '我们可以聊一聊',        // 8 落点
])
const s4 = buildSentences({ segments: c2.segments, words: c2.words })
const ctx = { params: DEFAULT_PRUNE, terms: ['Claude'] }
const why = i => hardRefuse(s4[i], s4, ctx)
ok('第一句是钩子 → 不许删', /钩子/.test(why(0) || ''), why(0))
ok('最后两句是落点 → 不许删', /落点/.test(why(8) || ''), why(8))
// 主张句不再硬拦：它是**判断**，由模型提出、由 reasonFits 核对理由后降档；
// 规则只拦机械性破坏（自测16 实测：硬拦主张句会把候选池压到 4/29，一条都删不掉，片子还是 66 秒）
ok('主张句 → 规则不硬拦（交给模型提案 + 理由核对）', why(2) === null, why(2))
ok('从句起头（只有…）→ 不许删', /起头/.test(why(3) || ''), why(3))
const c2b = corpus(['开场一句', '这句是铺垫', '但是真正赚钱的有几个', '收尾一句'])
const s2b = buildSentences({ segments: c2b.segments, words: c2b.words })
ok('下一句以「但是」开头 → 删了悬空，不许删', /悬空/.test(hardRefuse(s2b[1], s2b, ctx) || ''), hardRefuse(s2b[1], s2b, ctx))
ok('唯一的数字（3倍）→ 不许删', /3/.test(why(5) || ''), why(5))
ok('唯一的术语（Claude）→ 不许删', /Claude/.test(why(6) || ''), why(6))
ok('普通铺垫句 → 可以删', why(1) === null, why(1))
ok('这句的重复副本已经删过一遍 → 不许再删（否则整句没了）',
  /重复副本/.test(hardRefuse(s4[1], s4, { ...ctx, deletedRepeat: new Set(['我最近研究了一圈']) }) || ''),
  hardRefuse(s4[1], s4, { ...ctx, deletedRepeat: new Set(['我最近研究了一圈']) }))

// 结果句：「只有别人看到你 / 你才有机会出圈」——删了后果那句，前一句就挂空
const c5 = corpus(['开场一句', '只有别人看到你', '你才有机会出圈', '真正的结论在这里', '收尾一句'])
const s5 = buildSentences({ segments: c5.segments, words: c5.words })
ok('结果句（你才…）→ 不许删', /接上句/.test(hardRefuse(s5[2], s5, ctx) || ''), hardRefuse(s5[2], s5, ctx))

// 自我介绍之后都是落点
const c6 = corpus(['开场一句', '中间这句可以删', '我是杨团长', '现在专注在做内容生产力', '我们可以聊一聊'])
const s6 = buildSentences({ segments: c6.segments, words: c6.words })
ok('自我介绍在第 2 句 → 之后都算落点', outroStart(s6) === 2, String(outroStart(s6)))
ok('自我介绍之后那句 → 不许删（哪怕它是可删的铺垫）', /落点/.test(hardRefuse(s6[3], s6, { ...ctx, outroFrom: outroStart(s6) }) || ''), hardRefuse(s6[3], s6, { ...ctx, outroFrom: outroStart(s6) }))

// ── 重复句 ──
ok('同一句说两遍 → 相似度 1', similarity('但是AI来去做内容', '但是AI来去做内容') === 1)
ok('多一个尾字 → 仍算重复（≥0.82）', similarity('但是AI来去做内容', '但是AI来去做内容的了') >= 0.82, String(similarity('但是AI来去做内容', '但是AI来去做内容的了')))
// 中间少一个字会把最长公共子串砍成两半——这是这条口径的已知边界，写下来别当它完美
ok('中间少一个字 → 落在这条口径之外（所以重复句主要靠 plan.mjs 的相邻重复规则兜）', similarity('但是AI来去做内容', '但是AI来做内容') < 0.82, String(similarity('但是AI来去做内容', '但是AI来做内容')))
ok('不相干的两句 → 不算重复', similarity('今天说个事', '真正的机会在内容') < 0.82)
// 实测踩过：短句被长句整句包住，相似度算出来 0.83，被当成重复、差点删掉落点
ok('短句被长句包住 → 相似度高但不算重复（长度比守门）',
  similarity('卷内容生产力', '现在专注在做OPC的内容生产力') >= 0.82 && isDup('卷内容生产力', '现在专注在做OPC的内容生产力') === false,
  String(similarity('卷内容生产力', '现在专注在做OPC的内容生产力')))
ok('同样长短、真说两遍 → 算重复', isDup('但是AI来去做内容', '但是AI来去做内容') === true)

// ── 子集选择：离目标最近，且守硬约束 ──
const mk = (n, dur) => Array.from({ length: n }, (_, i) => ({ idx: i, start: i * (dur + 0.6), dur, bare: '句子' + i, text: '句子' + i, i0: i * 4, i1: i * 4 + 3 }))
const many = mk(20, 2)
const b1 = chooseSubset({ candidates: [1, 3, 5, 7].map(i => many[i]), sentences: many, current: 66, target: 60 })
ok('66s / 目标 60s → 挑 3 句 2s 的，正好 60s', b1 && b1.picked.length === 3 && Math.abs(b1.after - 60) < 0.01, JSON.stringify(b1 && { n: b1.picked.length, after: b1.after }))
const b2 = chooseSubset({ candidates: [2, 3, 4].map(i => many[i]), sentences: many, current: 66, target: 60 })
ok('只有连着的三句可删 → 不许连删三句，退成两句', b2 && b2.picked.length === 2, JSON.stringify(b2 && { n: b2.picked.length, after: b2.after }))
const b3 = chooseSubset({ candidates: [1, 2].map(i => many[i]), sentences: many, current: 66, target: 60 })
ok('只能删出 62s 或 64s → 挑更近的 62s，且不许低于目标 3%', b3 && b3.after >= 58.2 && b3.after === 62, JSON.stringify(b3 && { after: b3.after }))
const b4 = chooseSubset({ candidates: [1, 3, 5, 7].map(i => many[i]), sentences: many, current: 61, target: 60 })
ok('只差 1s → 挑一句就够，不许多删', b4 && b4.picked.length === 1, JSON.stringify(b4 && b4.picked.length))

// 连两个「但是」：删掉中间那句就会连着说两个但是，这种子集必须被否掉
const cc = corpus(['开场一句', '但是先说个事', '中间这句可以删', '但是真正赚钱的有几个', '收尾一句', '最后一句'])
const cs = buildSentences({ segments: cc.segments, words: cc.words })
const adjPick = chooseSubset({ candidates: [cs[2]], sentences: cs, current: 62, target: 60 })
ok('删掉之后会连着两个「但是」→ 不许删', adjPick === null, JSON.stringify(adjPick && adjPick.picked))

// ── 接进 buildPlan：整句删真删掉词，时间码一个字不动 ──
const c3 = corpus(['今天说个事', '我最近研究了一圈', '真正的机会在这里', '收尾一句'])
const base = buildPlan(c3.words, c3.duration, {})
const mid = buildSentences({ segments: c3.segments, words: c3.words })[1]
const cut = buildPlan(c3.words, c3.duration, { ranges: [{ i0: mid.i0, i1: mid.i1, reason: 'content', text: mid.text }] })
ok('整句删 → 成片变短', cut.outDuration < base.outDuration - 0.5, base.outDuration.toFixed(2) + ' → ' + cut.outDuration.toFixed(2))
ok('整句删记在删除表里，理由可读', cut.byReason.content === 1 && cut.deletions.some(d => d.reason === 'content' && d.text === mid.text), JSON.stringify(cut.deletions))
ok('删除表带归一化词下标（下一轮还要用它）', Number.isInteger(cut.deletions[0].i0) && Number.isInteger(cut.deletions[0].i1), JSON.stringify(cut.deletions[0]))
let threw = null
try { buildPlan(c3.words, c3.duration, { ranges: [{ i0: 3, i1: 9999 }] }) } catch (e) { threw = e.message }
ok('区间越界 → 报错，不静默跳过', /不合法/.test(threw || ''), String(threw))

// ── planPrune：模型提案 + 规则定生死 ──
const c4 = corpus([
  '今天说个事',
  '我最近研究了一圈',
  '真正的机会在内容',
  '就是说用AI做工具',
  '别再去卷技术了',
  '收尾一句',
])
const plan0 = buildPlan(c4.words, c4.duration, {})
const fake = (cuts) => async () => ({ ok: true, value: { cut: cuts }, model: 'fake', ms: 1, tokens: 1 })
const P = async (opts) => planPrune({ segments: c4.segments, plan: plan0, ...opts, words: opts.words || c4.words })

const noTarget = await P({ target: 0, propose: fake([]) })
ok('没有目标时长 → 不动内容', noTarget.skipped === 'no-target' && noTarget.picks.length === 0, JSON.stringify(noTarget.skipped))

const fit = await P({ target: plan0.outDuration * 2, propose: fake([]) })
ok('已经比目标短 → 不动内容', fit.skipped === 'already-fit' && fit.picks.length === 0, JSON.stringify(fit.skipped))

const rIdx = await P({ target: 0.5, propose: fake([{ index: 999, why: '瞎给' }, { index: -1, why: '瞎给' }]) })
ok('模型给的句号全是假的 → 一条都不采纳，改用确定性兜底', rIdx.picks.every(p => p.idx >= 0 && p.idx < 6 && p.source === 'rules'), JSON.stringify(rIdx.picks.map(p => [p.idx, p.source])))

const rProt = await P({ target: 0.5, propose: fake([{ index: 0, why: '钩子' }, { index: 2, why: '主张' }, { index: 1, why: '铺垫' }]) })
ok('模型想删钩子/主张 → 被规则挡住，只落地可删的那句', rProt.picks.length === 1 && rProt.picks[0].idx === 1, JSON.stringify(rProt.picks.map(p => p.text)))
ok('被挡住的提案照实记下来（模型提了什么、哪条规则打回）', rProt.refused.some(r => r.idx === 0 && r.byModel), JSON.stringify(rProt.refused.slice(0, 3)))

const rDown = await P({ target: 0.5, propose: async () => ({ ok: false, skipped: 'timeout' }) })
// 删内容是编辑判断：模型没接上就不删，如实报差额——不拿「价值排序」硬凑时长
// （离线试跑里硬删挑中的正好是全片论点「知道的人会做的人太少了」）
ok('模型挂了 → 一句内容都不删，宁可报差额', rDown.ok === true && rDown.model.skipped === 'timeout' && rDown.picks.length === 0, JSON.stringify({ model: rDown.model, picks: rDown.picks.length }))

const rGive = await P({ target: 0.4, propose: fake([{ index: 1, why: '铺垫' }]) })
ok('差得太远、只有一句可删 → 如实报「不够」并标 exhausted', rGive.hit === false && rGive.exhausted === true, JSON.stringify({ hit: rGive.hit, exhausted: rGive.exhausted, after: rGive.after }))
ok('删出来的每一句都有理由', rGive.picks.every(p => p.why && p.source), JSON.stringify(rGive.picks))

// 两轮提案：第一轮没挑够（或挑的全被挡住），第二轮只在规则允许的句子里再挑一次
let calls = 0
const twoRound = await P({
  target: 0.5,
  propose: async (list, note) => {
    calls++
    if (calls === 1) return { ok: true, value: { cut: [{ index: 0, why: '钩子' }] }, model: 'fake', ms: 1, tokens: 1 }
    return { ok: true, value: { cut: [{ index: 1, why: '铺垫' }, { index: 3, why: '过渡' }] }, model: 'fake', ms: 1, tokens: 1 }
  },
})
ok('第一轮挑的句子被规则挡住 → 会带着驳回理由再问一轮', twoRound.model.rounds === 2 && calls === 2, JSON.stringify({ rounds: twoRound.model.rounds, calls }))
ok('第二轮落地的是规则允许的那几句', twoRound.picks.length > 0 && twoRound.picks.every(p => p.idx !== 0), JSON.stringify(twoRound.picks.map(p => p.idx)))
ok('被挡住的提案留在 refused 里，理由可查', twoRound.refused.some(r => r.idx === 0 && r.byModel), JSON.stringify(twoRound.refused.filter(r => r.byModel)))

// 真跑时踩过的坑：cut handler 传进来的是**原始词表**（没有 i 字段），
// 分句时不归一化就会给出 undefined 下标，片子剪完倒在最后一步（自测16 第 1 次真跑）
const rawWords = c4.words.map(w => ({ w: w.w, start: w.start, end: w.end }))
const rRaw = await P({
  target: 0.4,
  propose: fake([{ index: 1, why: '铺垫' }]),
  words: rawWords,
})
ok('传原始词表（无 i 字段）→ picks 里仍然有合法词下标', rRaw.picks.length > 0 && rRaw.picks.every(p => Number.isInteger(p.i0) && Number.isInteger(p.i1)), JSON.stringify(rRaw.picks.map(p => [p.i0, p.i1])))

// 区间必须能真的喂回 buildPlan（ids 对得上），否则「说要删、其实没删」
const rebuild = buildPlan(c4.words, c4.duration, { ranges: rGive.picks.map(p => ({ i0: p.i0, i1: p.i1, reason: 'content', text: p.text })) })
ok('选出来的区间喂回 buildPlan → 真的变短了', rebuild.byReason.content >= 1, JSON.stringify(rebuild.byReason))
// 理由必须对得上句子
ok('模型说「口头过渡」，但这句是钩子/观点 → 降档，不当强证据',
  reasonFits({ bare: '但是我今天就要给大家泼一瓶冷水', idx: 2 }, '口头过渡', [{ bare: 'x', idx: 0 }]).ok === false,
  JSON.stringify(reasonFits({ bare: '但是我今天就要给大家泼一瓶冷水', idx: 2 }, '口头过渡', [{ bare: 'x', idx: 0 }])))
ok('模型说它是过渡，而这句确实以「就是说」起头 → 通过', reasonFits({ bare: '就是说用AI做工具', idx: 3 }, '铺垫', []).ok === true)
ok('模型说「重复」，前面确实说过一句一样的 → 通过', reasonFits({ bare: '但是AI来去做内容', idx: 4 }, '重复', [{ bare: '但是AI来去做内容', idx: 2 }]).ok === true)

// 碎片句：只能和前半句一起删
const c7 = corpus(['今天说个事', '大家在看满大街都是在做AI模型', '做AI工具的', '真正赚钱的有几个', '收尾一句'])
const s7 = buildSentences({ segments: c7.segments, words: c7.words })
const frags = fragmentFlags(s7)
ok('「做AI工具的」被认成碎片句（短 + 以「做」起头 + 上一句没有句末标点）', frags[2] === true && frags[1] === false, JSON.stringify(frags))
const pair1 = chooseSubset({ candidates: [s7[2]], sentences: s7, current: 62, target: 60, fragments: frags, params: { maxChars: 0.6, maxSentences: 0.5 } })
ok('只删碎片、留下它的前半句 → 不许', pair1 === null, JSON.stringify(pair1 && pair1.picked))
const loose = { maxChars: 0.6, maxSentences: 0.5 }
const pair2 = chooseSubset({ candidates: [s7[1], s7[2]], sentences: s7, current: 63, target: 60, fragments: frags, params: loose })
ok('碎片和前半句一起删 → 允许', pair2 && pair2.picked.length === 2, JSON.stringify(pair2 && pair2.picked))
const pair3 = chooseSubset({ candidates: [s7[1]], sentences: s7, current: 62, target: 60, fragments: frags, params: { maxChars: 0.6, maxSentences: 0.5 } })
ok('只删前半句、把碎片吊在空中 → 不许', pair3 === null, JSON.stringify(pair3 && pair3.picked))

// ── 自测24：逐句表态 + 多数票（判读本身在摇，一次判读不能当结论）──
// 真跑实测：同一份输入、同一个模型、温度 0，自由挑句五次两两重合 0.69（最低 0.33）；
// 逐句判读三次重合 0.85（最低 0.78）。所以默认问法改成逐句，并要求多数票才许删。
const cV = corpus([
  '今天说个事',
  '我最近研究了一圈',
  '真正的机会是在OPC',
  '就是说用AI来做工具',
  '大家用Claude写东西',
  '我是杨团长',
  '我们可以聊一聊',
])
const planV = buildPlan(cV.words, cV.duration, {})
const sV0 = buildSentences({ segments: cV.segments, words: cV.words })
const durOf = (txt) => sV0.find(s => s.bare.includes(txt)).dur
// 目标设成「正好差这一句的时长」，否则删多了会被 chooseSubset 判成删过头（那是另一条规则）
const voteP = async (batches, extra = {}) => planPrune({ segments: cV.segments, words: cV.words, plan: planV, target: planV.outDuration - durOf('研究'), params: { samples: 3, minVotes: 2 }, propose: async () => batches, ...extra })
const verdict = (rows) => ({ ok: true, value: { 每句: rows }, model: 'fake', ms: 1, tokens: 1 })
const sV = buildSentences({ segments: cV.segments, words: cV.words })
const idxOf = (txt) => sV.find(s => s.bare.includes(txt)).idx

// 三票里一票说可删 → 不够票，不许删
const oneVote = await voteP([
  verdict([{ index: idxOf('研究'), cut: true, why: '口头过渡' }, { index: idxOf('大家用Claude'), cut: false, why: '工具' }]),
  verdict([{ index: idxOf('研究'), cut: false, why: '观点' }, { index: idxOf('大家用Claude'), cut: false, why: '工具' }]),
  verdict([{ index: idxOf('研究'), cut: false, why: '观点' }, { index: idxOf('大家用Claude'), cut: false, why: '工具' }]),
])
ok('三票里只有一票说「能删」 → 这句不删（票数不够不是证据）', !oneVote.picks.some(p => p.idx === idxOf('研究')), JSON.stringify(oneVote.picks.map(p => [p.text, p.source])))
ok('票数不够的句子记进报告（哪几句在摇，可查）', oneVote.model.unstable.some(u => u.idx === idxOf('研究') && u.yes === 1 && u.no === 2), JSON.stringify(oneVote.model.unstable))
ok('三票都判「不能删」 → 一个都不删', oneVote.picks.length === 0, JSON.stringify(oneVote.picks.map(p => p.text)))
ok('报告写清问法、采了几次、几票算数', oneVote.model.mode === 'score' && oneVote.model.samples === 3 && oneVote.model.minVotes === 2, JSON.stringify({ mode: oneVote.model.mode, samples: oneVote.model.samples, minVotes: oneVote.model.minVotes }))

const twoVote = await voteP([
  verdict([{ index: idxOf('研究'), cut: true, why: '口头过渡' }]),
  verdict([{ index: idxOf('研究'), cut: true, why: '口头过渡' }]),
  verdict([{ index: idxOf('研究'), cut: false, why: '观点' }]),
])
ok('三票里两票说「能删」 → 删（多数票，不是全票）', twoVote.picks.some(p => p.idx === idxOf('研究') && p.source === 'model'), JSON.stringify(twoVote.picks.map(p => [p.text, p.source])))
ok('采纳的也带理由和票数（报告里对得上）', twoVote.model.votes.some(v => v.idx === idxOf('研究') && v.yes === 2 && v.no === 1), JSON.stringify(twoVote.model.votes))

// 「每句」和老的 cut 两种形状都解析；坏形状当没答，不猜
const vOf = verdictsOf
ok('逐句表态的形状能解析', vOf({ 每句: [{ index: 2, cut: true, why: '铺垫' }] }).length === 1 && vOf({ 每句: [{ index: 2, cut: true }] })[0].cut === true)
ok('老的 cut 形状仍能解析（对照用）', vOf({ cut: [{ index: 3, why: '过渡' }] })[0].index === 3)
ok('两种都不是 → 空，不猜', vOf({ 每句: 'x', cut: null }).length === 0 && vOf(null).length === 0)

// 缓存指纹：salt 只进指纹，不进提问
const keyA = proposalKey({ prompt: 'p', salt: '' })
const keyB = proposalKey({ prompt: 'p', salt: 'sample:1' })
ok('salt 让同一份提问各自缓存（多票各自命中，重跑不变）', keyA !== keyB && proposalKey({ prompt: 'p' }) === keyA)

// ── 自测24 抓到的真漏洞：话没说完的句子不许删 ──
const cD = corpus([
  '今天大家都在卷AI技术',
  '但是我今天就要给大家',
  '泼一瓶冷水',
  '真正的机会是在内容',
  '我们可以聊一聊',
])
const sD = buildSentences({ segments: cD.segments, words: cD.words })
const whyD = hardRefuse(sD[1], sD, { params: DEFAULT_PRUNE })
ok('开头的「转折 + 承诺」句是钩子 → 不许删（只护第一句不够）', /钩子/.test(whyD || ''), String(whyD))
// 同一种「话没说完」的形态放到片子中段（不受钩子规则保护），由悬空规则拦住
const cO = corpus([
  '今天大家都在卷AI技术',
  '真正的机会是在内容',
  '这个月的量涨了三倍',
  '然后我今天就要给大家',
  '泼一瓶冷水',
  '我们可以聊一聊',
])
const sO = buildSentences({ segments: cO.segments, words: cO.words })
const whyO = hardRefuse(sO[3], sO, { params: DEFAULT_PRUNE })
ok('以「给大家」收尾、后半句在下一句 → 不许删（话没说完）', /话没说完/.test(whyO || ''), String(whyO))
const cD2 = corpus(['今天说个事', '我最近研究了一圈', '真正的机会是在内容', '我们可以聊一聊'])
const sD2 = buildSentences({ segments: cD2.segments, words: cD2.words })
ok('普通口语句子（不以要宾语的词收尾）→ 不误拦', !/话没说完/.test(hardRefuse(sD2[1], sD2, { params: DEFAULT_PRUNE }) || ''), String(hardRefuse(sD2[1], sD2, { params: DEFAULT_PRUNE })))

// 降档通道不许动主张句：模型给的理由对不上（说主张句是「铺垫」），按老逻辑会降一档删掉
const cC = corpus(['今天说个事', '我最近研究了一圈', '内容生产力才是王道', '这个窗口还在', '我们可以聊一聊'])
const planC = buildPlan(cC.words, cC.duration, {})
const sC = buildSentences({ segments: cC.segments, words: cC.words })
const iClaim = sC.find(s => s.bare.includes('才是王道')).idx
const claimRun = await planPrune({
  segments: cC.segments, words: cC.words, plan: planC, target: planC.outDuration - sC[iClaim].dur,
  params: { samples: 3, minVotes: 2 },
  propose: async () => [
    { ok: true, value: { 每句: [{ index: iClaim, cut: true, why: '铺垫' }] }, model: 'fake', ms: 1 },
    { ok: true, value: { 每句: [{ index: iClaim, cut: true, why: '铺垫' }] }, model: 'fake', ms: 1 },
    { ok: true, value: { 每句: [{ index: iClaim, cut: true, why: '铺垫' }] }, model: 'fake', ms: 1 },
  ],
})
ok('主张句 + 理由对不上 → 连降档都不给（删掉的常是论点）', claimRun.picks.length === 0, JSON.stringify(claimRun.picks.map(p => [p.text, p.source])))
ok('被挡的那条留在 rejectedByReason 里，理由可查', claimRun.rejectedByReason.some(r => r.idx === iClaim && /主张句/.test(r.why)), JSON.stringify(claimRun.rejectedByReason))


// ── 删除单元：模型的判读粒度本来就是「一段」，规则的核对粒度也得跟它对齐（自测25） ──
// 真实素材里模型对「大家在看这些满大街都是在做AI模型 / 做AI工具的」说了「铺垫」，规则按单句核，
// 两句都不像过渡句，于是这段唯一干净的 4.48 秒没删成，成片停在 64.9s（目标 60s，+8.2%）。
// 换的不是模型，是核对的单位：相邻、都够票的句子是一个删除单元，理由按这一段核。
const U_LINES = ['今天大家都在卷AI技术', '但是我今天就要给大家泼一瓶冷水', '大家在看这些满大街都是在做AI模型', '做AI工具的人特别多', '真正赚钱的又有几个人呢', '真正的机会是在内容', '我们可以聊一聊']
const F_LINES = ['今天大家都在卷AI技术', '但是我今天就要给大家泼一瓶冷水', '大家在看这些满大街都是在做AI模型', '做AI工具的', '但是真正赚钱的有几个呢', '真正的机会是在内容', '我们可以聊一聊']
const N_LINES = ['今天大家都在卷AI技术', '但是我今天就要给大家泼一瓶冷水', '大家在看这些满大街都是在做AI模型', '做AI工具的人特别多', '真正的机会是在内容', '我们可以聊一聊']
const U_PARAMS = { samples: 3, minVotes: 2, maxChars: 0.6, maxSentences: 0.5 }
const say = rows => Array.from({ length: 3 }, () => ({ ok: true, ms: 1, model: 'fake', value: { 每句: rows } }))
const mkCorpus = lines => { const c = corpus(lines); return { c, plan: buildPlan(c.words, c.duration, {}), s: buildSentences({ segments: c.segments, words: c.words }) } }
const A = mkCorpus(U_LINES), F = mkCorpus(F_LINES), N = mkCorpus(N_LINES)
const pairOf = x => x.s[2].dur + x.s[3].dur
const unitRun = await planPrune({ segments: A.c.segments, words: A.c.words, plan: A.plan, target: A.plan.outDuration - pairOf(A), params: U_PARAMS, propose: async () => say([{ index: 2, cut: true, why: '铺垫' }, { index: 3, cut: true, why: '铺垫' }, { index: 4, cut: false, why: '观点' }]) })
ok('两句连判可删 → 并成一个删除单元删掉（不是两句各删各的）',
  unitRun.picks.length === 2 && unitRun.units.length === 1 && unitRun.units[0].idx.join(',') === '2,3',
  JSON.stringify(unitRun.units))
ok('单元理由「铺垫」靠「后面紧接反问」核对通过（单句看不出铺垫）',
  unitRun.model.units.length === 1 && /铺垫/.test(unitRun.model.units[0].why) && /反问|转折/.test(unitRun.model.units[0].by || ''),
  JSON.stringify(unitRun.model.units))
ok('删掉这段就落进目标', unitRun.hit === true, unitRun.after + ' / ' + unitRun.target)
ok('单元删的票也记在 votes 里（几句、几票）', unitRun.model.votes.length === 2 && unitRun.model.votes.every(v => v.yes === 3), JSON.stringify(unitRun.model.votes))
ok('硬规则能找到解时不放开风格规则 → notes 空', unitRun.notes.length === 0, JSON.stringify(unitRun.notes))
// 「连说两句但是」是风格问题不是破坏：先按硬规则找解，找不到才放开，并写进报告
const softRun = await planPrune({ segments: F.c.segments, words: F.c.words, plan: F.plan, target: F.plan.outDuration - pairOf(F), params: U_PARAMS, propose: async () => say([{ index: 1, cut: true, why: '铺垫' }, { index: 3, cut: true, why: '铺垫' }]) })
ok('只有放开风格规则才删得动时，这一组删成了', softRun.picks.length === 2 && softRun.model.units.length === 1, JSON.stringify(softRun.picks.map(p => p.text)))
ok('放开的风格规则写进 notes（连说两句「但是」）', softRun.notes.some(n => /但是/.test(n)), JSON.stringify(softRun.notes))
ok('模型只判了碎片后半句 → 前半句一起带上（否则会删出半句话）', softRun.picks.some(p => p.text.includes('满大街')), JSON.stringify(softRun.picks.map(p => p.text)))
ok('模型提了、规则挡下的句子进 proposed，带挡下的理由（报告要能自证）', softRun.model.proposed.some(p => p.idx === 1 && /钩子/.test(p.refused || '')), JSON.stringify(softRun.model.proposed))
const hardOnly = await planPrune({ segments: F.c.segments, words: F.c.words, plan: F.plan, target: F.plan.outDuration - pairOf(F), params: { ...U_PARAMS, clauseSoft: false }, propose: async () => say([{ index: 3, cut: true, why: '铺垫' }]) })
ok('关掉软规则 → 这一组一句都不删（硬规则不放行就是不放行）', hardOnly.picks.length === 0, JSON.stringify(hardOnly.picks.map(p => p.text)))
// 后面那句既不是转折也不是反问：这段就不是「铺垫」，理由对不上只能进降档
const nRun = await planPrune({ segments: N.c.segments, words: N.c.words, plan: N.plan, target: N.plan.outDuration - pairOf(N), params: U_PARAMS, propose: async () => say([{ index: 2, cut: true, why: '铺垫' }, { index: 3, cut: true, why: '铺垫' }]) })
ok('后面不是转折/反问 → 单元理由对不上，只能按降档用（source=model-weak）',
  nRun.picks.length === 2 && nRun.picks.every(p => p.source === 'model-weak') && nRun.model.units.length === 0,
  JSON.stringify({ picks: nRun.picks.map(p => [p.text, p.source]), units: nRun.model.units }))
// 单元不许无限长：连着三句都够票时按 maxConsecutive 截断，第三句单独核（主张句不走降档）
const capRun = await planPrune({ segments: A.c.segments, words: A.c.words, plan: A.plan, target: A.plan.outDuration - pairOf(A), params: U_PARAMS, propose: async () => say([{ index: 2, cut: true, why: '铺垫' }, { index: 3, cut: true, why: '铺垫' }, { index: 4, cut: true, why: '铺垫' }]) })
ok('单元最多两句（再长观众觉得跳），第三句单独核', capRun.model.units.every(u => u.idx.length <= 2), JSON.stringify(capRun.model.units))
ok('单元里含主张句、理由又对不上 → 不走降档（主张句是论点）', capRun.rejectedByReason.some(r => /主张句/.test(r.why)), JSON.stringify(capRun.rejectedByReason))
ok('units / notes / proposed 在报告里始终是数组（没有也要有字段）', Array.isArray(capRun.units) && Array.isArray(capRun.notes) && Array.isArray(capRun.model.proposed))
const total = pass + fails.length
console.log(fails.length ? 'FAIL ' + fails.length + '/' + total : 'PASS ' + total + ' 条')
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
