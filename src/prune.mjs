/**
 * 选句删（内容预算）：把「目标时长」真正接进剪辑决策。
 *
 * 为什么要有这一层：自测 01–15 每一版的成片都比目标长 6–8 秒，用户要 60 秒，拿到的
 * 是 66.5 秒。查下来不是素材问题，也不是模型不努力——buildPlan 里**根本没有 target 这个参数**。
 * 目标时长只出现在两处：制片人算差额、质检判合格。真正决定删什么的那个函数不知道目标，
 * 它只会做一件事：把停顿、口头语、口吃剪掉。停气和口头语剪完是 66.5 秒，就交 66.5 秒。
 *
 * 所以补两个东西：
 *   1) 整句删：剪辑要有「删内容」的算子，和「删气口」并列。
 *   2) 目标进决策：差额多少、删哪几句、删完落在哪里，由这里算。
 *
 * 分工和别处一样：模型只提案（哪几句是废话/重复/离题），规则定生死（钩子、落点、主张、
 * 唯一数字、悬空的连接词，一律不许删），最后按「离目标最近」做子集选择。
 * 模型挂了照样能剪：确定性价值排序兜底。整句删只动文本区间，时间码一个都不碰——
 * 刀口由 buildPlan 统一算，接缝照样落在最安静的地方。
 */
import { chatJSONCached, taskCall } from './llm.mjs'
import { normWords } from './plan.mjs'

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
export const bare = s => String(s || '').replace(PUNCT, '')

export const DEFAULT_PRUNE = {
  enabled: true,
  tolerance: 0.02,     // 成片落在 target .. target×(1+tolerance) 之内算到位
  underSlack: 0.03,    // 允许删过头一点（低于 target 不超过 3%）：60s 的片子 58.2s 还能接受，55s 不行
  maxSentences: 0.3,   // 整句删不超过总句数的三成——删多了不是剪辑，是重写
  maxChars: 0.25,
  maxConsecutive: 2,   // 不许连着删第三句：观众会觉得跳
  minSentenceSec: 0.7, // 太短的句子删了只是零头，还会把刀口切碎
  protectTail: 2,      // 最后两句是落点（自我介绍 / 收尾 CTA），不动
  maxCandidates: 12,
  mode: 'score',      // score = 逐句表态（默认）；pick = 自由挑几句（保留做对照）
  samples: 3,         // 同一个问题独立判读几次，取多数票：温度钉 0 在这个网关上也不保证一致
  minVotes: null,     // 默认 samples 的过半票
}

/** 主张句：这一句是论点不是铺垫，删了观点就没了。 */
const CLAIM = ['才是', '就是', '真正的', '真正', '一定', '必须', '其实', '核心', '关键', '本质', '认为', '最重要', '重点', '唯一', '不是', '太少', '别再', '不要']
/** 从句起头：删了它，后半句挂空。 */
const SUBORDINATE = /^(只有|如果|要是|因为|虽然|即使|哪怕|一旦|除了|不管|无论)/
/**
 * 结果句起头（「你才有机会出圈」「就能做出一周的工作量」）：
 * 它接的是前面那句「只有…」「花一天…」，删了它，前一句就挂空。
 * 这一条是自测16 离线试跑抓到的：模型挑中「你才有机会出圈」，规则当时放行了，
 * 删完就成了「只有别人看到你 / 看到你的产品」——只有…没有才，观众听着就断了。
 */
const CONSEQUENCE = /^(?:你|我|他|她|它|这|那|也)?(?:才|就|便|才要|才会)/

/**
 * 碎片句：转写把一个整句切成了两段（「都是在做AI模型」+「做AI工具的」）。
 * 这种句子只能和它的前半句一起删：只删后半句会剩下半句话，只删前半句会把后半句吊在空中。
 * 判定看三个条件：够短（≤7 字）、以动词/助词起头、上一句没有句末标点（说明上一句没说完）。
 */
const FRAG_START = /^(做|用|把|给|让|在|是|都|也|还|就|才|能|会|要|想|这|那|然后|所以|但是|或者|还有)/
export function fragmentFlags(sentences) {
  return sentences.map((s, i) => i > 0 &&
    s.bare.length <= 7 &&
    FRAG_START.test(s.bare) &&
    !/[，。！？；]$/.test(String(sentences[i - 1].text || '')))
}

