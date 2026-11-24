import { ff, probeFile } from './ffmpeg.mjs'
import { TEXT_COLOR, boxContrast, contrastRatio, intersect, unionBoxes, coverMap } from './frame-audit.mjs'
import { judgeSemantic } from './qa-semantic.mjs'

// 目标时长允许多少差：制片人拍板和质检用同一个数，不许一处 15%、一处 12%——
// 那会出现「制片人说达标了、质检查出没达标」，用户不知道该信谁（2026-11-20 实测踩到）。
export const TARGET_TOLERANCE = 0.12

// 门槛全部写在这里，改门槛就是改产品承诺，别散在代码各处。
export const BAR = {
  sections: [4, 14],        // 一段话的段落数：少于此观众没结构，多于此就是字幕在抖
  sectionMinSec: 3.0,       // 一段至少 3 秒，否则大字一闪而过
  duplicate: 0.8,           // 相邻两张字幕相似到 80%，就是 ASR 重复句
  duplicatePhrase: 6,       // 或前一张结尾 = 后一张开头 ≥6 字（同一句被切在两张卡上）
  confidence: 0.08,         // 低置信词占比上限：251 词里 25 个 = 10% 必须判不过
  contrastBig: 3.0,         // 大字直接压画面：够大，3:1 可接受（WCAG 大字号档）
  contrastSmall: 4.5,       // HUD / 字幕这类小字：4.5:1
  contrastRail: 3.0,        // 光轨是图形元素，同大字号档
  overlapArea: 4,           // 盒子互相压到的容忍面积（px²）
  margin: 16,               // 盒子离画面边缘的最小距离
  subBottomExempt: 420,     // 字幕 pill 允许进平台底部 UI 区（参考片也这么做，写在 detail 里）
  zone: { bodyTop: 0.56, hudBottom: 0.10 }, // 版式契约：文字只在下半区，HUD 只在顶部一成
}

const KINDS = { homophone: '同音字', term: '专有名词', number: '数字' }

