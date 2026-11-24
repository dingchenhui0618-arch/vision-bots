/**
 * 折光 · scene.json —— 版式编排（pages / shots / bigs / blocks）由词级时间戳 + 段落 + EDL 推导，
 * 版式意图与章节名来自剪辑的分镜提案（src/shots.mjs，已过校验），这里只负责把意图落成时间窗口。
 *
 * 对齐用户给的折光案例（成片.mp4，720×1280，70.5s）：
 *   · 常驻 HUD：左上页码、右上品牌胶囊 + 时间码、底部细进度线
 *   · 章节卡：绿色两位数字 + 白色章节名 + 小字眉，页边界必落
 *   · 大字是语义强调卡（一行一条、逐行上屏），关键词用黄 / 荧光绿底 / 红底反白
 *   · 图形块：标签墙、刻度卡、对勾卡、红条打叉、名片卡
 *   · 版式六种轮换：满幅 / 竖框居中 / 右上小窗 / 全屏字卡 / 章节卡 / 结尾画中画
 *
 * 硬规矩：
 *   1. 上屏的每个字都必须来自这一步的原话：章节名、大字、图形块里的词都过 insideSentence 检查；
 *   2. 图形块里不写任何原话里没有的数字——刻度卡的填充只是「越来越低」的示意，不带数值标签；
 *   3. 版式只由数据决定（哪张卡短、哪段在列举、哪句在转折、满幅是不是太久了），不按时间硬切。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { segment, wrapWords } from '../../src/segment.mjs'
import { pageSkeleton, bare } from '../../src/pages.mjs'
import { HEADLINE, insideSentence, checkHeadline, pickHeadline } from '../../src/headlines.mjs'

const round = (n, k = 3) => Number(n.toFixed(k))
const chW = ch => (/[\x00-\xff]/.test(ch) ? 0.56 : 1)
export const textEm = s => [...String(s)].reduce((n, ch) => n + chW(ch), 0)

const TERMS = (() => {
  try {
    const p = fileURLToPath(new URL('../../config/terms.json', import.meta.url))
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    const list = [...(j.hotwords || []), ...(j.terms || []).map(t => t.to)].filter(Boolean)
    return [...new Set(list)].sort((a, b) => b.length - a.length)
  } catch { return [] }
})()

/** 成片时间 t → 源时间 s（EDL 是唯一真相） */
export function sourceAt(plan, t) {
  const { keep, options } = plan
  let acc = 0
  for (const [a, b] of keep) {
    const d = (b - a) / options.speed
    if (t <= acc + d) return a + (t - acc) * options.speed
    acc += d
  }
  return keep.at(-1)[1]
}

/** 每条保留段在成片里的位置；抽帧按它切，帧号才对得上。 */
export function frameRanges(plan, fps) {
  const { keep, options } = plan
  const ranges = []
  let outF = 0
  let srcF = 0
  for (const [a, b] of keep) {
    const outCount = Math.max(1, Math.round(((b - a) / options.speed) * fps))
    const srcCount = Math.max(1, Math.round((b - a) * fps))
    ranges.push({ outF0: outF, outF1: outF + outCount, srcF0: srcF, srcCount, speed: options.speed, srcSec: a, durSec: b - a })
    outF += outCount
    srcF += srcCount
  }
  return ranges
}