/** 自我介绍之后都是落点：那几句是品牌和 CTA，删了观众不知道你是谁。 */
export function outroStart(sentences) {
  for (let i = sentences.length - 1; i >= 0; i--) {
    const t = sentences[i].bare
    if (t.length <= 10 && /^(我是|我叫|这里是|我们是|这里是)/.test(t)) return i
  }
  return sentences.length
}
/** 连接词起头：后一句以它开头，说明它接的是前一句。 */
const CONNECTIVE = /^(但是|可是|不过|所以|因此|于是|然后|而且|因为|结果|另外|还有)/
/** 承诺句：开口就答应观众「要给你点什么」——这种句子是钩子的落点，删了前 5 秒就没有抓手。 */
const HOOK_PROMISE = /(我今天|今天我就|我要|想跟|跟你说|给你|给大家|告诉你|说个事|说白了|泼一瓶|泼盆)/
/** 两句都用同一个连接词开头，中间那份被删了就会连着说两个「但是」。 */
const CLAUSE_START = /^(但是|可是|不过|所以|因此|于是|而且|因为)/

const round2 = n => Math.round(n * 100) / 100
const round3 = n => Math.round(n * 1000) / 1000

/** 最长公共子串 / 较短串长度。整句重复用这个最灵敏（和质检口径一致）。 */
export function similarity(a, b) {
  const A = [...bare(a)], B = [...bare(b)]
  if (!A.length || !B.length) return 0
  let best = 0
  const dp = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i++) {
    let prev = 0
    for (let j = 1; j <= B.length; j++) {
      const tmp = dp[j]
      dp[j] = A[i - 1] === B[j - 1] ? prev + 1 : 0
      if (dp[j] > best) best = dp[j]
      prev = tmp
    }
  }
  return best / Math.min(A.length, B.length)
}

/**
 * 句子 = 转写段（whisper 按静音切出来的整句）。已经被删掉的词不算进来：
 * 整句删是在「成片还留着的词」上做决定，不是对着原始转写做决定。
 */
export function buildSentences({ segments = [], words = [], deleted = new Set() }) {
  const ws = words.length && Number.isInteger(words[0].i) ? words : normWords(words)
  const out = []
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k] || {}
    const a = Number(seg.start), b = Number(seg.end)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    const all = ws.filter(w => w.start >= a - 0.03 && w.end <= b + 0.03)
    const kept = all.filter(w => !deleted.has(w.i))
    if (!kept.length) continue
    out.push({
      segIndex: k,
      start: kept[0].start,
      end: kept.at(-1).end,
      dur: Math.max(0.1, kept.at(-1).end - kept[0].start),
      text: kept.map(w => w.w).join(''),
      bare: bare(kept.map(w => w.w).join('')),
      i0: kept[0].i,
      i1: kept.at(-1).i,
      words: kept.length,
      partial: kept.length < all.length,
    })
  }
  out.forEach((s, i) => { s.idx = i })
  return out
}

/**
 * 两句是不是「同一句话说两遍」。光比相似度不够：similarity 是「最长公共子串 / 较短串」，
 * 短句被长句整句包住时会给出 1.0（「卷内容生产力」被「现在专注在做OPC的内容生产力」包住），
 * 那不是重复，那是一句在另一句里长出来。所以再加一条长度比。
 */
export function isDup(a, b) {
  const A = bare(a), B = bare(b)
  if (!A || !B) return false
  const ratio = Math.min(A.length, B.length) / Math.max(A.length, B.length)
  return ratio >= 0.6 && similarity(A, B) >= 0.82
}

/** 术语表里的词：全片只在一句里出现过的，那句不许删（删了就丢了信息）。 */
function termWords(terms) {
  // loadTerms 返回的是「数组 + hotwords 属性」，两种形状都认，别只认一种（不然术语保护是空的）
  const set = new Set()
  const push = v => { const s = String(v || ''); if (s.length >= 2) set.add(s) }
  const list = Array.isArray(terms) ? terms : ((terms && terms.terms) || [])
  for (const h of (terms && terms.hotwords) || []) push(h)
  for (const t of list) push(t && t.to)
  return [...set]
}

const digitsIn = s => String(s || '').match(/\d+/g) || []

/**
 * 这一句为什么**永远**不许删。返回理由字符串或 null。
 * 每条都能对着原话指出来，不是口味问题。
 */
