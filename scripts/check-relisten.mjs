/**
 * 听音复核的规则：什么时候算证据、补回来的字放在哪、什么情况必须拒绝。
 * 纯逻辑，不下载模型、不解码音频。
 *
 * 这套规则要守住的是一条底线：**加字只能由音频证明**。
 * 模型说「应该是知道怎么做」不算证据（自测13 实测那条建议是错的，音频里只有「会」），
 * 换一个更强的模型在同一段音频上听到「的人」才算——因为它听的是素材本身。
 */
import { alignCrop, charDiff, planRepair, silentGaps, modelAvailable, relistenSentence, enabled, slotAnomaly, R, strip } from '../src/relisten.mjs'
import { lowConfidenceClusters } from '../src/asr-fix.mjs'
import { phraseAround } from '../src/qa-semantic.mjs'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }

// ── 差异：只认一处连续改动，且有预算 ──
const d0 = charDiff('知道会做的人太少了', '知道会做的人太少了')
ok('两次一致 → 没有差异', d0.same === true)
const d1 = charDiff('知道会做的人太少了', '知道的人会做的人太少了')
ok('实测那一处吞字 → 在「知道」后面补 2 字', d1.at === 2 && d1.del === 0 && d1.ins === '的人', JSON.stringify(d1))
const d2 = charDiff('指纹住在做内容', '真正在做内容')
// 这一例（删「指纹住在」补「真正」再留「在做内容」）是同音/语义替换，四遍纠错的校验器管它；
// 听音复核不抢这个活：它只处理「多了/少了字」，一次动 3 个字以上一律打回。
ok('语义型替换不走听音复核 → 打回（交给四遍纠错）', Boolean(d2.error), JSON.stringify(d2))
const d3 = charDiff('一二三四五', '一二三四五六七八九')
ok('加 4 个字 → 超预算打回', Boolean(d3.error), JSON.stringify(d3))
const d4 = charDiff('一二三四五六', '一二三')
ok('删 3 个字 → 超预算打回', Boolean(d4.error), JSON.stringify(d4))
const d5 = charDiff('知道会做', '知道会做的人太少了')
ok('加的是一整句（6 字）→ 打回，不许借听音复核塞内容', Boolean(d5.error), JSON.stringify(d5))

// ── 加字：新字必须落进静音缝隙 ──
const wsReal = [
  { i: 150, core: '知', start: 42.32, end: 42.48 },
  { i: 151, core: '道', start: 42.48, end: 42.60 },
  { i: 152, core: '会', start: 42.60, end: 43.48 },
  { i: 153, core: '做', start: 43.48, end: 43.68 },
  { i: 154, core: '的人', start: 43.68, end: 43.90 },
  { i: 155, core: '太', start: 43.90, end: 44.14 },
  { i: 156, core: '少', start: 44.14, end: 44.38 },
  { i: 157, core: '了', start: 44.38, end: 44.58 },
]
const gapsReal = { 152: [{ s: 42.90, e: 43.36 }] }
const p1 = planRepair({ ws: wsReal, diff: d1, gapsOf: i => gapsReal[i] || [] })
ok('实测那一处 → 可以把「的人」补进「会」的静音缝隙', p1.ok === true, JSON.stringify(p1))
ok('补回来的字落在缝隙**之前**（语音在前、静音在后）', p1.newWord.start === 42.60 && p1.newWord.end === 42.90, JSON.stringify(p1.newWord))
ok('「会」的起点挪到缝隙起点，槽尾不动（时间码没被偷走）', p1.hostStart === 42.90, JSON.stringify(p1))
ok('缝隙够长（0.46s）→ 新词尾部补逗号，字幕读得断', p1.comma === true && p1.newWord.w === '的人，', p1.newWord.w)
const p2 = planRepair({ ws: wsReal, diff: d1, gapsOf: () => [] })
ok('词槽里没有静音缝隙 → 不许硬塞（会挤掉已经说出声的音节）', p2.ok === false && /静音缝隙/.test(p2.why), p2.why)
const wsFlat = [{ i: 1, core: '知道', start: 1.0, end: 1.4 }, { i: 2, core: '会', start: 1.4, end: 1.9 }]
const p3 = planRepair({ ws: wsFlat, diff: { at: 1, del: 0, ins: '的' }, gapsOf: () => [{ s: 1.2, e: 1.6 }] })
ok('改动点切在词中间 → 拒绝（不许把半个词改成别的字）', p3.ok === false && /词的中/.test(p3.why), p3.why)

// ── 删字：切在词中间要标出来，交给调用方拒绝 ──
const p4 = planRepair({ ws: wsFlat, diff: { at: 1, del: 1, ins: '' }, gapsOf: () => [] })
ok('删字起点切在词中间 → 直接拒绝', p4.ok === false && /词的中/.test(p4.why), JSON.stringify(p4))
const wsDel = [{ i: 1, core: '知道', start: 1.0, end: 1.4 }, { i: 2, core: '的人', start: 1.4, end: 1.8 }]
const p5 = planRepair({ ws: wsDel, diff: { at: 2, del: 1, ins: '' }, gapsOf: () => [] })
ok('删字吃进词里但只吃掉一半 → 标成非整词（调用方拒绝拆词）', p5.ok === true && p5.eaten[0].full === false, JSON.stringify(p5))

