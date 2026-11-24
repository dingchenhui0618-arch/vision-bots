/**
 * 听音复核：把一小段音频重新交给一个更强的模型听，作为「音频里到底说了什么」的事实。
 *
 * 为什么要有这一层（自测13 追根因追出来的）：
 *   纠错四遍 + 第二意见全都只在**文本**上推理。ASR 吞字这一类错，文本里看不出少了字——
 *   素材里说的是「知道的人，会做的人太少了」，small 把它并成了「知道会做的人太少了」。
 *   这句话读得通，于是四遍全过；只有语义审读凭语感猜「应该是知道怎么做」，
 *   而音频里根本没有「怎么」（实测 42.60–42.88s 只有 0.28s 语音，后面 0.45s 是静音）。
 *   对这类错，唯一能当证据的东西是音频本身：换一个更强的模型重听同一段。
 *   实测 medium 在 42.32–44.58s 独立听到「知道的人会做的人太少了」（两段不同左上下文各听一次，
 *   「会」的置信度 0.83 / 0.97），与 small 差 2 字。这就是可以落地的证据。
 *
 * 规矩（和四遍纠错一样硬，破了就不许改）：
 *   1. 只在**同一句**里动字：整句起止时间不变，句外的词一个字节都不许动。
 *   2. 加字必须有「静音缝隙」接住：新词落进那个词槽内的数字静音段，不去挤占已有语音。
 *   3. 两次听必须逐字一致（不同左上下文，独立的两次解码），不一致就不算证据。
 *   4. 本机没有更强的模型就明说没跑，绝不拿 small 冒充第二意见——small 正是犯错的那个。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ff } from './ffmpeg.mjs'

const UV = join(homedir(), '.local', 'bin', 'uv.exe')
const PY = fileURLToPath(new URL('../tools/relisten.py', import.meta.url))
const HF = join(homedir(), '.cache', 'huggingface', 'hub')

const PUNCT = /[，。！？、；：,.!?;:""''（）()《》…—~·\s]/gu
export const strip = s => String(s ?? '').replace(PUNCT, '')

/** 听音复核的口径，集中一处，测试与实现共用。 */
export const R = {
  // 强耳朵：比 small 更强，可以在**有结构性证据（词槽吞了静音）**之外独立授权改字
  model: process.env.VISION_BOTS_RELISTEN_MODEL || 'medium',
  // 弱耳朵：还是 small，但用紧窗口 + float32 重听。它只能证明「音频不是模型猜的那样」，
  // 或者在词槽明显吞了静音时给补回来的字**命名**——不能单凭它改字（它就是犯错的那个模型）。
  weakModel: process.env.VISION_BOTS_RELISTEN_WEAK || 'small',
  weakCompute: 'int8',
  // 词槽吞静音的判据：一个词的时长超过「字数 × 每字 0.16s」的这么多倍，就算异常
  slotAnomaly: 2.0,
  charSecNominal: 0.16,
  compute: 'int8',
  // 两次听用不同的左上下文长度（同一个词在两个窗口里的位置不同，解码路径就不同）
  pads: [1.2, 2.4],
  // 句尾要多留一截：两个模型对词的起止时间能差 0.3–0.5s，只按句子末词 +0.8s 会把
  // 最后一个字切出窗口（实测「都是在做」的「做」在 pad 1.2 的窗口外，两次听就此不一致）
  tailPad: 0.8,
  // 句内低置信的判定：4 个词的窗口里有 2 个 p < LOW，就值得重听
  lowP: 0.65,
  lowWindow: 4,
  lowNeeded: 2,
  maxSpans: 5,
  // 加字：新字落进静音缝隙，缝隙要够长（按每字 0.10s 估）
  gapMin: 0.28,
  charSec: 0.10,
  hostKeepMin: 0.05,
  maxInsert: 3,
  maxDelete: 2,
  maxDelta: 3,
  // 一处「重说」（实测「指纹住在」→「专注在」）：整段塌成一个词，字数不必相等。
  // 上限按词数算而不是字数——中文 whisper 常常一字一词，「指纹住在」就是 3 个词。
  // 它只能吃整词，落地后还要整句逐字等于音频，否则整处撤回。
  maxRespeakWords: 3,
  maxRespeakChars: 4,
  // 静音缝隙后面是停顿：新词尾部补一个逗号，字幕才读得断
  commaGap: 0.30,
  // 文字对齐的最低相似度：低于这个就不认这段是我们要复核的句子
  cropMin: 0.6,
  timeoutMs: 10 * 60 * 1000,
}