export function hardRefuse(s, sentences, ctx = {}) {
  const p = ctx.params || DEFAULT_PRUNE
  if (s.idx === 0) return '第一句是钩子'
  // 钩子常常是两句：第一句铺垫（「AI时代最赚钱的不是技术」），第二句转折加承诺
  // （「但是我今天就要给大家泼一瓶冷水」）。只护第一句的话，被删的正好是钩子的落点——
  // 自测24 真素材实测：三次重剪里有一次就把这句删了，开头变成「今天大家都在卷AI技术…大家在看这些…」。
  if (s.start < 12 && CLAUSE_START.test(s.bare) && HOOK_PROMISE.test(s.bare)) return '这是开头的钩子（转折 + 承诺），删了前 5 秒就没抓手'
  if (Number.isInteger(ctx.outroFrom) && s.idx >= ctx.outroFrom) return '自我介绍之后都是落点（品牌 / CTA）'
  if (s.idx >= sentences.length - (p.protectTail ?? 2)) return '最后两句是落点（自我介绍 / 收尾）'
  if (s.dur < (p.minSentenceSec ?? 0.7)) return '只有 ' + s.dur.toFixed(1) + 's，删了也是零头'
  if (s.bare.length < 4) return '只有 ' + s.bare.length + ' 个字，删不干净'
  // 同一句话说了两遍、第一版剪辑已经删掉一遍：再删一遍就是把这句彻底抹掉。
  // 自测16 实测踩到：「但是AI来去做内容」说两遍，重复规则删了第二遍，整句删又删了第一遍，
  // 结果「知道的人，会做的人太少了」没了前半句，观众听到的是一句悬空的断言。
  if (ctx.deletedRepeat && ctx.deletedRepeat.has(s.bare)) return '这句的重复副本已经删过了，再删整句就没了'
  const sub = s.bare.match(SUBORDINATE)
  if (sub) return '这句以「' + sub[1] + '」起头，删了后半句挂空'
  // 话没说完就收尾：这句以「给/把/让/对…」这种要宾语的词结尾，动词和宾语都在下一句里。
  // 自测24 抓到的真实漏洞：「但是我今天就要给大家」被放行删掉，成片剩下「泼一瓶冷水」——
  // 钩子的意思全没了。碎片规则（≤7 字 + 特定动词起头）拦不住它，因为它有 9 个字、以「但是」起头。
  const nx = sentences[s.idx + 1]
  // 形态是「动词 + 对象」就收尾（「给大家」「给你」「告诉他们」）：对象在，动作在下一句。
  const openTail = s.bare.match(/(给|让|请|叫|告诉|跟|对|向)(你|我|他|她|它|您|你们|我们|他们|大家|各位|自己)$/)
  if (openTail && nx && bare(nx.text).length <= 8) return '这句以「' + openTail[0] + '」收尾，话没说完，后半句在下一句'
  const cons = s.bare.match(CONSEQUENCE)
  if (cons) return '这句以「' + cons[0] + '」接上句，删了上句挂空'
  // 碎片句不承担逻辑连接，跳过「下一句以连接词开头」这条（否则碎片的前半句会被连坐）
  const frag = Boolean(ctx.fragments && ctx.fragments[s.idx])
  const next = sentences[s.idx + 1]
  if (next && !frag) {
    const m = next.bare.match(CONNECTIVE)
    if (m) return '下一句以「' + m[1] + '」开头，删了会悬空'
    // 反方向：下一句是「就…」「才…」这种结果句，说明这一句是它的前半句
    const c = next.bare.match(CONSEQUENCE)
    if (c) return '下一句以「' + c[0] + '」接这句，删了后半句挂空'
  }
  // 唯一的数字 / 术语：删了就丢了信息
  const others = sentences.filter(x => x !== s).map(x => x.bare).join('\u0000')
  for (const d of digitsIn(s.bare)) if (!others.includes(d)) return '「' + d + '」全片只在这一句出现'
  for (const t of ctx.terms || []) {
    if (!s.bare.includes(t)) continue
    if (!others.includes(t)) return '「' + t + '」全片只在这一句出现'
  }
  return null
}

/**
 * 这一句值不值得留：越高越该留。只是确定性排序用的近似，
 * 真正的判断权在模型提案 + 上面的硬规则。
 */
export function valueOf(s) {
  let v = 0
  v += 2 * digitsIn(s.bare).length
  v += 1 * s.words * 0.5
  if (CLAIM.some(c => s.bare.includes(c))) v += 3
  if (CONNECTIVE.test(s.bare)) v += 1.5
  if (CONNECTIVE.test(s.bare) && s.bare.length <= 6) v -= 1
  if (/^(就是|就是说|这个|那个|然后|其实)/.test(s.bare)) v -= 1
  return v
}

/** 抽掉这若干句之后，剩下的句子会不会连着说两个「但是」。 */
function adjacencyProblem(picked, sentences) {
  const drop = new Set(picked)
  const kept = sentences.filter((_, i) => !drop.has(i))
  for (let i = 1; i < kept.length; i++) {
    const a = kept[i - 1].bare.match(CLAUSE_START)
    const b = kept[i].bare.match(CLAUSE_START)
    if (a && b && a[1] === b[1]) return '会连着出现两句「' + b[1] + '」开头的句子'
  }
  return null
}

function longestRun(picked) {
  const set = new Set(picked)
  let best = 0, cur = 0
  const max = Math.max(0, ...picked) + 2
  for (let i = 0; i <= max; i++) {
    if (set.has(i)) { cur++; if (cur > best) best = cur } else cur = 0
  }
  return best
}