/** 字幕里的高亮片段：只认术语表里的词和阿拉伯数字/英文串，不改一个字 */
export function markRuns(text, hotWord = '') {
  const kws = [hotWord, ...TERMS].filter(Boolean).sort((a, b) => b.length - a.length)
  const runs = []
  let i = 0
  const push = (t, style) => {
    if (!t) return
    const last = runs[runs.length - 1]
    if (last && last.style === style) last.text += t
    else runs.push({ text: t, style })
  }
  while (i < text.length) {
    const kw = kws.find(k => k && text.startsWith(k, i))
    if (kw && kw.length >= 2) { push(kw, 'hot'); i += kw.length; continue }
    const m = /^[A-Za-z0-9][A-Za-z0-9.+#%]*/.exec(text.slice(i))
    if (m && m[0].length >= 2) { push(m[0], 'num'); i += m[0].length; continue }
    push(text[i], 'plain'); i += 1
  }
  return runs
}

/** 确定性强调：否定句进红底，数字/术语进荧光绿底，其余挑最长的实词上黄字 */
export function emphasize(text) {
  const t = String(text || '')
  const neg = /不是|不要|别再|别去|不能/.exec(t)
  if (neg) return { hot: neg[0], style: 'redBox' }
  const num = /[0-9]+[天周月年万亿%]?/.exec(t)
  if (num && num[0].length >= 2) return { hot: num[0], style: 'limeMark' }
  const hotTerm = TERMS.find(k => k.length >= 2 && t.includes(k))
  if (hotTerm) return { hot: hotTerm, style: 'limeMark' }
  return { hot: '', style: 'plain' }
}

const SHOT_LABEL = { full: '满幅', frame: '竖框居中', corner: '右上小窗', card: '全屏字卡', outro: '画中画' }
const PUNCT_END = /[，。！？、；：]/
const cleanShort = (t, max) => {
  const n = bare(t).length
  return n >= 2 && n <= max && !PUNCT_END.test(t)
}

export function buildScene({ words, segments, plan, brief = {}, tpl, cards = [], ratio = null }) {
  const t = tpl
  const fps = t.spec.fps
  const layouts = t.layouts || {}
  const RATIO = (ratio && layouts[ratio]) ? ratio : (layouts[t.ratio] ? t.ratio : (Object.keys(layouts)[0] || '9:16'))
  const L = layouts[RATIO] || { size: [1080, 1920] }
  const ranges = frameRanges(plan, fps)
  const totalFrames = ranges.reduce((n, r) => n + (r.outF1 - r.outF0), 0)
  const duration = totalFrames / fps

  const beats = (cards || []).map(c => ({
    text: c.text,
    f0: round(c.start),
    f1: round(Math.max(c.start + 0.35, c.end)),
    chars: (c.chars || []).map(k => ({ ch: k.ch, f0: round(k.f0), f1: round(k.f1) })),
  })).filter(c => c.text && c.f1 > c.f0)

  // 全片词频：小标签只挂「这条片子里说过两次以上」的实词（说话人自己重复过的才是重点）。
  const globalFreq = new Map()
  for (const s of (segments || [])) {
    for (const tok of segment(bare(s.text || ''))) globalFreq.set(tok, (globalFreq.get(tok) || 0) + 1)
  }

  // ── 页：和分镜共用同一份骨架（src/pages.mjs），页边界只有一处 ──
  const pagesRaw = pageSkeleton({
    segments, plan, duration, hotwords: TERMS,
    cards: beats.map(b => ({ text: b.text, start: b.f0, end: b.f1 })),
  })

  // 分镜提案（已过校验）按页号并进来：标题、小字眉、版式意图、强调词、图形块
  const props = new Map()
  const shotPlan = brief.shots && Array.isArray(brief.shots.pages) ? brief.shots.pages : []
  for (const p of shotPlan) if (p && Number.isInteger(Number(p.index))) props.set(Number(p.index), p)
  for (const p of pagesRaw) {
    const pr = props.get(p.index)
    if (!pr) continue
    if (pr.title && String(p.text).includes(pr.title)) p.title = pr.title
    if (pr.eyebrow && String(p.text).includes(pr.eyebrow)) p.eyebrow = pr.eyebrow
    p.intent = pr.shot || 'full'
    p.block = pr.block || null
    p.emph = pr.emph || ''
  }

  const shots = [{ f0: 0, f1: round(duration), kind: 'full', why: '默认满幅' }]
  const cut = (f0, f1, kind, why) => {
    const a = Math.max(0, f0), b = Math.min(duration, f1)
    if (b - a < 1.4) return false
    const out = []
    for (const s of shots) {
      if (s.f1 <= a || s.f0 >= b) { out.push(s); continue }
      if (s.f0 < a) out.push({ ...s, f1: a })
      // 0.001 的容差：shots 的时间 round 到 3 位小数，duration 没有，直接比会留下一条零长度的尾段
      // （自测18 的末尾那条 59.3667–59.367 full 就是这么来的，它让「结尾一定是画中画」这条断言假失败）
      if (s.f1 - b > 0.001) out.push({ ...s, f0: b })
    }
    out.push({ f0: round(a), f1: round(b), kind, why })
    shots.length = 0
    shots.push(...out.sort((x, y) => x.f0 - y.f0))
    return true
  }

  // ── 先落分镜意图：card / frame / corner 各自在自己这一页里找窗口 ──
  const frameWindow = new Map()
  for (const p of pagesRaw) {
    const kind = p.intent || 'full'
    if (kind === 'full') continue
    if (kind === 'card') {
      // 色卡上排的是大字（一屏最多 3 行），不是字幕：4–12 字的一句原话就够。
      // 6 字那条线是照着「一句金句」想的，真实口播里 10 个字的金句到处都是，
      // 结果是自测 03–10 一条片子都没出过全屏色卡——参考片最抓眼的动作我们一次都没做。
      const asked = bare(p.cardText || '')
      const host = (p.cards || []).find(c => asked && bare(c.text).includes(asked) && c.f1 - c.f0 >= 0.7)
      const g = host || (p.cards || []).find(c => cleanShort(c.text, 12) && c.f1 - c.f0 >= 0.9)
      if (g && cut(g.f0, Math.min(p.end, g.f1 + 0.9), 'card', '分镜：金句「' + g.text + '」占满屏')) p.cardUsed = true
      continue
    }
    if (kind === 'frame') {
      // 连续短句 = 在列举：找到最长的一段
      let best = null
      let run = []
      for (const c of (p.cards || [])) {
        if (cleanShort(c.text, 10)) {
          if (!run.length) run = [c]
          else if (c.f0 - run[run.length - 1].f1 < 0.9) run.push(c)
          else run = [c]
          const span = run[run.length - 1].f1 - run[0].f0
          if (run.length >= 2 && span >= 2.0 && (!best || span > best.span)) best = { from: run[0].f0, to: run[run.length - 1].f1, span }
        } else run = []
      }
      const w = best || (() => {
        const cs = (p.cards || []).slice(0, 2)
        if (cs.length === 2) return { from: cs[0].f0, to: cs[1].f1 }
        const c = cs[0]
        return { from: c ? c.f0 : p.start, to: c ? Math.max(c.f1, c.f0 + 2) : p.start + 2.4 }
      })()
      if (cut(w.from - 0.3, Math.min(p.end, w.to + 0.6), 'frame', '分镜：这一页在列举，人物收进竖框')) {
        frameWindow.set(p.index, { from: w.from - 0.3, to: Math.min(p.end, w.to + 0.6) })
      }
      continue
    }
    if (kind === 'corner') {
      const turn = (p.cards || []).find(c => /^(但是|所以|因为|其实|就是|而且|结果)/.test(bare(c.text)))
      const c = turn || (p.cards || [])[0]
      if (c) cut(c.f0 - 0.2, c.f1 + 0.45, 'corner', '分镜：这一页让位给字')
    }
  }

  // ── 模型没给（或给了 full）的页：按内容补节奏 ──
  // 参考片的构图每 4–5 秒就变一次（切点密度 0.20–0.23/s）；我们原来把「满幅连续 11 秒」当触发线，
  // 一页 8.8 秒根本触发不了，全片只有 8 个切点（0.13/s，自测22 唯一出档的一项）。
  // 触发线放到 7.2 秒、步长 6 秒：一页说满六七秒就换一次构图呼吸，和参考片同一个量级；
  // 仍然只在真有一句字幕卡落在那儿时才切，不硬切。
  for (const s of shots.filter(x => x.kind === 'full')) {
    let cursor = s.f0
    while (s.f1 - cursor > 7.2) {
      const at = cursor + 6
      // 先看有没有金句能占一整屏（这是参考片最抓眼的那个动作），没有再换小窗
      const gold = beats.find(x => x.f0 >= at && x.f0 < at + 4.5 && cleanShort(x.text, 12) && x.f1 - x.f0 >= 0.8)
      if (gold && shots.filter(y => y.kind === 'card').length < 2) {
        const to = Math.min(s.f1, Math.max(gold.f1 + 0.9, gold.f0 + 1.8))
        if (cut(gold.f0, to, 'card', '节奏：金句「' + gold.text + '」占满屏')) { cursor = gold.f0 + 1.8; continue }
      }
      const b = beats.find(x => x.f0 >= at && x.f0 < at + 3.2)
      if (!b) break
      if (shots.filter(y => y.kind === 'corner').length >= 4) break
      if (!cut(b.f0 - 0.15, Math.min(s.f1, b.f1 + 0.6), 'corner', '满幅超过 7 秒，换一次版式呼吸')) break
      cursor = b.f0 + 2.5
    }
  }
  // 兜底节奏：参考片的签名是「一两次全屏字卡 + 一次竖框」。模型没给就引擎补一次，
  // 不硬塞：页里真有一句 6 字以内的金句才补，否则宁可不补。
  if (duration > 25 && !shots.some(s => s.kind === 'card')) {
    const g = beats.find(b => cleanShort(b.text, 12) && b.f1 - b.f0 >= 1.0 && b.f0 > duration * 0.18 && b.f0 < duration * 0.85)
    if (g) cut(g.f0, Math.min(duration - 1, Math.max(g.f1 + 0.9, g.f0 + 1.8)), 'card', '引擎补节奏：金句「' + g.text + '」占满屏')
  }
  if (duration > 35 && !shots.some(s => s.kind === 'frame')) {
    let run = []
    for (let i = 0; i < beats.length; i++) {
      const b = beats[i]
      if (cleanShort(b.text, 10)) {
        if (!run.length) run = [b]
        else if (b.f0 - run[run.length - 1].f1 < 0.9) run.push(b)
        else run = [b]
        if (run.length >= 2 && run[run.length - 1].f1 - run[0].f0 >= 2.2) {
          cut(run[0].f0 - 0.3, Math.min(duration - 1, run[run.length - 1].f1 + 0.6), 'frame', '引擎补节奏：短句在列举，人物收进竖框')
          break
        }
      } else run = []
    }
  }
  if (duration > 20) cut(Math.max(duration - 2.6, duration * 0.92), duration, 'outro', '收尾画中画')

  // ── 大字：一句一张卡，一行一条；每条最多挑一处上色 ──
  const headTitles = new Map((brief.sentenceTitles || []).filter(x => x && x.ok === true).map(x => [Number(x.index), String(x.text || '')]))
  const bigL = L.big || {}
  const bigLines = (text) => {
    let per = 7
    let out = wrapWords(text, per)
    while (out.length > (bigL.maxLines || 3) && per < 16) { per += 1; out = wrapWords(text, per) }
    return out
  }
  // 折行只是「一屏放不下」的妥协，不是句读：能并回一行就并回去。
  // 自测08 的抽帧里「机会在 / OPC / 内容」被排成三行堆叠——明明一行就放得下，
  // 结果大字看起来像字幕、还爬到人物下巴上。并行的上限是：并完仍能以 bigMin 排满整幅宽。
  const emWidth = (str) => [...String(str)].reduce((n, ch) => n + (/[\x00-\xff]/.test(ch) ? 0.56 : 1), 0)
  const mergeLines = (lines) => {
    const avail = ((L.size && L.size[0]) || 1080) - (bigL.left || 62) - (bigL.right || 150)
    const out = []
    for (const ln of lines) {
      const last = out.length - 1
      if (last >= 0 && emWidth(out[last] + ln) <= avail / Math.max(1, t.type && t.type.bigMin || 64)) { out[last] += ln; continue }
      out.push(ln)
    }
    return out
  }
  const bigs = []
  beats.forEach((s, i) => {
    const next = beats[i + 1]
    const f0 = round(s.f0)
    const f1 = round(Math.min(next ? next.f0 : duration, Math.max(s.f1, s.f0 + 0.35)))
    if (f1 - f0 < 0.05) return
    if ((next ? next.f0 : s.f1) - s.f0 < HEADLINE.minSec) return
    const asked = headTitles.get(i + 1)
    const text = asked && insideSentence(asked, s.text) && checkHeadline(asked, s.text).ok ? asked : pickHeadline(s.text)
    if (!text) return
    const page = pagesRaw.find(p => s.f0 >= p.start - 0.35 && s.f0 < p.end) || pagesRaw[0]
    const auto = emphasize(text)
    const emph = page && page.emph && text.includes(page.emph) ? page.emph : ''
    const firstOfPage = !bigs.some(x => x.page === (page ? page.index : 1))
    let style = 'plain'
    if (emph) style = /不是|不要|别再|别去|不能/.test(emph) ? 'redBox' : (/[0-9]/.test(emph) ? 'limeMark' : 'yellow')
    else if (auto.style === 'redBox' || auto.style === 'limeMark') style = auto.style
    else if (auto.style === 'yellow' && firstOfPage) style = 'yellow'
    const hot = style === 'redBox' ? (emph || auto.hot) : style === 'plain' ? '' : (emph || auto.hot)
    bigs.push({
      index: bigs.length + 1, beat: i, text,
      hot: hot || '', style,
      words: segment(text),
      lines: mergeLines(bigLines(text)),
      f0, f1,
      page: page ? page.index : 1,
      pageTitle: page ? page.title : '',
      pageEyebrow: page ? page.eyebrow : '',
      lineIn: 0.10,
    })
  })

  // ── 图形块：只用原话里出现过的词，绝不写原话没有的数字 ──
  const blocks = []
  for (const p of pagesRaw) {
    const b = p.block
    if (!b || b.kind === 'none') continue
    const cards = p.cards || []
    if (b.kind === 'tagwall') {
      const w = frameWindow.get(p.index) || (() => {
        const s = shots.find(x => x.f0 >= p.start - 0.5 && x.f0 < p.end && (x.kind === 'frame' || x.kind === 'corner'))
        return s ? { from: s.f0, to: s.f1 } : null
      })()
      if (w && Array.isArray(b.items) && b.items.length >= 3) {
        blocks.push({ kind: 'tagwall', f0: w.from + 0.15, f1: w.to - 0.1, items: b.items.slice(0, 8), at: 'frame' })
      }
      continue
    }
    const hit = cards.find(c => b.text && bare(c.text).includes(bare(b.text))) || cards[0]
    // 图形块不能排进全屏字卡里：色卡是一整块纯底 + 一句大字，上面不叠任何块
    // （film.js 的 draw() 里也是直接跳过）。以前只按「这一页的第一张卡」定时，
    // 卡刚好落在色卡区间时，块就被排进色卡——白排一个，而且自检只看数据是看不出来的。
    const at0 = hit ? hit.f0 : p.start + 0.4
    const atCard = shots.find(s => at0 >= s.f0 && at0 < s.f1)
    let at = at0
    if (atCard && atCard.kind === 'card') {
      const next = shots.find(s => s.f0 >= atCard.f1 && s.kind !== 'card')
      const prev = [...shots].reverse().find(s => s.f1 <= atCard.f0 && s.kind !== 'card')
      at = next ? next.f0 + 0.15 : prev ? Math.max(prev.f0 + 0.2, prev.f1 - 3.2) : null
    }
    if (at == null) continue
    if (b.kind === 'check') blocks.push({ kind: 'check', f0: at + 0.15, f1: Math.min(at + 3.0, duration - 0.6), text: b.text, at: 'bottom' })
    else if (b.kind === 'banner') {
      // 红条是横向满宽的一条，只能压在满幅上；这一页如果换了版式，就挪到最近的一段满幅
      const here = shots.find(s => at >= s.f0 && at < s.f1)
      const full = (here && here.kind === 'full') ? here
        : shots.find(s => s.kind === 'full' && s.f1 > p.start && s.f0 < p.end)
      if (full) blocks.push({ kind: 'banner', f0: Math.max(full.f0 + 0.3, p.start + 0.2), f1: Math.min(Math.max(full.f0 + 2.6, p.start + 2.0), duration - 0.4), text: b.text, at: 'center' })
    }
    else if (b.kind === 'gauge') blocks.push({ kind: 'gauge', f0: at + 0.1, f1: Math.min(at + 4.0, duration - 0.6), label: b.label || '门槛', at: 'mid' })
  }
  // 分镜一条都没给（模型不可用）时的确定性兜底：别让画面从头到尾一个构图
  if (!shotPlan.length) {
    const gaugeBeat = beats.find(x => /门槛|越来越低|越来越难/.test(x.text))
    if (gaugeBeat) {
      // 同一条规矩：兜底路径也不许把块排进全屏字卡（06 群就是兜底路径撞上的）
      const c0 = gaugeBeat.f0 + 0.1
      const hitCard = shots.find(s => c0 >= s.f0 && c0 < s.f1 && s.kind === 'card')
      const next = hitCard && shots.find(s => s.f0 >= hitCard.f1 && s.kind !== 'card')
      if (!hitCard) blocks.push({ kind: 'gauge', f0: c0, f1: Math.min(gaugeBeat.f1 + 3.6, duration - 0.6), label: '门槛', at: 'mid' })
      else if (next) blocks.push({ kind: 'gauge', f0: next.f0 + 0.15, f1: Math.min(next.f0 + 4.0, duration - 0.6), label: '门槛', at: 'mid' })
    }
    const banBeat = beats.find(x => /^(别再|不要|别去|不用)/.test(bare(x.text)) && bare(x.text).length <= 10)
    if (banBeat) {
      const full = shots.find(s => s.kind === 'full' && banBeat.f0 >= s.f0 && banBeat.f0 < s.f1)
      if (full) blocks.push({ kind: 'banner', f0: Math.max(banBeat.f0, full.f0 + 0.2), f1: Math.min(banBeat.f1 + 1.2, full.f1 - 0.1, duration - 0.4), text: banBeat.text, at: 'center' })
    }
  }
  // 品牌胶囊不能空：参考片的右上角一直是「● 项目名 + 时间码」，空着只剩时间码就不成胶囊。
  // 但品牌名 ≠ 出镜人的名字——把它填进名牌卡等于替人署名，所以这两个字段分开：
  // brand 只进 HUD，avatar 只在真的知道出镜人名字时才画。
  const brand = brief.brand || 'Vision Bots'
  const author = brief.author || brief.account || ''
  if (author) blocks.push({ kind: 'avatar', f0: Math.max(duration - 5.4, 0), f1: Math.max(duration - 2.8, 0.5), name: author, role: '', at: 'left' })

  // ── 小标签（chips）：把已经认定为重点的词，按「说过就留在屏上」的节奏挂到画面两侧 ──
  // 折光的密度不靠字号，靠粒度：一句话一个词条，冒出来就不走，几秒后屏上叠着三五张。
  // 我们的图形块是段落级的（一页 ~5 秒最多一个），密度永远追不上。
  // 但「密度」不能靠编：这一版只挂三类词——术语表里的词、拉丁专名（GPT / Claude / Codex）、
  // 以及这条片子里已经被挑成大字高亮的词（bigs[].hot / page.emph）。每个词的时间就是它被说出来的时刻。
  // 不新增内容、不改字、不碰时间码；色卡、结尾、标签墙、红条的时段不叠。
  const CHIP_STOP = new Set([
    '这个', '那个', '这些', '那些', '这里', '那里', '什么', '怎么', '为什么', '我们', '你们', '他们', '她们', '它们',
    '就是', '但是', '因为', '所以', '其实', '然后', '而且', '现在', '时候', '时间', '今天', '昨天', '明天', '一下',
    '一点', '一个', '已经', '可以', '没有', '不是', '不会', '不要', '还是', '也是', '都是', '只是', '这样', '那样',
    '这种', '那种', '这么', '那么', '如果', '虽然', '不过', '只有', '才能', '应该', '觉得', '认为', '需要', '可能',
    '一定', '真的', '非常', '比较', '有点', '很多', '一些', '东西', '事情', '以后', '之前', '之后', '的话', '一样',
    '一起', '一直', '必须', '相当', '自己', '大家', '咱们', '别的', '起来', '出来', '进去', '知道', '看到', '结合',
    '你的', '我的', '他的', '说的', '做的', '很难', '越来', '就可', '就以', '这种话', '而言', '来说', '别再', '别去', '不用', '只要', '就能',
    // 这些不是名词，是口播里最常出现的「功能块」：挂上去就等于把一句话的动词/副词抄上屏。
    '都在', '在做', '是在', '才是', '才是', '我是', '也是', '都有', '真正', '越来越', '都能', '做出', '想要', '做的', '太少',
    '抓住', '才有', '要花', '如果', '的话', '可以', '我们', '你们', '他们', '就是', '因为', '所以', '但是', '而且', '只有',
  ])
  const PUNCT = /[\s，。！？、；：,.!?;:""''…—~·\-]/
  const LATIN_SEG = /^[A-Za-z][A-Za-z0-9+#.]*$/
  /** 这一页值得挂的标签词：术语表命中 / 拉丁专名 / 已被挑成大字高亮的词。
   *  只有这三类，别的一律不挂——标签一多就会变成「为了热闹硬加」。 */
  function chipPool(p, bigList, text) {
    const pool = new Map()
    const add = (text, kind) => {
      const w = String(text || '')
      // 拉丁专名（Claude / Codex / DeepSeek）本来就比四个汉字长；中文词只认 2–4 字
      if (LATIN_SEG.test(w) ? (w.length < 2 || w.length > 9) : (w.length < 2 || w.length > 4)) return
      // 只挂「一个词」：segment 拆成两段的短语（结合内容 / 一周的工）挂上去就是半句话
      if (segment(w).length !== 1) return
      if (CHIP_STOP.has(w) || /^[0-9]/.test(w)) return
      if (pool.has(w)) return
      pool.set(w, { text: w, kind })
    }
    for (const term of TERMS) if (text.includes(term)) add(term, 'term')
    for (const b of bigList) {
      const toks = segment(bare(b.text || ''))
      for (const tok of toks) if (LATIN_SEG.test(tok) && tok.length >= 2) add(tok, 'latin')
      if (b.hot) add(bare(b.hot), 'hot')
    }
    if (p.emph) add(bare(p.emph), 'hot')
    for (const b of bigList) {
      const hw = bare(b.hot || '')
      if (!hw) continue
      const piece = segment(hw).filter(w => w.length >= 2 && w.length <= 4).sort((x, y) => y.length - x.length)[0]
      if (piece) add(piece, 'hot')
    }
    for (const c of (p.cards || [])) {
      for (const tok of segment(bare(c.text || ''))) if (LATIN_SEG.test(tok) && tok.length >= 2) add(tok, 'latin')
    }
    // 第四类：这一页自己的实词。折光的标签密度不是靠术语表堆出来的，是「一句话一个实词」——
    // 术语表只覆盖 GPT / Claude 这类专名，一条普通中文口播全片挂不出几张（自测22 只有 4 张，
    // 28 秒之后一张都没有，画面就退化成「人 + 一句大字」）。
    // 补的这一档有三条硬约束，避免变成「为了热闹硬加」：
    //   · 只从**整页原话**分词（不是从断行后的字幕卡切，那样会切出「生产」「结合」这种半截词）；
    //   · 只要 2–4 字的整词，函数词、单字词、数字一律不挂；
    //   · 同一页里被反复说到的词优先——重复本身就是说话人在强调它，不是我们替他挑的。
    const freq = new Map()
    for (const tok of segment(bare(text))) {
      if (tok.length < 2 || tok.length > 4 || /^[0-9]/.test(tok)) continue
      freq.set(tok, (freq.get(tok) || 0) + 1)
    }
    // 只用「这条片子里说过两次以上」的实词。说一次的词留在字幕里就够了，
    // 挂成标签等于替说话人强调他其实没强调的东西；这一条顺带挡掉了 ICU 把
    // 「生产力」拆成「生产」这种一次性的半截词（自测23 探针里真出现过）。
    for (const [tok] of [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)) {
      // 两个字的词最容易是分词碎片或功能词（「来去」「生产」「都在」），要求它在全片被说过两遍以上；
      // 三四个字的词本身就有信息量，说一遍也能挂。
      if (tok.length === 2 && (globalFreq.get(tok) || 0) < 2) continue
      add(tok, 'word')
    }
    return [...pool.values()]
  }
  /** 这一页的字符表：把这一页所有字幕卡的逐字时间拼成一条，跨卡片的词也能找到。 */
  function pageChars(list) {
    const out = []
    for (const b of list) for (const x of (b.chars || [])) if (x && x.ch && !PUNCT.test(x.ch)) out.push(x)
    return out
  }
  /** 这个词在这一页被说过几次：按字符表对齐，返回每一次的起始时间。 */
  function spokenTimes(chars, word) {
    const bag = chars.map(x => x.ch).join('')
    const out = []
    let i = bag.indexOf(word)
    while (i >= 0) { if (chars[i]) out.push(chars[i].f0); i = bag.indexOf(word, i + 1) }
    return out
  }

  const chips = []
  const chipSlots = new Map()
  // 四条泳道 × 左右两侧：参考片的同一屏上叠着三五张小标签，三条泳道太少，两张一起就挤
  const slotOrderA = [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2], [0, 3], [1, 3]]
  const slotOrderB = [[1, 0], [0, 0], [1, 1], [0, 1], [1, 2], [0, 2], [1, 3], [0, 3]]
  const chipLife = (L.chips && L.chips.life) || 3.8
  // 参考片的标签不是整齐排成一条线，是散着挂的。这里给每张一个固定的偏移（同一条片子每次渲染色一样），
  // 偏移量写进 scene.json：渲染器和质检盒子读同一份，别各算一套。
  const CHIP_NUDGE = [[-12, -8], [8, 6], [-6, 10], [12, -4]]
  for (const p of pagesRaw) {
    const list = beats.filter(b => b.f0 >= p.start - 0.25 && b.f0 < p.end)
    const pageText = list.map(b => b.text).join('')
    const bigList = bigs.filter(b => b.page === p.index)
    const title = bare(p.title || '')
    const cands = []
    const chars = pageChars(list)
    const pool = chipPool(p, bigList, pageText)
    // 「说过就挂」：这一页里它被说过好几次时，取第一个落在可用窗口里的那一次，
    // 不是死取第一次——第一次常常正好压在章节卡上，取不到就等于整页不挂。
    const atOf = w => spokenTimes(chars, w).find(t => t >= p.start + 1.75 && t <= p.end - 1.2)
    const borrowed = []
    for (const c of pool) {
      const at = atOf(c.text)
      if (at == null) continue
      // 已经印在章节标题那行小字里的词不再挂标签：同一屏出现两次是重复，不是密度。
      if (title && (title.includes(c.text) || c.text.includes(title))) { borrowed.push({ ...c, f0: at }); continue }
      cands.push({ ...c, f0: at })
    }
    const rank = c => (c.kind === 'term' ? 3 : c.kind === 'latin' ? 2 : c.kind === 'hot' ? 1 : 0)
    cands.sort((a, b) => (rank(b) - rank(a)) || (a.f0 - b.f0))
    const picked = []
    const take = c => {
      if (picked.length >= 4) return
      if (picked.some(x => Math.abs(x.f0 - c.f0) < 1.0)) return
      if (picked.some(x => x.text.includes(c.text) || c.text.includes(x.text))) return
      picked.push(c)
    }
    for (const c of cands) take(c)
    // 密度下限：这一页真正能挂的词不到两张时，从标题里借——那行小字已经在屏上，
    // 借它算重复一次，但比「整整两页一个标签都没有」更接近参考片的密度；
    // 借的仍然是这一页说过的整词，一个字都不是我们编的。补到两张为止，不再往上借。
    if (picked.length < 2) for (const c of borrowed.sort((a, b) => b.text.length - a.text.length)) { take(c); if (picked.length >= 2) break }

    picked.sort((a, b) => a.f0 - b.f0)
    for (const c of picked) {
      const f0 = round(c.f0)
      const s0 = shots.find(s => f0 >= s.f0 && f0 < s.f1)
      if (!s0 || s0.kind === 'card' || s0.kind === 'outro') continue
      // 「说过就留着」：标签是画面上的注脚，不跟着版式切——参考片的标签就是攒着不走的。
      // 所以它跨页、跨版式都可以，只在遇到全屏色卡/结尾时收掉（那两块画面是留白的）。
      const hard = round(Math.min(f0 + chipLife, duration - 0.2))
      // 收在三种东西之前：全屏色卡 / 结尾、以及下一页的章节卡。
      // 章节卡是整幅宽的板，标签骑上去就是两块东西叠着（自测23 质检在 7 帧上抓到 block:chip × chapter）。
      const stops = []
      const blocked = shots.find(s => (s.kind === 'card' || s.kind === 'outro') && s.f0 > f0 && s.f0 < hard)
      if (blocked) stops.push(blocked.f0)
      const nextPage = pagesRaw.find(x => x.start > f0 + 0.05 && x.start < hard && bare(x.title))
      if (nextPage) stops.push(nextPage.start)
      const f1 = stops.length ? round(Math.min(hard, Math.min(...stops) - 0.05)) : hard
      if (f1 - f0 < 1.2) continue
      if (blocks.some(b => (b.kind === 'tagwall' || b.kind === 'banner') && f0 < b.f1 && b.f0 < f1)) continue
      // 一屏最多 4 张：折光一屏三五张是上限，再多就是贴纸墙。这里在落盘前就守住，
      // 不指望质检事后拦——密度要涨，但涨到「糊满」就是另一个方向错了。
      let aliveMax = 0
      for (let tt = f0; tt < f1; tt += 0.25) aliveMax = Math.max(aliveMax, chips.filter(c => tt >= c.f0 && tt < c.f1).length)
      if (aliveMax >= 4) continue
      const sides = s0.kind === 'corner' ? [0] : [0, 1]           // 小窗页右边是人物窗口，标签只走左边
      const order = chips.length % 2 ? slotOrderB : slotOrderA
      let key = null
      for (const [side, lane] of order) {
        if (!sides.includes(side)) continue
        const k2 = side + ':' + lane
        const busy = chipSlots.get(k2) || []
        if (busy.some(w => f0 < w[1] + 0.12 && w[0] < f1 + 0.12)) continue
        key = k2
        break
      }
      if (!key) continue
      const busy = chipSlots.get(key) || []
      busy.push([f0, f1])
      chipSlots.set(key, busy)
      const [side, lane] = key.split(':').map(Number)
      const [ndx, ndy] = CHIP_NUDGE[chips.length % CHIP_NUDGE.length]
      // 只往画面外侧偏：往中间偏会压到脸（质检 label_edge 会拦，但没必要先犯一次）
      let nx = side ? Math.abs(ndx) : -Math.abs(ndx)
      // 满幅页的标签在画面两侧，中间 26%–74% 是脸。右边那条按「安全区右边距 150」排，
      // 长词（Claude）算下来会正好压进 74% 线 0.2px——标签一长就被判「压脸」。
      // 这里把偏移改成「至少把人脸带让出来」，仍然落在外侧，只是贴着安全区边。
      if (s0.kind === 'full' && L.size) {
        const Wp = L.size[0]
        const cwEst = textEm(c.text) * ((t.type && t.type.chip) || 26) + ((L.chips && L.chips.padX) || 20) * 2
        const faceL = Math.round(Wp * 0.26) + 4, faceR = Math.round(Wp * 0.74) - 4
        const rightEdge = Wp - ((L.chips && L.chips.right) || 150) - cwEst
        if (side && rightEdge + nx < faceR) nx = Math.round(faceR - rightEdge)
        if (!side && ((L.chips && L.chips.left) || 56) + nx + cwEst > faceL) nx = Math.round(faceL - ((L.chips && L.chips.left) || 56) - cwEst)
      }
      chips.push({ text: c.text, f0, f1, side, lane, dx: nx, dy: ndy, page: p.index, hot: c.kind === 'term' || c.kind === 'latin' ? 1 : 0 })
    }
  }

  const subs = beats.map((b, i) => {
    const big = bigs.find(x => x.beat === i)
    return { text: b.text, f0: b.f0, f1: b.f1, runs: markRuns(b.text, big ? big.hot : '') }
  })

  const cues = []
  cues.push({ t: 0.10, sfx: 'click', gain: 0.6 })
  for (const p of pagesRaw.slice(1)) cues.push({ t: round(p.start), sfx: 'tick', gain: 0.5 })
  for (const b of bigs.slice(0, 4)) cues.push({ t: b.f0, sfx: 'tick', gain: 0.32 })
  for (const b of blocks.filter(x => x.kind === 'banner')) cues.push({ t: b.f0, sfx: 'impact', gain: 0.45 })
  cues.push({ t: Math.max(0.3, duration - 0.4), sfx: 'drop', gain: 0.55 })

  return {
    template: t.id,
    ratio: RATIO,
    size: L.size,
    fps,
    frames: totalFrames,
    duration: round(duration),
    palette: t.palette,
    type: t.type,
    person: { seq: 'person', count: ranges.reduce((n, r) => n + r.srcCount, 0), ranges },
    pages: pagesRaw.map(p => ({
      index: p.index, total: p.total, start: round(p.start), end: round(p.end),
      title: p.title, eyebrow: p.eyebrow || '', kind: p.kind, cards: p.cards.length,
      intent: p.intent || 'full',
    })),
    shots,
    bigs,
    subs,
    blocks,
    chips,
    beats,
    marks: pagesRaw.map(p => ({ t: round(p.start), index: p.index, total: p.total })),
    sections: pagesRaw.map(p => ({ index: p.index, start: round(p.start), end: round(p.end), text: p.text, lines: [] })),
    cues,
    stats: {
      source: round(plan.sourceDuration || 0, 2),
      out: round(duration, 2),
      kept: round(plan.keptSeconds, 2),
      cut: round(plan.cutSeconds, 2),
      segments: plan.keep.length,
      pauses: plan.removedPauses,
      speed: plan.options.speed,
    },
    timeline: {
      duration: round(duration),
      tracks: [{ name: 'KEEP', color: t.palette.green, clips: ranges.map(r => [round(r.outF0 / fps / duration, 4), round(r.outF1 / fps / duration, 4)]) }],
    },
    labels: { platform: brief.platform || '', template: t.name, brand },
    planSummary: {
      shots: shots.map(s => ({ at: round(s.f0), kind: s.kind, label: SHOT_LABEL[s.kind] || s.kind, why: s.why })),
      blocks: blocks.map(b => ({ at: round(b.f0), kind: b.kind })),
      chips: chips.map(b => ({ at: b.f0, text: b.text })),
    },
  }
}