// 强耳朵起不来（内存不够）就少试几次：每次失败要烧十几秒，一部片子要试好几处。
// 但不能一失败就永久放弃——内存会随机器负载变（实测同一台机 1.7GB 起不来、3.0GB 起得来）。
let STRONG_FAILS = 0
const STRONG_FAIL_CAP = 2

export function enabled() {
  return !/^(0|false|no|off)$/i.test(String(process.env.VISION_BOTS_RELISTEN ?? '1'))
}

/** 本机有没有这个模型（faster-whisper 会自己落到 HF 缓存里）。 */
export function modelAvailable(name = R.model) {
  try {
    return existsSync(join(HF, 'models--Systran--faster-whisper-' + name))
  } catch {
    return false
  }
}

function runStdinless(cmd, args, { timeout }) {
  return new Promise((resolve, reject) => {
    const ch = spawn(cmd, args, { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => { ch.kill(); reject(new Error('relisten 超时')) }, timeout)
    ch.stdout.setEncoding('utf8').on('data', d => { if (out.length < 1 << 20) out += d })
    ch.stderr.setEncoding('utf8').on('data', d => { if (err.length < 8192) err += d })
    ch.on('error', e => { clearTimeout(timer); reject(e) })
    ch.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err || 'exit ' + code))
    })
  })
}

function cacheKey(media, a, b, model, compute, hotwords = '') {
  const st = statSync(media)
  return createHash('sha1')
    .update(JSON.stringify([st.size, Math.round(st.mtimeMs), +a.toFixed(3), +b.toFixed(3), model, compute, hotwords]))
    .digest('hex')
    .slice(0, 20)
}

/**
 * 解码一个窗口（带缓存）。窗口用 [a, b] 秒，源时间；返回的词时间已换回源时间。
 * 缓存键里带素材尺寸/修改时间，素材换了自然失效。
 */