/**
 * 子集选择：在候选中挑一组，让「成片时长」离目标最近。
 * 约束全是硬的：句数上限、字数上限、不许连删三句、不许删出两个「但是」连着、不许删过头。
 * 候选 ≤ 12 就直接枚举（4096 种），不用启发式——差一句就白剪。
 */
export function chooseSubset({ candidates, sentences, current, target, params = {}, fragments = null }) {
  const p = { ...DEFAULT_PRUNE, ...params }
  const frag = Array.isArray(fragments) ? fragments : fragmentFlags(sentences)
  const pool = candidates.slice(0, p.maxCandidates)
  const maxDrop = Math.max(0, current - target * (1 - p.underSlack))
  const maxCount = Math.max(1, Math.ceil(sentences.length * p.maxSentences))
  const totalChars = sentences.reduce((n, s) => n + s.bare.length, 0)
  const maxChars = Math.max(4, Math.floor(totalChars * p.maxChars))
  let best = null
  const n = pool.length
  for (let mask = 0; mask < (1 << n); mask++) {
    const picked = []
    let drop = 0, chars = 0
    for (let k = 0; k < n; k++) {
      if (!(mask & (1 << k))) continue
      picked.push(pool[k].idx)
      drop += pool[k].dur
      chars += pool[k].bare.length
    }
    if (!picked.length) continue
    if (picked.length > maxCount) continue
    if (chars > maxChars) continue
    if (drop > maxDrop + 1e-6) continue
    if (longestRun(picked) > (p.maxConsecutive ?? 2)) continue
    if (adjacencyProblem(picked, sentences)) continue
    // 碎片句：不许单独删自己的前半句，也不许只删前半句把碎片吊在空中
    const drop2 = new Set(picked)
    let fragBad = false
    for (const i of picked) {
      if (frag[i] && !drop2.has(i - 1)) { fragBad = true; break }
      if (frag[i + 1] && !drop2.has(i + 1)) { fragBad = true; break }
    }
    if (fragBad) continue
    const after = current - drop
    const cost = Math.abs(after - target)
    // 一样近就少删一句；再一样就挑删得少的
    const key = [cost, picked.length, drop]
    if (!best || key[0] < best.key[0] - 1e-6 ||
      (Math.abs(key[0] - best.key[0]) <= 1e-6 && key[1] < best.key[1]) ||
      (Math.abs(key[0] - best.key[0]) <= 1e-6 && key[1] === best.key[1] && key[2] < best.key[2])) {
      best = { key, picked, drop, after }
    }
  }
  return best
}

/**
 * 模型给的理由必须和句子对得上。这条不是抠字眼：自测16 离线试跑里模型把
 * 「但是我今天就要给大家泼一瓶冷水」标成「口头过渡」——它是全片的钩子，删了开头就空一半。
 * 能被机械核对的理由只有两类，其余理由（「不是重点」「离题」）照收但标 unverified：
 *   重复   → 前面必须真说过一句一样的
 *   过渡/废话/口头 → 这句得真像过渡（以「就是/然后/其实/我最近」起头，或者很短）
 */
export function reasonFits(s, why, sentences, dups = []) {
  const w = String(why || '')
  if (!w) return { ok: true }
  if (/重复|复读/.test(w)) {
    const dup = dups.includes(s.idx) || sentences.some(x => x.idx !== s.idx && isDup(x.bare, s.bare))
    return dup ? { ok: true } : { ok: false, why: '模型说这句是重复，但前面没说过一样的话' }
  }
  if (/(过渡|铺垫|废话|口头|水词|填充)/.test(w)) {
    const looks = /^(就是|就是说|然后|那个|其实|我最近|所以说|所以|那么|呃|嗯|啊|好)/.test(s.bare) || s.bare.length <= 6
    return looks ? { ok: true } : { ok: false, why: '模型说这句是过渡/废话，但这句不是过渡句（它带观点或信息）' }
  }
  return { ok: true, unverified: true }
}