// ── 触发条件：ASR 自己卡过的地方 ──
const viewReal = { ws: wsReal.map(w => ({ ...w, p: w.i === 150 ? 0.42 : w.i === 152 ? 0.55 : 0.97 })) }
ok('实测那句（知 0.42 / 会 0.55 相邻）→ 值得重听', lowConfidenceClusters(viewReal).length > 0, JSON.stringify(lowConfidenceClusters(viewReal)))
const viewCalm = { ws: wsReal.map(w => ({ ...w, p: 0.98 })) }
ok('一句都很自信 → 不去重听（省时间，也不乱改）', lowConfidenceClusters(viewCalm).length === 0)
const viewOne = { ws: wsReal.map((w, k) => ({ ...w, p: k === 2 ? 0.5 : 0.98 })) }
ok('只有一个低置信词 → 不算扎堆', lowConfidenceClusters(viewOne).length === 0)

// ── 静音缝隙：从能量包络里量 ──
const env = { db: new Float32Array(200), hopSec: 0.005 }
for (let i = 0; i < 200; i++) env.db[i] = i >= 100 && i < 160 ? -45 : -15
const gaps = silentGaps(env, 0.30, 0.95)
ok('包络里量出 0.30s 的静音 → 缝隙起点 0.50s', gaps.length === 1 && Math.abs(gaps[0].s - 0.50) < 0.01, JSON.stringify(gaps))
ok('缝隙太短（0.05s）→ 不算缝隙', silentGaps({ db: new Float32Array(20).fill(-15).map((v, i) => (i === 5 ? -50 : v)), hopSec: 0.005 }, 0, 0.09).length === 0)

// ── 语义审读的仲裁：这段文字在音频里是哪一句 ──
const words = []
let t = 42.32
for (const w of ['知', '道', '的', '人', '会', '做', '的', '人', '太', '少', '了', '我', '现', '在']) {
  words.push({ w, start: +t.toFixed(2), end: +(t + 0.2).toFixed(2), p: 0.9 })
  t += w === '了' ? 0.7 : 0.2   // 「了」之后停 0.5s（停顿之后的「我现在」不该拼进这一句）
}
const ph = phraseAround(words, '会做的人太少了')
ok('按引用找到那一句', ph && ph.text.includes('会做的人太少了'), JSON.stringify(ph))
ok('不跨长停顿（不会把后面「我现在」拼进来）', ph && !ph.text.includes('我现在'), ph && ph.text)
ok('引用在片子里找不到 → 返回空（模型编的话不采信）', phraseAround(words, '根本不存在的一句') === null)

// ── 文字对齐：两个模型词边界差 0.3–0.5s，按时长裁会把句子切歪 ──
const said = ['容', '知道', '的人', '会', '做', '的人', '太少'].map(w => ({ w }))
const al = alignCrop('知道会做的人太少了', said)
ok('重听多带了一个「容」、又少了尾巴 → 按文字对齐挑出「知道的人会做的人太少」', al && al.text === '知道的人会做的人太少', JSON.stringify(al))
ok('对齐结果首尾都落在句子的字上（优先首尾对得上的那段）', al && al.text[0] === '知', al && al.text)
const al2 = alignCrop('知道会做的人太少了', ['完全', '不相干', '的', '几个', '字'].map(w => ({ w })))
ok('重听内容与这句话完全不像 → 对齐返回空，绝不硬凑', al2 === null, JSON.stringify(al2))
const al3 = alignCrop('知道会做的人太少了', ['知道', '的人', '会', '做', '的人', '太', '少', '了'].map(w => ({ w })))
ok('完整读完 → 对齐到整句（8/11 字相同，差的正是要补的 2 字）', al3 && al3.text === '知道的人会做的人太少了' && al3.score > 0.8, JSON.stringify(al3))

// ── 降级路径：没有更强模型就说没跑，绝不拿 small 冒充第二意见 ──
const noModel = await relistenSentence({ media: 'nonexistent.mp4', span: [0, 1], model: 'no-such-model-xyz' })
ok('素材路径不对 → 明说不跑，绝不假装听过', noModel.ok === false && noModel.skipped === 'no-media', JSON.stringify(noModel))
// 弱耳朵能不能授权改字，看的是与模型无关的结构证据：词槽明显吞了静音
const an1 = slotAnomaly({ start: 42.60, end: 43.48, chars: 1, gaps: [{ s: 42.90, e: 43.36 }] })
ok('「会」一个字的槽 0.88s（5.5 倍）+ 内有静音 → 判定为吞字槽', an1.anomaly === true && an1.ratio >= 5, JSON.stringify(an1))
const an2 = slotAnomaly({ start: 43.48, end: 43.68, chars: 1, gaps: [{ s: 42.90, e: 43.36 }] })
ok('正常长度的词槽（1.25 倍）→ 不算吞字', an2.anomaly === false, JSON.stringify(an2))
const an3 = slotAnomaly({ start: 0.0, end: 1.0, chars: 1, gaps: [] })
ok('槽很长但里面没有静音 → 不算吞字（那是拖长音，不是丢了字）', an3.anomaly === false, JSON.stringify(an3))
ok('听音复核的默认模型比 small 强', R.model !== 'small', R.model)
ok('本机 medium 就绪（没就绪时这条会提醒要下载）', modelAvailable('medium') === true, 'modelAvailable(medium)=false')
const old = process.env.VISION_BOTS_RELISTEN
process.env.VISION_BOTS_RELISTEN = '0'
ok('VISION_BOTS_RELISTEN=0 → 整层关掉', enabled() === false)
process.env.VISION_BOTS_RELISTEN = old ?? ''
ok('strip 去掉标点后能逐字比', strip('知道的人，会做的人太少了') === '知道的人会做的人太少了')

const total = pass + fails.length
console.log(fails.length ? 'FAIL ' + fails.length + '/' + total : 'PASS ' + total + ' 条')
for (const f of fails) console.log('  ✗ ' + f)
process.exit(fails.length ? 1 : 0)