export async function decodeWindow({ media, a, b, model = R.model, compute = R.compute, cacheDir, hotwords = '', log = () => {} }) {
  if (!media || !existsSync(media)) return { ok: false, skipped: 'no-media', detail: String(media || '') }
  const dir = cacheDir || join(homedir(), '.cache', 'vision-bots-relisten')
  mkdirSync(dir, { recursive: true })
  const key = cacheKey(media, a, b, model, compute, hotwords)
  const cachePath = join(dir, key + '.json')
  if (existsSync(cachePath)) {
    try {
      return { ...JSON.parse(readFileSync(cachePath, 'utf8')), cached: true }
    } catch { /* 缓存坏了就当没有 */ }
  }
  const wav = join(dir, key + '.wav')
  const out = join(dir, key + '-asr.json')
  try {
    await ff(['-y', '-loglevel', 'error', '-ss', String(Math.max(0, a)), '-t', String(Math.max(0.2, b - a)), '-i', media, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
    const base = existsSync(UV)
      ? { cmd: UV, pre: ['run', '--python', '3.12', '--with', 'faster-whisper', '--with', 'av<14', '--with', 'opencc-python-reimplemented', 'python'] }
      : { cmd: 'python', pre: [] }
    const extra = hotwords ? ['--hotwords', hotwords] : []
    await runStdinless(base.cmd, [...base.pre, PY, '--audio', wav, '--out', out, '--model', model, '--compute', compute, ...extra], { timeout: R.timeoutMs })
    const j = JSON.parse(readFileSync(out, 'utf8'))
    const words = (j.words || []).map(w => ({ w: strip(w.w) || w.w, start: +(a + w.start).toFixed(3), end: +(a + w.end).toFixed(3), p: w.p }))
    const res = { ok: true, model, compute, window: [+a.toFixed(3), +b.toFixed(3)], words, text: strip(words.map(w => w.w).join('')) }
    writeFileSync(cachePath, JSON.stringify(res), 'utf8')
    return res
  } catch (err) {
    // 报错留最后一行的异常本体（「mkl_malloc: failed to allocate memory」这种），
    // 前面几十行 traceback 对排查没用，把原因截掉了等于没报
    const lines = String(err.message).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
    const why = lines.filter(l => /Error|Exception|error:/.test(l)).slice(-1)[0] || lines.slice(-1)[0] || 'unknown'
    return { ok: false, skipped: 'decode-failed', detail: why.slice(0, 220) }
  } finally {
    try { if (existsSync(wav)) { /* 留缓存，不删 */ } } catch { /* ignore */ }
  }
}

/** 最长公共子序列长度（纯字符，用来在两段读数之间找对齐）。 */
function lcsLen(a, b) {
  const n = a.length
  const m = b.length
  let prev = new Array(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    const cur = new Array(m + 1).fill(0)
    for (let j = 1; j <= m; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
    prev = cur
  }
  return prev[m]
}

/**
 * 把重听的词序列，对齐到「我们要复核的那句话」。
 *
 * 为什么不能按时长直接裁：两个模型对同一段音频的词边界能差 0.3–0.5s。
 * 实测 medium 读「知道的人会做的人太少了」，按 42.32–44.58 裁，会多带上一个字「容」、
 * 又丢掉尾巴的「了」，于是差异变成「删 9 字」——不是真的错，是裁剪把句子切歪了。
 *
 * 所以按**文字**对齐：在重听结果里找一段连续词，它的字符与这句话最像（LCS 比值最高），
 * 并且优先选「首尾字都对得上」的那段。找不到像的（最像也 <0.6）就返回空，绝不硬凑。
 */
export function alignCrop(expect, words, cfg = R, span = null) {
  const A = [...strip(expect)]
  const texts = (words || []).map(w => strip(w.w))
  if (!A.length || !texts.length) return null
  const cands = []
  for (let a = 0; a < texts.length; a++) {
    let acc = ''
    for (let b = a; b < texts.length; b++) {
      acc += texts[b]
      if (acc.length > A.length + 8) break
      if (!acc) continue
      const ch = [...acc]
      const lcs = lcsLen(A, ch)
      // 「覆盖」：这段读数有没有盖住整句的时间范围（起点不晚、终点不早）。
      // 少了第一个字的那种候选（实测「卷/捡」被丢掉，只剩「内容生产力」）不应该被选中——
      // 它让 LCS 比值更高（5/5=1.0 对 5/6=0.83），但那是把句子切短了，不是听得更准。
      const ws = words[a], we = words[b]
      const cover = span && ws && we ? (ws.start <= span[0] + 0.35 && we.end >= span[1] - 0.35) : true
      cands.push({
        a, b, text: acc,
        score: lcs / Math.max(ch.length, A.length),
        endsOk: ch[0] === A[0] && ch[ch.length - 1] === A[A.length - 1],
        cover,
      })
    }
  }
  if (!cands.length) return null
  cands.sort((x, y) => (Number(y.cover) - Number(x.cover)) || (Number(y.endsOk) - Number(x.endsOk)) || (y.score - x.score) || (x.text.length - y.text.length))
  const best = cands[0]
  if (best.score < (cfg.cropMin ?? 0.6)) return null
  return best
}

/** 窗口里落在 [t0, t1] 的词（按词的中点归属，避免边界把半个词算进来）。 */
export function cropWords(words, t0, t1) {
  return (words || []).filter(w => {
    const mid = (w.start + w.end) / 2
    return mid >= t0 - 1e-6 && mid <= t1 + 1e-6
  })
}

/**
 * 重听一句话：两个不同左上下文的窗口各听一次，逐字一致才算证据。
 * span 是这句话在**源时间**里的起止（词的起止，不是 whisper 段）。
 */
export async function relistenSentence({ media, span, cacheDir, model = R.model, tier = 'auto', hotwords = '', expect = null, log = () => {} }) {
  if (!enabled()) return { ok: false, skipped: 'disabled' }
  const [t0, t1] = span
  const listen = async (m, compute) => {
    const decodes = []
    let lastErr = null
    for (const pad of R.pads) {
      const r = await decodeWindow({ media, a: Math.max(0, t0 - pad), b: t1 + pad + (R.tailPad || 0), model: m, compute, cacheDir, hotwords, log })
      if (!r.ok) { lastErr = r; continue }   // 一个窗口起不来不算全废：另一个窗口的意见仍然有用（标 single）
      // 有「要复核的那句话」时按文字对齐（抗两个模型词边界差 0.3–0.5s），否则按时长裁
      let ws = cropWords(r.words, t0, t1)
      let text = strip(ws.map(w => w.w).join(''))
      if (expect) {
        const al = alignCrop(expect, r.words, R, [t0, t1])
        if (al) {
          ws = r.words.slice(al.a, al.b + 1)
          text = al.text
        }
      }
      decodes.push({ pad, text, words: ws, cached: !!r.cached })
    }
    if (!decodes.length) return { ok: false, skipped: (lastErr && lastErr.skipped) || 'decode-failed', detail: lastErr && lastErr.detail, model: m }
    const texts = decodes.map(d => d.text)
    const agree = decodes.every(d => d.text === decodes[0].text) && decodes[0].text.length > 0
    // 两个窗口只差**句外**切进来的一两个字时（实测「圈」被窗口边界带进来、因此两读不同），
    // 按重叠部分算一致：以最短的那次为准，其余必须包含它，且多出来的字只能贴在两端。
    const base = texts.slice().sort((x, y) => x.length - y.length)[0] || ''
    const loose = !agree && base.length >= 2 && texts.every(t => t === base || t.endsWith(base) || t.startsWith(base))
    return { ok: true, agree, loose, base, decodes, single: decodes.length < R.pads.length }
  }

  // 先用强耳朵。装不上（没下模型 / 内存不够起不来）就退到弱耳朵，并且如实标出来是哪一档——
  // 弱耳朵能证明的只有「音频不是那样」，不能单凭它改字（见文件头第 4 条）。
  let used = null
  let fell = null
  if (tier !== 'weak') {
    if (!modelAvailable(model)) {
      fell = { skipped: 'no-strong-model', detail: '本机没有 faster-whisper ' + model }
    } else if (STRONG_FAILS >= STRONG_FAIL_CAP) {
      fell = { skipped: 'strong-unavailable', detail: '本轮强耳朵已经连续 ' + STRONG_FAILS + ' 次起不来（多半是内存不够），不再重试' }
    } else {
      const r = await listen(model, R.compute)
      if (r.ok) { used = { tier: 'strong', model, compute: R.compute, ...r }; STRONG_FAILS = 0 }
      else { fell = { skipped: r.skipped, detail: r.detail, model }; STRONG_FAILS++ }
    }
  }
  if (!used) {
    const weakModel = R.weakModel
    const r = await listen(weakModel, R.weakCompute)
    if (!r.ok) {
      return { ok: false, skipped: r.skipped === 'decode-failed' ? (fell ? fell.skipped : r.skipped) : r.skipped, detail: fell ? fell.detail : r.detail, model: weakModel, strongTried: fell }
    }
    used = { tier: 'weak', model: weakModel, compute: R.weakCompute, ...r, strongTried: fell }
  }
  return {
    ok: true, tier: used.tier, model: used.model, compute: used.compute, span,
    agree: used.agree, single: Boolean(used.single), loose: Boolean(used.loose),
    text: used.agree ? used.decodes[0].text : (used.loose ? used.base : null),
    decodes: used.decodes.map(d => ({ pad: d.pad, text: d.text, cached: d.cached })),
    words: used.decodes[0].words,
    note: used.tier === 'weak'
      ? '这一档是弱耳朵（' + used.model + ' 紧窗口重听）：只能证明「音频不是模型猜的那样」，单独不许作为改字依据' +
        (fell ? '；强耳朵没跑成：' + (fell.skipped || '') + (fell.detail ? '（' + String(fell.detail).split('\n')[0].slice(0, 60) + '）' : '') : '')
      : null,
  }
}

/** 词槽是否「明显吞了静音」：时长相对字数太长，且内部有 ≥gapMin 的静音。纯函数。 */
export function slotAnomaly({ start, end, chars, gaps }, cfg = R) {
  const n = Math.max(1, Number(chars) || 1)
  const sec = end - start
  const ratio = sec / (n * cfg.charSecNominal)
  const gap = (gaps || []).filter(g => g.e - g.s >= cfg.gapMin - 1e-6).sort((a, b) => (b.e - b.s) - (a.e - a.s))[0] || null
  return { ratio: +ratio.toFixed(2), anomaly: ratio >= cfg.slotAnomaly && Boolean(gap), gap }
}

/** 两段文本的差异：必须是一处连续的增/删/换，且不超预算。纯函数，可单测。 */
export function charDiff(cur, audio, cfg = R) {
  const a = strip(cur)
  const b = strip(audio)
  if (a === b) return { same: true, at: 0, del: 0, ins: '' }
  const A = [...a]
  const B = [...b]
  let pre = 0
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++
  let suf = 0
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++
  const del = A.length - pre - suf
  const ins = B.slice(pre, B.length - suf).join('')
  const insN = [...ins].length
  // 粗口径只拦「一次动太多」的越权改写。能不能落地由 planRepair 按四档分别判：
  //   等字数替换 / 补字（要落进静音缝隙）/ 删字（只能吃整词）/ 一处重说（整段塌成一个词）。
  // 以前这里一刀切 del>2 就打回，于是「指纹住在→专注在」这类整句重说永远轮不到音频说话。
  if (del > cfg.maxRespeakChars) return { error: '删 ' + del + ' 个字，超过听音复核 ' + cfg.maxRespeakChars + ' 个字的预算' }
  if (insN > cfg.maxInsert) return { error: '加 ' + insN + ' 个字，超过 ' + cfg.maxInsert + ' 个字的预算' }
  if (del + insN > cfg.maxRespeakChars + cfg.maxInsert) return { error: '一次动 ' + (del + insN) + ' 个字，超过听音复核的预算' }
  return { at: pre, del, ins }
}

/**
 * 把差异落成词级改法。ws 是这句现在的词 [{i, core, start, end}]，gapsOf(i) 给词槽内的静音段。
 * 只产出「怎么改」，不碰 words 本身；落地在 asr-fix 里做，方便单测。
 */
export function planRepair({ ws, diff, gapsOf, cfg = R }) {
  if (!diff || diff.same) return { ok: false, why: '没有差异' }
  if (diff.error) return { ok: false, why: diff.error }
  const bounds = [0]
  for (const w of ws) bounds.push(bounds[bounds.length - 1] + [...w.core].length)
  const b = bounds.indexOf(diff.at)
  if (b < 0) return { ok: false, why: '改动点切在词的中间（第 ' + diff.at + ' 个字），会把半个词改成别的字' }
  if (diff.del > 0 && diff.ins && diff.del === [...diff.ins].length) {
    // 等字数替换（捡→卷）：不增不减，所以不需要静音缝隙，但必须整词替换、不拆词
    const eaten = []
    let left = diff.del
    for (let k = b; k < ws.length && left > 0; k++) {
      const n = Math.min(left, [...ws[k].core].length)
      eaten.push({ i: ws[k].i, n, full: n === [...ws[k].core].length, core: ws[k].core })
      left -= n
    }
    if (left > 0) return { ok: false, why: '替换越过了句尾' }
    if (eaten.some(e => !e.full)) return { ok: false, why: '替换切在词中间，v1 不拆词' }
    const chars = [...diff.ins]
    let at = 0
    const parts = eaten.map(e => {
      const len = [...e.core].length
      const to = chars.slice(at, at + len).join('')
      at += len
      return { i: e.i, from: e.core, to }
    })
    return { ok: true, op: 'sub', parts }
  }
  if (diff.del > 0 && diff.ins) {
    // 一处重说（实测「指纹住在」→「专注在」4 字变 3 字）：整段塌成**一个**词。
    // 它不拆词、不改句子起止（新词起点就是第一个被吃词的起点），也不动句外的任何时间码；
    // 落地后还必须整句逐字等于音频，否则整处撤回。所以门槛按「吃掉几个词」算，不按字数算。
    const eaten = []
    let left = diff.del
    for (let k = b; k < ws.length && left > 0; k++) {
      const n = Math.min(left, [...ws[k].core].length)
      eaten.push({ i: ws[k].i, n, full: n === [...ws[k].core].length, core: ws[k].core })
      left -= n
    }
    if (left > 0) return { ok: false, why: '重说越过了句尾' }
    if (eaten.some(e => !e.full)) return { ok: false, why: '重说切在词中间，这一档不拆词' }
    if (eaten.length > (cfg.maxRespeakWords ?? 2)) return { ok: false, why: '重说吃掉 ' + eaten.length + ' 个词，超过 ' + (cfg.maxRespeakWords ?? 2) + ' 个词的预算' }
    return { ok: true, op: 'respeak', at: b, eaten, ins: diff.ins }
  }
  if (diff.ins) {
    // 加字：新字放在 b 那个词槽的最前面，词槽内的静音缝隙接住它
    const host = ws[b]
    if (!host) return { ok: false, why: '加字点在句尾，没有词槽可以接' }
    const ins = [...diff.ins].length
    const gaps = (gapsOf ? gapsOf(host.i) : []) || []
    const fits = gaps
      .filter(g => g.s >= host.start + cfg.hostKeepMin && g.s <= host.end - cfg.hostKeepMin)
      .filter(g => g.s - host.start >= Math.max(cfg.gapMin, ins * cfg.charSec) - 1e-6)
      .filter(g => g.e - g.s >= cfg.gapMin - 1e-6)
      .sort((x, y) => (y.e - y.s) - (x.e - x.s))[0]
    if (!fits) {
      return { ok: false, why: '词「' + host.core + '」槽 ' + host.start.toFixed(2) + '–' + host.end.toFixed(2) + 's 内没有 ≥' + cfg.gapMin + 's 的静音缝隙来接住新字，硬塞会挤掉原有语音' }
    }
    const comma = (fits.e - fits.s) >= cfg.commaGap - 1e-6 || (host.end - fits.s) >= cfg.commaGap - 1e-6
    return {
      ok: true, op: 'insert', host: host.i, at: b,
      // host 槽切成两段：前半段给新词（语音在前），后半段仍是 host（静音被它吸收）
      newWord: { w: diff.ins + (comma ? '，' : ''), start: +host.start.toFixed(3), end: +fits.s.toFixed(3) },
      hostStart: +fits.s.toFixed(3),
      gap: [+fits.s.toFixed(3), +fits.e.toFixed(3)],
      comma,
    }
  }
  if (diff.del > 0) {
    // 删字：从 b 起往后吃掉 del 个字，吃空的词整个删掉，它的时间并给前一个词
    if (diff.del > cfg.maxDelete) return { ok: false, why: '删字 ' + diff.del + ' 个，超过 ' + cfg.maxDelete + ' 个的预算' }
    let left = diff.del
    const eaten = []
    for (let k = b; k < ws.length && left > 0; k++) {
      const n = Math.min(left, [...ws[k].core].length)
      eaten.push({ i: ws[k].i, n, full: n === [...ws[k].core].length })
      left -= n
    }
    if (left > 0) return { ok: false, why: '删字越过了句尾' }
    return { ok: true, op: 'delete', at: b, eaten }
  }
  return { ok: false, why: '没有可落地的改动' }
}

/** 句子视图里，这个词槽内的静音段（由调用方用能量包络量出来）。 */
export function silentGaps(envelope, start, end, { threshDb = -34, minSec = 0.08 } = {}) {
  const out = []
  if (!envelope || !envelope.db) return out
  const { db, hopSec } = envelope
  const i0 = Math.max(0, Math.floor(start / hopSec))
  const i1 = Math.min(db.length - 1, Math.ceil(end / hopSec))
  let runStart = -1
  for (let i = i0; i <= i1; i++) {
    const quiet = db[i] < threshDb
    if (quiet && runStart < 0) runStart = i
    if ((!quiet || i === i1) && runStart >= 0) {
      const s = runStart * hopSec
      const e = (quiet && i === i1 ? i : i - 1) * hopSec
      if (e - s >= minSec) out.push({ s: +s.toFixed(3), e: +e.toFixed(3) })
      runStart = -1
    }
  }
  return out
}