export const PROMPT = ({ target, current, need, list, note = '' }) => [
  '你在做一条竖屏口播视频的剪辑。旁白已经录完，现在的成片是 ' + current.toFixed(1) + ' 秒，',
  '客户要 ' + target + ' 秒左右，还要再删掉 ' + need.toFixed(1) + ' 秒左右才行。',
  '',
  '下面按顺序是成片里还留着的每一句（序号 / 起始秒 / 时长 / 原话）。请挑出**可以整句删掉**的句子。',
  '判断标准：删掉之后意思不丢、上下文接得上、观众不会听不懂。',
  '可以删的典型：铺垫、口头过渡（「我最近研究了一圈」「就是说」）、重复了别处已经说过的意思、离题的补充。',
  '不能删的：抛出观点的、给出数字的、点出工具的、收尾和自我介绍。',
  '不要为了凑时长硬删——删得不够我会自己再想办法，删错了观众听得出来。',
  '每条给一个短理由（8 个字以内），理由必须是这几种之一：重复、铺垫、口头过渡、离题。',
  '「重复」前面必须真说过一句一样的；「铺垫 / 口头过渡」必须是那种起过渡作用的话（「就是说」「我最近」「然后」这类开头），',
  '不要拿「过渡」去标观点句、数字句、钩子句——规则会核对理由，对不上就不采纳。',
  '',
  (note ? [note, ''] .join('\n') : ''),
  '句（index / 起始秒 / 时长 / 原话）：',
  JSON.stringify(list, null, 1),
  '',
  '只输出 JSON：{"cut":[{"index":3,"why":"过渡句"}],"keep":"删完之后这条片子还剩下什么"}',
].join('\n')

/**
 * 逐句表态的问法（默认）：不问「挑哪几句」，问「这十句各自能不能删」。
 *
 * 为什么换（自测24 实测，同一个模型、同一份输入、温度 0）：
 *   · 自由挑几句连问五次，五次之间两两重合平均 0.69，最低 0.33——同一份材料能挑出四种删法；
 *   · 逐句判读连问三次，两两重合 0.85，最低 0.78，而且每次都把每一句判到。
 * 自由挑是个全局选择，模型每次落在不同的局部最优；逐句表态是十个小判断，抖动能互相抵消。
 * 上下文照样给全片（它得知道这句在整条片子里的位置），只让它对**规则允许删的那几句**表态。
 */
export const SCORE_PROMPT = ({ target, current, need, list, allow, note = '' }) => {
  const sameSet = Array.isArray(allow) && allow.length === list.length
  return [
  '你在做一条竖屏口播视频的剪辑。旁白已经录完，现在的成片是 ' + current.toFixed(1) + ' 秒，',
  '客户要 ' + target + ' 秒左右，还要再删掉 ' + need.toFixed(1) + ' 秒左右才行。',
  '',
  (sameSet
    ? '下面按顺序是成片里还留着的每一句。请**逐句**给结论，一句都不要漏：'
    : '先看全片（只作上下文，不要对这里的每一句表态）：'),
  ...(sameSet ? [] : [JSON.stringify(list, null, 1), '']),
  ...(sameSet ? [] : ['要你判的是下面这几句（规则已经筛过，剩下的都允许删）。请**逐句**给结论，一句都不要漏：']),
  JSON.stringify(allow, null, 1),
  '',
  '判断标准：删掉之后意思不丢、上下文接得上、观众不会听不懂。',
  'cut=true 的典型：铺垫、口头过渡（「我最近研究了一圈」「就是说」）、重复了别处已经说过的意思、离题的补充。',
  'cut=false 的典型：抛出观点的（「才是王道」）、给出数字的、点出工具的、收尾和自我介绍、话没说完的半句。',
  '不要为了凑时长硬删——删得不够我会自己再想办法，删错了观众听得出来。',
  'why 八个字以内，只能写：铺垫、口头过渡、重复、离题、观点、数字、工具、落点、话没说完。',
  '',
  (note ? [note, ''] .join('\n') : ''),
  '只输出 JSON：{"每句":[{"index":2,"cut":false,"why":"观点"},{"index":5,"cut":true,"why":"口头过渡"}]}',
  ].join('\n')
}

/** 两种问法都解析成同一种行：{index, cut, why}。坏输出当没答，不猜。 */
export function verdictsOf(value, mode = 'score') {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value['每句'])) {
    return value['每句'].filter(x => x && typeof x === 'object')
      .map(x => ({ index: Number(x.index), cut: x.cut === true, why: String(x.why || '').slice(0, 20) }))
      .filter(x => Number.isInteger(x.index))
  }
  if (Array.isArray(value.cut)) {
    const rows = value.cut.filter(x => x && typeof x === 'object')
      .map(x => ({ index: Number(x.index), cut: true, why: String(x.why || '').slice(0, 20) }))
      .filter(x => Number.isInteger(x.index))
    return rows
  }
  return []
}


/**
 * 主入口。plan 是已经算好的第一版剪辑（删完气口/口头语/口吃）。
 * 返回 { ok, picks, refused, before, after, hit, ... }，picks 里的 i0/i1 是**归一化词下标**，
 * 直接喂给 buildPlan 的 ranges 就能重算一版。
 */