function similarity(a, b) {
  const A = [...a], B = [...b]
  if (!A.length || !B.length) return 0
  // 最长公共子串 / 较短串长度：重复句是整句重复，用这个最灵敏
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

/** 质检：每条结论必须带证据（时间点 / 数值）。没有证据不许判通过。 */
export async function qa({ file, plan, captions, targetDuration = null, asrFix = null, scene = null, boxes = null, layout = null, frames = null, source = null, engine = 'canvas', semantic = undefined }) {
  const info = await probeFile(file)
  const duration = Number(info.format.duration)
  const audio = info.streams.find(s => s.codec_type === 'audio')
  const vstr = info.streams.find(s => s.codec_type === 'video')
  const checks = []
  const add = (id, ok, detail, evidence) => checks.push({ id, ok, detail, evidence })

  add('duration', true, `成片 ${duration.toFixed(2)}s，源 ${(plan.sourceDuration || 0).toFixed(2)}s，剪掉 ${(plan.cutSeconds || 0).toFixed(2)}s`,
    { duration, source: plan.sourceDuration, segments: plan.keep.length })

  if (targetDuration) {
    const delta = duration - targetDuration
    add('target', Math.abs(delta) <= targetDuration * TARGET_TOLERANCE, `目标 ${targetDuration}s，实际 ${duration.toFixed(2)}s（差 ${delta.toFixed(1)}s）`, { delta: Number(delta.toFixed(2)) })
  }

  if (audio) {
    let silences = []
    try {
      const { stderr } = await ff(['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-40dB:d=0.6', '-f', 'null', '-'])
      const starts = [...stderr.matchAll(/silence_start: (\d+\.?\d*)/g)].map(m => Number(m[1]))
      const ends = [...stderr.matchAll(/silence_end: (\d+\.?\d*) \| silence_duration: (\d+\.?\d*)/g)].map(m => ({ end: Number(m[1]), dur: Number(m[2]) }))
      silences = ends.map((e, i) => ({ start: starts[i] ?? e.end - e.dur, end: e.end, dur: e.dur }))
    } catch { /* silencedetect 只是警告，不阻断 */ }
    const long = silences.filter(s => s.dur > 0.8)
    add('silence', long.length === 0, long.length ? `还有 ${long.length} 段超过 0.8s 的静音` : '没有超过 0.8s 的静音', { long: long.slice(0, 8) })

    let lufs = null
    try {
      const { stderr } = await ff(['-hide_banner', '-i', file, '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'])
      const m = [...stderr.matchAll(/I:\s+(-?\d+\.\d+) LUFS/g)].pop()
      if (m) lufs = Number(m[1])
    } catch { /* 同上 */ }
    add('loudness', lufs === null || (lufs > -22 && lufs < -8), `响度 ${lufs ?? '未测出'} LUFS`, { lufs })
  } else {
    add('audio', false, '成片没有音轨', {})
  }

  const cards = (captions && captions.cards) || []
  if (captions) {
    add('caption_coverage', captions.coverage.missing === 0,
      captions.coverage.missing === 0 ? `${cards.length} 张字幕，原文 ${captions.coverage.originalChars} 字全覆盖` : `漏了 ${captions.coverage.missing} 个字`,
      captions.coverage)
    const longCard = cards.filter(c => c.text.length > 16)
    add('caption_length', longCard.length === 0, longCard.length ? `${longCard.length} 张字幕超过 16 字` : '字幕长度都在 16 字以内',
      { longest: Math.max(0, ...cards.map(c => c.text.length)) })

    // 字幕流：有序、不互压、不断档。改一句之后时间码不动，这里能查出来有没有被带歪。
    let flow = []
    for (let i = 1; i < cards.length; i++) {
      const gap = cards[i].start - cards[i - 1].end
      if (gap < -0.05) flow.push({ at: Number(cards[i].start.toFixed(2)), gap: Number(gap.toFixed(2)) })
    }
    const tail = cards.length ? duration - cards[cards.length - 1].end : 0
    add('caption_flow', flow.length === 0 && tail < 2.0,
      flow.length ? `${flow.length} 张字幕压着上一张（最早 ${flow[0].at}s，叠 ${Math.abs(flow[0].gap)}s）` : `字幕不互压，末尾空 ${tail.toFixed(2)}s`,
      { flow: flow.slice(0, 4), tail: Number(tail.toFixed(2)) })

    // 重复句：ASR 在同一段话上loop 是真实故障（"但是AI来去做内容"连着出现两遍）
    // 两种形态都抓：整句相似，以及「前一张结尾 = 后一张开头」（同一句被切在两张卡上，最容易漏）
    const dup = []
    for (let i = 1; i < cards.length; i++) {
      const A = cards[i - 1].text, B = cards[i].text
      const s = similarity(A, B)
      let overlap = 0
      for (let k = Math.min(A.length, B.length); k >= BAR.duplicatePhrase; k--) {
        if (A.slice(-k) === B.slice(0, k)) { overlap = k; break }
      }
      if (s >= BAR.duplicate || overlap >= BAR.duplicatePhrase) {
        dup.push({ at: Number(cards[i].start.toFixed(2)), sim: Number(s.toFixed(2)), overlap, text: overlap ? B.slice(0, overlap) : B })
      }
    }
    add('duplicate_lines', dup.length === 0,
      dup.length ? `${dup.length} 处重复句（最早 ${dup[0].at}s：「${dup[0].text}」）` : '没有重复句',
      { dup: dup.slice(0, 4) })
  }

  // 错字治理自己也要被查，而且这次真查：低置信词占比超线就是不过，不再只写一句"没把握 25 处"然后放行。
  if (asrFix) {
    const { applied = [], rejected = [], pending = [], assertion = {}, stats = {} } = asrFix
    const kinds = applied.reduce((m, a) => ({ ...m, [a.kind]: (m[a.kind] || 0) + 1 }), {})
    const kindText = Object.entries(kinds).map(([k, n]) => `${KINDS[k] || k} ${n}`).join('、')
    const safe = assertion.wordCount === true && assertion.timingUntouched === true
    const totalWords = stats.words || stats.total || 0
    const ratio = totalWords ? pending.length / totalWords : 0
    const okRatio = totalWords ? ratio <= BAR.confidence : false
    add('asr_confidence', safe && okRatio,
      `改字 ${applied.length} 处${kindText ? `（${kindText}）` : ''}，打回 ${rejected.length} 处，没把握 ${pending.length}${totalWords ? `/${totalWords} 词 = ${(ratio * 100).toFixed(1)}%（上限 ${(BAR.confidence * 100).toFixed(0)}%）` : ''}` +
      (pending.length ? `：${pending.slice(0, 5).map(p => `「${p.w}」@${p.at}s`).join('、')}${pending.length > 5 ? ' 等' : ''}` : '') +
      `；词数 ${assertion.wordCount ? '未变' : '变了'}，时间码 ${assertion.timingUntouched ? '未动' : '被动了'}`,
      { applied, rejected, pending, assertion, ratio: Number(ratio.toFixed(4)), bar: BAR.confidence })
  }

  // 段落节奏：用户 2026-11-23 明确否掉"22 章切太碎"，这里把它变成硬门槛。
  if (scene && scene.sections) {
    const secs = scene.sections
    const short = secs.filter(s => s.end - s.start < BAR.sectionMinSec)
    const inRange = secs.length >= BAR.sections[0] && secs.length <= BAR.sections[1]
    add('section_pace', inRange && short.length === 0,
      `${secs.length} 段（要求 ${BAR.sections[0]}–${BAR.sections[1]}），平均 ${(duration / Math.max(1, secs.length)).toFixed(1)}s 一段` +
      (short.length ? `，${short.length} 段短于 ${BAR.sectionMinSec}s：${short.slice(0, 3).map(s => `第${s.index}段 ${(s.end - s.start).toFixed(1)}s`).join('、')}` : ''),
      { count: secs.length, short: short.map(s => ({ index: s.index, sec: Number((s.end - s.start).toFixed(2)) })) })
  }

  // ── 画面：从成片真实像素里量，不看模板嘴上说什么 ──
  const band = scene && scene.person && scene.person.headBand
  add('subject_known', true,
    band && band.ok
      ? `人物头部实测 ${(band.band.top * 100).toFixed(0)}%–${(band.band.bottom * 100).toFixed(0)}% 高度，文字按它避让`
      : '人物蒙版还没接（docs/MATTE.md 里排着）：脸部位置没有机器判定，这一版靠下面的 layout_zone 契约兜底',
    { band: band || null })

  if (boxes && boxes.length) {
    const outSize = [vstr ? vstr.width : 0, vstr ? vstr.height : 0]
    const unions = unionBoxes(boxes).map(b => ({ ...b, outW: outSize[0], outH: outSize[1] }))

    // 1. 盒子互相压：同一帧里两样东西不能重叠（大字压轨道、字幕压轨道都是排版事故）
    const perFrame = new Map()
    for (const b of boxes) { if (!perFrame.has(b.frame)) perFrame.set(b.frame, []); perFrame.get(b.frame).push(b) }
    const clashes = []
    for (const [f, list] of perFrame) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b2 = list[j]
          if (a.tag === b2.tag) continue
          const hit = intersect(a, b2)
          if (hit && hit.area > BAR.overlapArea) clashes.push({ frame: f, a: a.tag, b: b2.tag, area: Math.round(hit.area) })
        }
      }
    }
    add('layout_overlap', clashes.length === 0,
      clashes.length ? `${clashes.length} 帧上文字/图形互相压（${clashes[0].a} × ${clashes[0].b}，第 ${clashes[0].frame} 帧）` : `${[...perFrame.keys()].length} 个采样帧上，文字与图形互不重叠`,
      { clashes: clashes.slice(0, 6) })

    // 2. 版式契约：满幅版式里，大字/图形块不许进头部区（上 56%）。
    //    光轨穿脸那条 bug 的根因就是没这条规则——轨道可以放在任何高度，谁也不知道脸在哪。
    //    折光版式要分开看：
    //      · HUD 与章节卡按设计就住在上方（参考片一样），不是越界；
    //      · 小窗 / 竖框 / 结尾版式里人物只占一个小窗，大字压在窗口下面的胸口是对的。
    //    以前不看版式一律按上 56% 判，小窗版式的 3 行大字被判失败——那是假失败。
    const zoneTop = Math.round(outSize[1] * BAR.zone.bodyTop)
    const headTags = new Set(['hud:rec', 'hud:sec', 'hud:page', 'hud:brand', 'hud:progress', 'chapter', 'block:chip', 'block:banner'])
    const inHead = new Map()
    for (const b of boxes) {
      if (headTags.has(b.tag)) continue
      if (b.shot && b.shot !== 'full') continue
      if (b.y < zoneTop) inHead.set(b.tag, Math.round(b.y))
    }
    // 只有「顶部」那几件（页码、品牌胶囊）受 hudBottom 约束；底部进度线本来就在底下。
    const topHud = new Set(['hud:rec', 'hud:sec', 'hud:page', 'hud:brand'])
    const hudLow = unions.filter(b => topHud.has(b.tag) && b.y + b.h > Math.round(outSize[1] * BAR.zone.hudBottom))
    add('layout_zone', inHead.size === 0 && hudLow.length === 0,
      inHead.size || hudLow.length
        ? [
          inHead.size ? `${[...inHead].map(([t, y]) => t + '@' + y + 'px').join('、')} 进了满幅版式的头部区（上 56% 从 0 到 ${zoneTop}px）` : '',
          hudLow.length ? `顶部 HUD 掉到了 ${Math.round(outSize[1] * BAR.zone.hudBottom)}px 以下：${hudLow.map(b => b.tag + '@' + Math.round(b.y)).join('、')}` : '',
        ].filter(Boolean).join('；')
        : `满幅版式的大字/图形块都在 ${zoneTop}px 以下；HUD 与章节卡在上方（按设计不在此列）`, 
      { zoneTop, bad: [...inHead].map(([tag, y]) => ({ tag, y })), hudLow: hudLow.map(b => b.tag) })

    // 2b. 小标签不是正文，它是「挂在画面左右两条边上的词条」：允许进上部，但不许横穿中间。
    //     没有这条，标签要么被头区规则全判违规，要么放开了就能糊到脸中间——两头都不对。
    const chipBoxes = boxes.filter(b => b.tag === 'block:chip')
    if (chipBoxes.length) {
      const faceL = Math.round(outSize[0] * 0.26), faceR = Math.round(outSize[0] * 0.74)
      const L0 = (scene && scene.layouts && scene.layouts[scene.ratio]) || {}
      const prOf = (kind) => {
        const ww = outSize[0], hh = outSize[1]
        if (kind === 'frame') { const dw = Math.round(ww * ((L0.frame && L0.frame.w) || 0.52)); return { x: Math.round((ww - dw) / 2), y: Math.round(hh * ((L0.frame && L0.frame.y) || 0.2)), w: dw, h: Math.round(dw * hh / ww) } }
        if (kind === 'corner') { const dw = Math.round(ww * ((L0.corner && L0.corner.w) || 0.52)); return { x: ww - dw - Math.round(L0.margin || 56), y: Math.round(hh * ((L0.corner && L0.corner.top) || 0.2)), w: dw, h: Math.round(dw * hh / ww) } }
        return null
      }
      const intrude = chipBoxes.filter(b => {
        const pr = prOf(b.shot)
        if (pr) return intersect({ x: pr.x - 8, y: pr.y - 8, w: pr.w + 16, h: pr.h + 16 }, b)
        return b.x < faceR && b.x + b.w > faceL
      })
      add('label_edge', intrude.length === 0,
        intrude.length ? `${intrude.length} 个采样帧上小标签横穿中间的脸（允许范围：左边到 ${faceL}px、右边从 ${faceR}px 起）`
          : `小标签都没压人物：小窗/竖框页贴窗口边排，满幅页在画面两侧（中间 ${faceL}–${faceR}px 留空）`,
        { faceL, faceR, bad: intrude.slice(0, 4) })
    }

    // 3. 人物蒙版接上之后，这条会换成真判定（alpha 轮廓）；现在如实标成未接入，不冒充通过。
    if (band && band.ok && source && source.width) {
      const m = coverMap([source.width, source.height], outSize)
      const y0 = band.band.top * source.height * m.scale - m.oy
      const y1 = band.band.bottom * source.height * m.scale - m.oy
      const head = { x: 0, y: y0, w: outSize[0], h: y1 - y0 }
      const hits = unions.filter(b => {
        if (b.tag === 'sub') return false
        const hit = intersect(b, head)
        return hit && hit.area > BAR.overlapArea
      })
      add('subject_clear', hits.length === 0,
        hits.length ? `${hits.map(h => h.tag).join('、')} 压到人物头部（${Math.round(y0)}–${Math.round(y1)}px）` : '大字/轨道/HUD 都在头部区间之外',
        { headPx: [Math.round(y0), Math.round(y1)], hits })
    }

    // 4. 安全区：不许出画，也不许贴边。
    // 量的是「画出来的那个盒子」，不是 unions——union 会把左边的标签和右边的标签并成一个
    // 1080 宽的大框，于是一个都不出画的版式被判成出画（自测 11 的 block:tag 就是这么假失败的）。
    const seen = new Set()
    const bad = []
    for (const b of (boxes || [])) {
      const key = [b.tag, Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)].join(',')
      if (seen.has(key)) continue
      seen.add(key)
      // 出血器件（红条）按设计就是满幅的，只量上下边距，不量左右
      const oob = b.bleed
        ? (b.y < BAR.margin || b.y + b.h > outSize[1] - BAR.margin)
        : (b.x < BAR.margin || b.y < BAR.margin || b.x + b.w > outSize[0] - BAR.margin || b.y + b.h > outSize[1] - BAR.margin)
      if (oob) bad.push(b)
    }
    add('safe_area', bad.length === 0,
      bad.length ? `${bad.length} 个元素出画/贴边：${bad.slice(0, 3).map(b => b.tag).join('、')}` : `所有元素都在画面内，离边 ${BAR.margin}px 以上`,
      { bad: bad.map(b => ({ tag: b.tag, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })) })

    // 4. 对比度：从成片像素里量文字底下的亮度，算 WCAG 比
    if ((!frames || !frames.length) && unions.length) {
      add('text_contrast', false, '没取到成片像素，无法量对比度（不许当成通过）', {})
    }
    if (frames && frames.length) {
      const need = { big: BAR.contrastBig, rail: BAR.contrastRail, sub: BAR.contrastSmall, 'hud:rec': BAR.contrastSmall, 'hud:sec': BAR.contrastSmall }
      // 色卡是反白：荧光绿底 + 近黑大字。以前一律按 bone（骨白）量，色卡上就量出 1.4:1
      // 这种假失败——字色得跟着画的颜色走，否则量的是不存在的字。
      const onCardAt = t => Boolean(scene && (scene.shots || []).some(s => s.kind === 'card' && t >= s.f0 - 0.01 && t < s.f1))
      const colorOf = (tag) => {
        if (tag === 'rail') return TEXT_COLOR.signal
        if (tag === 'big') return t => (onCardAt(t) ? TEXT_COLOR.void : TEXT_COLOR.bone)
        return TEXT_COLOR.bone
      }
      const fails = []
      const report = []
      for (const b of unions) {
        const want = need[b.tag]
        if (!want) continue
        const r = boxContrast({ frames, box: b, color: colorOf(b.tag), fps: scene ? scene.fps : 30 })
        if (!r.ok) { fails.push({ tag: b.tag, why: r.reason }); continue }
        report.push({ tag: b.tag, ratio: r.worst.ratio, at: r.worst.t })
        if (r.worst.ratio < want) fails.push({ tag: b.tag, ratio: r.worst.ratio, want, at: r.worst.t })
      }
      const ok = fails.length === 0
      add('text_contrast', ok,
        ok
          ? '对比度都达标：' + report.map(r => `${r.tag} ${r.ratio}:1`).join('、')
          : fails.map(f => f.why ? `${f.tag}：${f.why}` : `${f.tag} 只有 ${f.ratio}:1（要 ${f.want}:1，最差在 ${f.at}s）`).join('；'),
        { fails, report })
    }
  }

  // 画布模板拿不到盒子 = 审计等于没做，不许当通过；烧字幕路径没有像素级排版证据，单独列明。
  if (!boxes || !boxes.length) {
    if (engine === 'canvas') {
      add('layout_overlap', false, '没拿到画面布局（模板没提供盒子），无法证明文字没压到别的元素', {})
      add('subject_clear', false, '没拿到画面布局，无法证明文字避开了人物头部', {})
      add('text_contrast', false, '没拿到画面布局，无法量文字对比度', {})
    } else {
      add('layout_evidence', true, '烧字幕路径：排版由 ASS 决定，这条没有像素级的盒子证据（只验字幕、时长、声音）', { engine })
    }
  }

  // 渲染器自己报的几何（轨道在哪、有没有让开人）：有冲突就是没做到，如实不过
  if (layout && layout.conflict) {
    add('layout_conflict', false, '轨道避让人物失败：' + layout.conflict, layout)
  } else if (layout) {
    add('layout_conflict', true,
      layout.railY
        ? `轨道在 ${(layout.railY / (vstr ? vstr.height : 1920) * 100).toFixed(0)}% 高度，字幕 pill 上沿 ${layout.subTop}px`
        : `${layout.mode} 版式：大字底边 ${layout.bigBottom}px，字幕 pill 上沿 ${layout.subTop}px`,
      layout)
  }

  // 语义层：模型读交付文本找数值查不出的错（同音错、整句崩、重复句、跑题）。
  // 规矩是「没有证据不许判通过」：没跑、跑挂了、模型说没看全，都判不通过——只是原因写清楚。
  if (semantic !== undefined) {
    const j = judgeSemantic(semantic, { cards: (captions && captions.cards) || [] })
    add('semantic_review', j.ok, j.detail, j.evidence)
  }

  const failed = checks.filter(c => !c.ok)
  return { file, duration, passed: failed.length === 0, checks, failed: failed.map(c => c.id) }
}