export async function planPrune({ segments = [], words = [], plan, target, terms = null, params = {}, log = () => {}, propose = null }) {
  const p = { ...DEFAULT_PRUNE, ...params }
  const current = Number(plan && plan.outDuration) || 0
  const deleted = new Set()
  for (const d of (plan && plan.deletions) || []) {
    if (Number.isInteger(d.i0) && Number.isInteger(d.i1)) for (let i = d.i0; i <= d.i1; i++) deleted.add(i)
  }
  // words 必须是**归一化词表**（和 buildPlan 内部同一套下标），否则 sentences 的 i0/i1 会是 undefined，
  // buildPlan 那边会报「区间不合法」——这一条在自测16 第 1 次真跑时就是这样炸的：剪好片、倒在最后一步。
  const ws = normWords(words)
  const sentences = buildSentences({ segments, words: ws, deleted })
  const base = { ok: false, target, before: round2(current), sentences: sentences.length, picks: [], refused: [], model: null }
  if (!p.enabled) return { ...base, skipped: 'disabled' }
  if (!target || !(target > 0)) return { ...base, skipped: 'no-target' }
  if (!sentences.length) return { ...base, skipped: 'no-sentences' }
  const upper = target * (1 + p.tolerance)
  if (current <= upper) return { ...base, ok: true, skipped: 'already-fit', after: round2(current), hit: true }

  const fragments = fragmentFlags(sentences)
  const deletedRepeat = new Set(((plan && plan.deletions) || []).filter(d => d.reason === 'repeat').map(d => bare(d.text)))
  const ctx = { params: p, terms: termWords(terms), outroFrom: outroStart(sentences), fragments, deletedRepeat }
  const refused = []
  const cands = []
  for (const s of sentences) {
    const why = hardRefuse(s, sentences, ctx)
    if (why) refused.push({ idx: s.idx, text: s.bare.slice(0, 18), why })
    else cands.push(s)
  }
  // 注：主张句（含「才是 / 就是 / 真正 / 太少」）不在这里硬拦。它属于「判断」，交给模型提、
  // 由 reasonFits 降档处理；规则只拦**机械性破坏**（悬空、丢唯一信息、删出半句）。
  // 非相邻的重复句：全片说了一遍又一遍，删后一遍永远是对的（不需要模型同意）。
  // 必须比长度：similarity 是「最长公共子串 / 较短串」，短句整句被长句包住时会给 1.0——
  // 离线试跑里「卷内容生产力」和「现在专注在做OPC的内容生产力」被判成重复，差点把落点删了。
  const dups = []
  for (let i = 1; i < sentences.length; i++) {
    for (let j = 0; j < i; j++) {
      if (isDup(sentences[i].bare, sentences[j].bare)) { dups.push(sentences[i].idx); break }
    }
  }

  const need = current - target
  const listOf = list => list.map(s => ({ index: s.idx, 起始: round2(s.start), 时长: round2(s.dur), 原话: s.bare }))
  const rank = list => list.slice().sort((a, b) => (valueOf(a) / Math.max(0.4, a.dur)) - (valueOf(b) / Math.max(0.4, b.dur)))
  // 模型怎么问、问几遍、几票才算数——全部来自剪辑自己的配置（config/bots/cutter.json 的 prune 段）。
  // 温度钉 0 只保证「同样的请求发出去」，不保证「拿回来的答案一样」：自测24 实测同一个网关上
  // 同一份输入连问五次，五次之间两两重合 0.69、最低 0.33。所以这里不再依赖「一次判读就是答案」，
  // 改成逐句表态 + 多次判读取多数票（票数不够的句子记进报告，不删）。
  const mode = p.mode === 'pick' ? 'pick' : 'score'
  const wantSamples = Math.max(1, Math.min(5, Number(p.samples) || 1))
  // propose 是自检用的注入口：离线断言不许联网，也不该为了测个选择器去调模型（只给一次答案）
  const perRound = typeof propose === 'function' ? 1 : wantSamples
  // 离线注入口一次给一份答案时按 1 票算（老断言不受影响）；要测投票就显式给 samples / minVotes，
  // 并让 propose 一次返回一组答案（数组＝几次判读），这样离线也能复现「同一输入三次判得不一样」。
  const minVotes = Math.max(1, Math.min(wantSamples, Number(p.minVotes) || (typeof propose === 'function' ? 1 : Math.ceil(wantSamples / 2))))
  const askOnce = (note, list, allow, k) => (typeof propose === 'function'
    ? propose(list, note)
    // 走剪辑 bot 的配置（模型、温度）。salt 只进缓存指纹、不进提问：同一份问题采几次样，
    // 每次各存一份缓存，所以同一个群重跑时这几票全是原样命中，结果不会自己变。
    : (mode === 'pick'
      ? chatJSONCached({ prompt: PROMPT({ target, current, need, list, note }), ...taskCall('cutter', { maxTokens: 760 }), salt: k ? 'sample:' + k : '' })
      : chatJSONCached({ prompt: SCORE_PROMPT({ target, current, need, list, allow, note }), ...taskCall('cutter', { maxTokens: 1200 }), salt: k ? 'sample:' + k : '' })))

  const modelYes = new Map()   // 模型点名可以删的句子（多轮累加）
  const modelWeak = new Map()  // 模型提了、但理由对不上句子的（降一档用）
  const modelBad = []          // 上面那些，带理由留在报告里
  const blocked = []           // 模型想删、被规则挡住的（原话片段）
  const modelInfo = { rounds: 0, mode, samples: wantSamples, asks: 0, minVotes, picked: 0, votes: [], unstable: [], blocked, skipped: null }
  let widened = false
  let best = null

  // 最多问两轮：第一轮问「规则允许的每一句能不能删」；不够就告诉它「上一轮被规则挡住了哪几句」再问一次。
  // 「删哪句读得通」是判断力问题，交给模型；「哪些句不许删」是规则问题，留在规则里。
  const rounds = Math.max(1, Math.min(2, Number(p.modelRounds) || 2))
  for (let round = 0; round < rounds; round++) {
    const allowedNow = cands.filter(s => !modelYes.has(s.idx))
    if (round > 0 && !allowedNow.length) break
    const list = listOf(sentences)
    // 第一轮问全片：模型想删但被规则挡住的也要留成证据（「提了什么、哪条规则打回」）；
    // 计票只在规则允许的那几句里算，第二轮就只问剩下的允许句。
    const allow = round === 0 ? sentences : allowedNow
    const left = need - (best ? best.drop : 0)
    const note = round === 0 ? '' : (
      '上一轮你判为可删的 ' + modelYes.size + ' 句里有 ' + blocked.length + ' 句被规则挡住了：' + blocked.slice(0, 6).join('；') + '。' +
      '下面只列规则允许删的句子，还要再删 ' + Math.max(0.1, left).toFixed(1) + ' 秒。')
    const votes = new Map()   // idx -> { yes, no, whys: [] }
    let okSamples = 0
    let rawCount = 0
    for (let k = 0; k < perRound; k++) {
      const got = await askOnce(note, list, listOf(allow), k)
      // 一次判读 = 一份答案；注入口也允许一次给一组（数组），离线就能复现多票
      const batch = Array.isArray(got) ? got : [got]
      for (const r of batch) {
        modelInfo.rounds = round + 1
        if (!r || !r.ok) {
          modelInfo.skipped = (r && r.skipped) || 'unknown'
          continue
        }
        okSamples++
        modelInfo.asks = (modelInfo.asks || 0) + 1
        if (!modelInfo.model) { modelInfo.model = r.model; modelInfo.tokens = r.tokens }
        modelInfo.ms = (modelInfo.ms || 0) + (r.ms || 0)
        const rows = verdictsOf(r.value, mode)
        rawCount += rows.length
        for (const row of rows) {
          const i = row.index
          if (i < 0 || i >= sentences.length) continue
          if (!allow.some(s => s.idx === i)) continue   // 只认被问到的那几句，别把上下文当成表态
          const v = votes.get(i) || { yes: 0, no: 0, whys: [] }
          if (row.cut) { v.yes++; if (row.why) v.whys.push(row.why) } else v.no++
          votes.set(i, v)
        }
      }
    }
    if (!okSamples) {
      if (round === 0) log('选句：模型没接上（' + modelInfo.skipped + '），按确定性价值排序删')
      break
    }
    let added = 0
    for (const [i, v] of votes) {
      if (modelYes.has(i) || modelWeak.has(i)) continue
      const why = v.whys[0] || ''
      const row = { idx: i, text: sentences[i].bare.slice(0, 14), yes: v.yes, no: v.no }
      const ref = refused.find(x => x.idx === i)
      if (ref) {
        // 模型想删、规则不许：这是「模型提了什么、哪条规则打回」的证据，同时驱动第二轮
        if (v.yes >= minVotes) {
          ref.byModel = ref.byModel || why
          if (!blocked.includes(ref.text)) blocked.push(ref.text)
        }
        continue
      }
      if (v.yes >= minVotes) {
        const fit = reasonFits(sentences[i], why, sentences, dups)
        if (!fit.ok) {
          // 主张句（「才是」「真正的」「不是」…）连降档都不给：模型给的理由对不上，
          // 说明它没读懂这句在片子里的位置，这时候按「降一档也能删」处理，删掉的常是论点。
          const claim = CLAIM.find(c => sentences[i].bare.includes(c))
          if (claim) {
            modelBad.push({ idx: i, text: sentences[i].bare.slice(0, 18), why: '主张句（含「' + claim + '」）不走降档，理由又对不上', said: why })
            continue
          }
          // 理由对不上不等于这句不能删：把它降一档（只在「对得上的那几句不够」时才用），照实记下来
          modelBad.push({ idx: i, text: sentences[i].bare.slice(0, 18), why: fit.why, said: why })
          modelWeak.set(i, why)
          continue
        }
        modelYes.set(i, why || '模型判为可删')
        added++
        modelInfo.votes.push({ ...row, why })
      } else if (v.yes > 0) {
        // 有票但不够票：这就是「同一输入两次判得不一样」落在哪几句上的直接证据
        modelInfo.unstable.push({ ...row, why })
      }
    }
    modelInfo.picked = modelYes.size
    if (round === 0 && !modelYes.size && !blocked.length) {
      log('选句：模型没给出能用的句号（' + rawCount + ' 条表态里 0 条够票），按确定性价值排序再评一遍')
      break
    }
    if (round === 0 && !modelYes.size) {
      // 想删的都被规则挡住了：带着驳回理由再问一轮，只问剩下的允许句
      log('选句：模型想删的 ' + blocked.length + ' 句被规则挡住了，带着理由再问一轮')
      continue
    }
    if (round > 0 && !added) break
    const strong = cands.filter(s => modelYes.has(s.idx) || dups.includes(s.idx))
    best = chooseSubset({ candidates: strong, sentences, current, target, params: p, fragments })
    if (best && current - best.drop <= upper) break
  }

  // 模型挑的不够补差额：只用「理由对得上」的那几句删到哪算哪，宁可如实报差额，
  // 也不拿价值排序硬删——自测16 离线试跑里，硬删挑中的正好是「知道的人会做的人太少了」，
  // 那是全片的论点。删内容是编辑判断，判断没有就是没有，不能靠公式凑。
  if (!best || current - best.drop > upper) {
    const weak = cands.filter(s => modelWeak.has(s.idx) && !modelYes.has(s.idx))
    const b2 = chooseSubset({ candidates: [...cands.filter(s => modelYes.has(s.idx) || dups.includes(s.idx)), ...weak], sentences, current, target, params: p, fragments })
    if (b2 && (!best || b2.drop > best.drop)) { best = b2; widened = true }
    if (widened) log('选句：理由对得上的句子不够，动用了 ' + weak.length + ' 句「模型提了但理由对不上」的，成片 ' + round2(current - b2.drop) + 's')
  }

  const sourceOf = s => (dups.includes(s.idx) ? 'repeat' : (modelYes.has(s.idx) ? 'model' : (modelWeak.has(s.idx) ? 'model-weak' : 'rules')))
  const picks = best
    ? best.picked.map(i => {
      const s = sentences[i]
      const src = sourceOf(s)
      return {
        idx: i, i0: s.i0, i1: s.i1, text: s.bare, start: round3(s.start), dur: round2(s.dur),
        why: src === 'model' ? (modelYes.get(i) || '模型认为可以删')
          : src === 'repeat' ? '和前面说过的一句重复'
            : src === 'model-weak' ? '模型提了，但理由对不上（' + (modelWeak.get(i) || '') + '）'
              : '规则允许删',
        source: src,
      }
    }).sort((a, b) => a.start - b.start)
    : []

  const drop = picks.reduce((n, x) => n + x.dur, 0)
  const after = current - drop
  const hit = after <= upper
  // 「能删的都删完了」＝模型愿意删的整句已经全用上，还是超时。质检靠这一条判断「超时是真删不动」。
  const approved = cands.filter(s => modelYes.has(s.idx) || modelWeak.has(s.idx) || dups.includes(s.idx)).length
  const exhausted = after > upper && picks.length >= approved

  log('选句：' + sentences.length + ' 句里 ' + cands.length + ' 句可删（' + refused.length + ' 句不许删）' +
    (modelYes.size ? '；模型提了 ' + modelYes.size + ' 句' + (widened ? '（不够，降档补）' : '') : '；模型没提，不删内容') +
    (modelBad.length ? '；理由对不上句子被拒 ' + modelBad.length + ' 条' : '') +
    '；要删 ' + round2(need) + 's，选中 ' + picks.length + ' 句 ' + round2(drop) + 's' +
    (picks.length ? '：' + picks.map(x => '「' + x.text.slice(0, 10) + '」').join('、') : '') +
    '；成片 ' + round2(after) + 's / 目标 ' + target + 's' + (hit ? '' : '（还差 ' + round2(after - target) + 's，没有可删的整句了）'))

  return {
    ok: true,
    target,
    before: round2(current),
    after: round2(after),
    delta: round2(after - target),
    hit,
    exhausted,
    widened,
    sentences: sentences.length,
    candidates: cands.length,
    picks,
    refused: refused.slice(0, 40),
    refusedCount: refused.length,
    rejectedByReason: modelBad.slice(0, 20),
    model: modelInfo,
    candidatesAllowed: cands.length,
  }
}
