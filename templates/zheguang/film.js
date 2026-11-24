// 折光 · film —— 逐帧渲染器：每一帧都是 scene.json + 时间的纯函数。
// 设计对齐用户给的折光案例：常驻 HUD（页码 / 品牌胶囊 / 进度线）、章节卡、语义强调大字、
// 六种版式（满幅 / 竖框居中 / 右上小窗 / 全屏字卡 / 章节卡 / 结尾画中画）、图形块。
// 画面里出现的每个字都来自 scene.json（原话 + 词级时间戳），这里不做内容判断、不写数字。
import { setSize, W, H, TAU, C, F, rgba, clamp, lerp, seg, E, hash, txt, measure, font, dot, ring,
  rrect, pill, line, glowStroke, glowDot, rectProgress, cornerTicks, polyProgress } from '/engine/core.js'
import { reg, QA } from '/engine/devices.js'
import { loadJSON } from '/engine/media.js'

let FPS = 30
const R = (hex, a = 1) => {
  const h = String(hex).replace('#', '')
  const n = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16))
  return 'rgba(' + n[0] + ',' + n[1] + ',' + n[2] + ',' + a + ')'
}
const chW = ch => (/[\x00-\xff]/.test(ch) ? 0.56 : 1)
const textEm = s => [...String(s || '')].reduce((n, ch) => n + chW(ch), 0)
const bare = s => String(s || '').replace(/[\s，。！？、；：,.!?;:""''…—~·\-]/g, '')

export async function createFilm({ media }) {
  const S = await loadJSON('/project/scene.json')
  const [w, h] = S.size
  FPS = S.fps
  setSize(w, h)
  let TPL = null
  try { TPL = await loadJSON('/project/template.json') } catch (e) { TPL = null }
  const L = (TPL && TPL.layouts && (TPL.layouts[S.ratio] || TPL.layouts[TPL.ratio])) || {}
  // 字号以 template.json 的 type 为准，scene 可覆盖。以前这里判断 S.type.size，而 type 是扁平结构，
  // 于是永远走默认值——模板改字号实际不生效（自测08 之后发现）。
  const TY = Object.assign({ big: 96, bigMin: 62, sub: 42, subSmall: 34, eyebrow: 21, chapterNum: 84, chapterTitle: 54, block: 26, blockSmall: 20, page: 22, brand: 21 },
    (TPL && TPL.type) || {}, S.type || {})
  const P = Object.assign({ void: '#0B0B0C', paper: '#F4F2EC', lime: '#D8FF3E', green: '#35E07A', yellow: '#F5E13C', red: '#E23A2C', ash: '#8C8B85' }, S.palette || {})
  const M = L.margin || 56
  const HUD_Y = (L.hud && L.hud.y) || 92
  const CH = L.chapter || { y: 260, gap: 26 }
  const BGL = L.big || { left: 62, right: 150, y: 0.46, lineGap: 1.06, maxLines: 3 }
  const SUBL = L.sub || { bottom: 236, padX: 28, padY: 15, radius: 14 }
  const PROG = L.progress || { y: h - 68, h: 2 }
  const BRAND = (S.labels && S.labels.brand) || ''
  media.register('person', { url: '/media/frames/person', count: S.person.count })

  const shotAt = (t) => (S.shots || []).find(s => t >= s.f0 && t < s.f1) || (S.shots || [])[0] || { kind: 'full' }
  const pageAt = (t) => (S.pages || []).find(p => t >= p.start && t < p.end) || (S.pages || [])[0] || null
  const blockAt = (t) => (S.blocks || []).filter(b => t >= b.f0 && t < b.f1)

  function srcIdx(f) {
    for (const r of S.person.ranges) {
      if (f >= r.outF0 && f < r.outF1) return r.srcF0 + Math.min(r.srcCount - 1, Math.round((f - r.outF0) * r.speed))
    }
    return Math.max(0, S.person.count - 1)
  }

  // ───────── 人物：版式决定画在哪 ─────────
  function personRect(shot) {
    const ww = w
    if (shot.kind === 'frame') {
      const dw = Math.round(ww * ((L.frame && L.frame.w) || 0.52))
      const dh = Math.round(dw * h / w)
      const dy = Math.round(h * ((L.frame && L.frame.y) || 0.11))
      return { x: Math.round((w - dw) / 2), y: dy, w: dw, h: dh, round: 0 }
    }
    if (shot.kind === 'corner') {
      const dw = Math.round(ww * ((L.corner && L.corner.w) || 0.46))
      const dh = Math.round(dw * h / w)
      return { x: w - dw - M, y: Math.round(h * ((L.corner && L.corner.top) || 0.12)), w: dw, h: dh, round: 12 }
    }
    if (shot.kind === 'outro') {
      const dw = Math.round(ww * ((L.outro && L.outro.w) || 0.54))
      const dh = Math.round(dw * h / w)
      return { x: Math.round((w - dw) / 2), y: Math.round(h * 0.16), w: dw, h: dh, round: 28 }
    }
    return { x: 0, y: 0, w, h, round: 0 }
  }

  // 小窗/竖框页的背景：以前是纯黑，人物一缩小，环境就整块消失——参考片里环境始终在。
  // 这里把同一帧整幅铺满、压暗，再降采样回放当廉价模糊（1080×1920 上真做 blur 会拖垮渲染）。
  let bgCv = null
  let bgTex = null
  function bgPlate(c, img) {
    // 小窗/竖框页的底：不是「压暗的实拍」，是一块设计好的深色底——近黑 + 细点阵 + 一层很弱的中心光。
    // 自测09 第一版把实拍压暗当底，同一张脸在窗口后面放大出现，读起来就是双重曝光；
    // 参考片的窗口页是干净深色底（实测均值 65，我们原来纯黑 19），质感来自点阵和光，不来自素材。
    c.fillStyle = R(P.void, 1)
    c.fillRect(0, 0, w, h)
    const glow = c.createRadialGradient(w * 0.5, h * 0.35, 0, w * 0.5, h * 0.35, h * 0.75)
    glow.addColorStop(0, R(P.paper, 0.10)); glow.addColorStop(0.55, R(P.paper, 0.03)); glow.addColorStop(1, R(P.paper, 0))
    c.fillStyle = glow
    c.fillRect(0, 0, w, h)
    // 细点阵：参考片的小窗/字卡页不是纯黑，是一层极淡的点阵，空的地方才有质感
    if (!bgTex) {
      bgTex = document.createElement('canvas')
      bgTex.width = w; bgTex.height = h
      const t2 = bgTex.getContext('2d')
      t2.fillStyle = R(P.paper, 0.085)
      const step = 26
      for (let y = step; y < h; y += step) for (let x = step; x < w; x += step) {
        t2.beginPath(); t2.arc(x, y, 1.2, 0, TAU); t2.fill()
      }
    }
    c.drawImage(bgTex, 0, 0, w, h)
  }

  function drawPerson(c, img, shot) {
    const r = personRect(shot)
    if (!img) { c.fillStyle = R(P.void, 1); c.fillRect(0, 0, w, h); return }
    if (shot.kind !== 'full') bgPlate(c, img)
    c.save()
    c.filter = 'contrast(1.05) saturate(0.94) brightness(0.98)'
    if (r.round) { rrect(c, r.x, r.y, r.w, r.h, r.round); c.clip() }
    c.drawImage(img, r.x, r.y, r.w, r.h)
    c.restore()
    if (r.round || shot.kind !== 'full') {
      c.save()
      rrect(c, r.x, r.y, r.w, r.h, r.round || 0)
      // 参考片的窗口是一道荧光绿细框，不是白描边：它把小窗从背景里拎出来
      c.strokeStyle = R(P.lime, 0.78); c.lineWidth = 2.5; c.stroke()
      c.restore()
    }
  }

  // ───────── 压光：字要压得住，人不能被压死 ─────────
  function scrim(c, shot, t) {
    if (shot.kind === 'card') return
    if (shot.kind !== 'full') {
      // 小窗/竖框页的底本来就是压暗的实拍，再叠顶/底压光只会越压越黑
      // （自测08 里三成画面近黑，一半原因在这儿）。只保一条给字幕用的底光。
      const wash = c.createLinearGradient(0, h * 0.62, 0, h)
      wash.addColorStop(0, R(P.void, 0)); wash.addColorStop(1, R(P.void, 0.20))
      c.fillStyle = wash; c.fillRect(0, h * 0.62, w, h * 0.38)
      return
    }
    // 压光原本是「字要压得住」——但自测17 量出来压过头了：同一条素材，参考片把 130.7 压到 114.3
    // （−13%），我们压到 94.6（−28%），成片整体发闷。字有阴影、字幕有黑底 pill，不需要把下半屏压黑。
    const top = c.createLinearGradient(0, 0, 0, h * 0.22)
    top.addColorStop(0, R(P.void, 0.22)); top.addColorStop(1, R(P.void, 0))
    c.fillStyle = top; c.fillRect(0, 0, w, h * 0.22)
    const bot = c.createLinearGradient(0, h * 0.52, 0, h)
    bot.addColorStop(0, R(P.void, 0)); bot.addColorStop(0.55, R(P.void, 0.10)); bot.addColorStop(1, R(P.void, 0.30))
    c.fillStyle = bot; c.fillRect(0, h * 0.52, w, h * 0.48)
  }

  /** 参考片的四角括角：给实拍套一层取景框，画面立刻不像直出素材。只压在满幅页上。 */
  function frameMarks(c, shot) {
    if (shot.kind !== 'full') return
    cornerTicks(c, M, Math.round(h * 0.085), w - M * 2, Math.round(h * 0.50), 22, R(P.paper, 0.22), 2)
  }

  // ───────── HUD：页码 / 品牌胶囊 / 进度线 ─────────
  // mm:ss。以前是 hh:mm:ff，2 秒处显示「00:02:00」——观众读成两分钟。
  // 参考片右上角是「· 26s」，只给分秒。帧号对观众没有意义，去掉。
  function timecode(t) {
    const s = Math.floor(t)
    const p = n => String(n).padStart(2, '0')
    return p(Math.floor(s / 60)) + ':' + p(s % 60)
  }

  function chrome(c, t, dark = false) {
    const page = pageAt(t)
    const inkA = dark ? 0.72 : 0.78
    const ink = dark ? P.void : P.paper
    // 左上：P. 01 / 08
    if (page) {
      const label = 'P. ' + String(page.index).padStart(2, '0') + ' / ' + String(page.total).padStart(2, '0')
      txt(c, label, M, HUD_Y + 9, { size: TY.page + 3, family: F.disp, weight: 700, color: R(ink, 0.86), spacing: 2.6 })
      reg(M, HUD_Y - 16, measure(c, label, TY.page, F.disp, 700, 2.4), 40, 'hud:page')
    }
    // 右上：品牌胶囊 + 时间码
    const tc = timecode(t)
    const body = (BRAND ? BRAND + '  ' : '') + tc
    const padX = 18, hh = (L.hud && L.hud.h) || 42
    const tw = measure(c, body, TY.brand, F.disp, 600, 1.4)
    const pw = Math.round(tw + padX * 2 + 18)
    const px = w - M - pw + pw / 2, py = HUD_Y + 5
    c.save()
    pill(c, px, py, pw, hh, dark ? R(P.void, 0.90) : R(P.paper, 0.92))
    dot(c, px - pw / 2 + padX + 3, py, 5, R(P.red, 1))
    txt(c, body, px - pw / 2 + padX + 16, py + 7, { size: TY.brand, family: F.disp, weight: 600, color: dark ? R(P.paper, 0.95) : R(P.void, 0.92), spacing: 1.4 })
    c.restore()
    reg(w - M - pw, py - hh / 2, pw, hh, 'hud:brand')
    // 底部：进度线
    const pw2 = w - M * 2
    line(c, M, PROG.y, M + pw2, PROG.y, R(ink, 0.16), PROG.h)
    const k = clamp(t / Math.max(0.1, S.duration))
    line(c, M, PROG.y, M + pw2 * k, PROG.y, R(P.lime, 0.9), PROG.h)
    dot(c, M + pw2 * k, PROG.y, 3.5, R(P.lime, 1))
    reg(M, PROG.y - 6, pw2, 12, 'hud:progress')
  }

  // ───────── 章节卡 ─────────
  function chapterCard(c, t) {
    const page = pageAt(t)
    if (!page || !page.title) return
    const k0 = seg(t, page.start, page.start + 0.34)
    const k1 = 1 - seg(t, page.start + 1.18, page.start + 1.5)
    const a = E.outExpo(k0) * k1
    if (a <= 0.01) return
    const y = CH.y
    const num = String(page.index).padStart(2, '0')
    c.save()
    c.globalAlpha *= a
    // 章节卡压在实拍上：先铺一条柔和的暗底带。没有它，亮背景（白帽子、白墙）上的
    // 小字眉和绿数字就糊在一起——这不是审美问题，是读不出来。
    const sc = c.createLinearGradient(0, y - 150, 0, y + 130)
    sc.addColorStop(0, R(P.void, 0))
    sc.addColorStop(0.32, R(P.void, 0.66))
    sc.addColorStop(0.78, R(P.void, 0.56))
    sc.addColorStop(1, R(P.void, 0))
    c.fillStyle = sc
    c.fillRect(0, y - 150, w, 280)
    // 顶部一条短绿线，压住章节卡的起点
    line(c, M, y - 104, M + 64 * E.outExpo(k0), y - 104, R(P.lime, 0.95), 4)
    txt(c, 'CHAPTER ' + num + ' / ' + String(page.total).padStart(2, '0'), M, y - 66, { size: TY.eyebrow, family: F.disp, weight: 600, color: R(P.ash, 0.95), spacing: 3 })
    const numW = txt(c, num, M, y + 52, { size: TY.chapterNum, family: F.disp, weight: 800, color: R(P.green, 1), spacing: -1 })
    const tx = M + Math.max(104, numW + 26)
    const titleSize = Math.min(TY.chapterTitle, Math.floor((w - M - tx - M) / Math.max(1, textEm(page.title))))
    txt(c, page.title, tx, y + 50, { size: titleSize, family: F.sans, weight: 900, color: R(P.paper, 1), spacing: -0.5 })
    c.restore()
    reg(M, y - 90, w - M * 2, 170, 'chapter')
  }

  // ───────── 大字：语义强调卡，一行一条逐行上屏 ─────────
  function fitBigSize(lines) {
    const avail = w - BGL.left - BGL.right
    const longest = Math.max(1, ...lines.map(l => textEm(l)))
    // 三行大字要缩一档：整块高度 = 行数 × 字号 × 行距，三行按 96 排会顶穿到
    // 头部区（实测 top=1058px，禁区线 1075px）。宁可小一号，也不让字爬到脸上。
    const cap = lines.length >= 3 ? Math.min(TY.big, 104) : TY.big
    return Math.max(TY.bigMin, Math.min(cap, Math.floor((avail * 0.98) / longest)))
  }

  /**
   * 大字在这几秒里「从什么时候起真的画出来」。
   * 页首 1.5 秒画章节卡，大字要让位不出场（见 drawBig 里那条 return）——
   * 质检那份盒子要是不认这条，就会在第 492 帧报一个画面上根本不存在的大字压刻度卡（自测22 的假报）。
   */
  function bigVisibleFrom(b) {
    const pg = pageAt(b.f0)
    return pg && pg.title ? Math.max(b.f0, pg.start + 1.5) : b.f0
  }

  /** 刻度卡压着右边一块（0.575h 起、高 210）。返回这段时间里它的下沿；没有就是 null。 */
  function gaugeBottomDuring(f0, f1) {
    let best = null
    for (const g of S.blocks || []) {
      if (g.kind !== 'gauge') continue
      if (g.f1 <= f0 || g.f0 >= f1) continue
      const bot = h * 0.575 + 210
      if (best === null || bot > best) best = bot
    }
    return best
  }

  /**
   * 一句大字的几何：字号、行高、板的位置。**画、让位、质检盒子三处都从这一份算**——
   * 自测21 的 11px「假失败」就是两处各算一遍算岔了（一处按墨迹、一处按板；一处按当前帧、一处按区间起点）。
   *
   * 刻度卡那条：短句子会被字号上限顶到 168px，板顶升到 1286px，正好插进刻度卡底部 1314px
   * （自测22 第 545 帧：「越来越低 ↓」被板沿切掉）。板的底边是固定的，只能把字缩到板顶落在卡底以下。
   */
  function bigGeom(b2, shot = null) {
    const lines = b2.lines && b2.lines.length ? b2.lines : [b2.text]
    const bottom = bigBottom(shot || shotAt(b2.f0))
    let size = fitBigSize(lines)
    const gBot = gaugeBottomDuring(bigVisibleFrom(b2), b2.f1)
    if (gBot !== null) {
      const room = bottom - gBot - 22
      const maxSize = Math.floor(room / (lines.length * (BGL.lineGap || 1.06) + 0.14))
      size = Math.max(TY.bigMin, Math.min(size, maxSize))
    }
    const lh = size * (BGL.lineGap || 1.06)
    const padY = Math.round(size * 0.14)
    const top = bottom - lines.length * lh
    return { lines, size, lh, padY, top, bottom, plateTop: Math.round(top - padY) }
  }

  /** 大字的底边（不是顶边）：满幅压在胸口，竖框在小窗下面，小窗在左侧中下部。
   *  参考片的大字基本落在 0.5–0.72 这一段，字幕在 0.84——两者永远不重叠。 */
  function bigBottom(shot) {
    if (shot.kind === 'frame') return h * 0.80
    // 参考片的大字压在 0.70–0.80h 的胸口位置，一行一条、字很大；我们以前在 0.71h 且最多三行，
    // 3 行块顶到 0.48h 就爬上了脸。行数已经由数据层合并到 1 行，底边顺势下移。
    if (shot.kind === 'corner') return h * 0.775
    return h * 0.775
  }

  /**
   * 印章徽章：板边一枚圆章，章上是大字里那个被挑中的强调词。
   * 参考片里最像「设计」的那个动作——红圆章「卷」、皇冠章「才是王道」——它不是装饰，
   * 是把一句话里的关键词单独拎出来盖一次。没有 2–3 字的强调词就不盖：空章等于编内容。
   */
  function stamp(c, b, plate, size, t) {
    const hot = bare(b.hot || '')
    if (hot.length < 2 || hot.length > 3) return
    const r = Math.round(Math.min(96, Math.max(62, size * 0.44)))
    const edge = Math.max(M, (L.safe && L.safe.right) || 150)
    let cx = plate.x + plate.w + r + 14
    let cy = plate.y + Math.round(plate.h * 0.42)
    if (cx + r > w - edge - 6) {
      // 板占满整行时右边塞不下：退一步盖在板的上方右侧（满幅页那一片是空的，还在头部区以下）。
      // 但那一片会被红条/刻度卡/对勾卡占着——有块在的时候不盖，宁可这一条没有章。
      if (blockAt(t).some(x => x.kind === 'banner' || x.kind === 'gauge' || x.kind === 'check')) return
      cx = w - edge - r - 6
      cy = plate.y - r - 18
    }
    if (cx - r < M || cx + r > w - M - 4) return
    if (cy - r < HUD_Y + 150) return
    const k = E.outCubic(clamp(seg(t, b.f0 + 0.18, b.f0 + 0.46)))
    if (k <= 0.02) return
    const red = b.style === 'redBox'
    const col = red ? P.red : P.lime
    c.save()
    c.globalAlpha *= k
    c.translate(cx, cy)
    c.rotate(((-7 * Math.PI) / 180) * E.outCubic(clamp(seg(t, b.f0 + 0.10, b.f0 + 0.50))))
    const sc = 0.86 + 0.14 * k
    c.scale(sc, sc)
    dot(c, 0, 0, r, R(col, red ? 1 : 0.94))
    ring(c, 0, 0, r + 10, R(P.paper, 0.30), 2)
    const ts = Math.round(Math.min(r * 0.88, (r * 1.6) / Math.max(1, textEm(hot))))
    txt(c, hot, 0, Math.round(ts * 0.34), { size: ts, family: F.sans, weight: 900, color: R(red ? P.paper : P.void, 0.97), align: 'center' })
    c.restore()
    reg(cx - r - 10, cy - r - 10, r * 2 + 20, r * 2 + 20, 'block:stamp')
  }

  function drawBig(c, b, t, shot) {
    if (t < b.f0 || t >= b.f1) return
    // 章节卡在的时候不放大字：两套文字同屏会打架（自测07 抽帧里「01 最赚钱的不是技术」
    // 和大字「赚钱不是技术」上下叠着，说的是同一句话）。但压 2 秒压过头了——章节卡自己
    // 只活 1.7 秒，剩下那半秒小窗页的下半屏是全黑的（自测11 抽帧 7.0s）。现在章节卡收到
    // 1.5 秒，大字从 1.5 秒起，两者不同屏也不再留空。
    const pg0 = pageAt(t)
    if (pg0 && pg0.title && t < pg0.start + 1.5) return
    const g = bigGeom(b, shot)
    const lines = g.lines
    const size = g.size
    const lh = g.lh
    const top = g.top
    // ── 底色板（自测18）──
    // 对折光抽帧做对照才看清的：人家的大字下面永远垫着一块深色板，字和人分属两层；
    // 我们的字直接浮在实拍上（只有一层阴影），同一个动作读起来就是「字幕」而不是「版面」。
    // 板同时解决可读性：大字底下的像素从「白帽子 / 白墙」变成「压暗的板」，对比度不再是运气。
    // 板宽必须按真字宽量：以前用 textEm（ASCII 一律算 0.56em）估，「GPT」这类词量出来比画的窄，
    // 板就短出字一截（自测18 的第 690 帧上「用C」露在板外）。
    const widest = Math.max(1, ...lines.map(l => measure(c, l, size, F.sans, 900)))
    const padX = Math.round(size * 0.18), padY = g.padY
    const plate = {
      x: Math.max(M - 8, Math.round(BGL.left - padX)),
      y: Math.round(top - padY),
      w: Math.min(w - BGL.left - M, Math.round(widest + padX * 2)),
      h: Math.round(lines.length * lh + padY * 2),
    }
    const kIn = E.outExpo(clamp(seg(t, b.f0, b.f0 + 0.30)))
    c.save()
    c.globalAlpha *= 0.94 * kIn
    rrect(c, plate.x, plate.y, plate.w, plate.h, Math.round(size * 0.09))
    c.fillStyle = R(P.void, 0.60)
    c.fill()
    // 板的左沿一道荧光绿细线：参考片的板都有边，光靠一块暗矩形看起来像「没渲染完」
    c.fillStyle = R(P.lime, 0.85 * kIn)
    c.fillRect(plate.x, plate.y + Math.round(size * 0.10), Math.max(3, Math.round(size * 0.022)), plate.h - Math.round(size * 0.20))
    c.restore()
    // 印章（徽章）：参考片的红圆章 / 皇冠章压在板边，是画面里唯一「不整齐」的东西，也是最像设计的地方。
    // 只在大字真有一个 2–3 字的强调词时才盖：没有词的章等于编内容。
    stamp(c, b, plate, size, t)
    c.save()
    // 小字眉：换页之后才出现，避免和章节卡打架
    const page = pageAt(t)
    // 小字眉和大字是同一句话时不画：试过「● 泼一瓶冷水」压着「泼一瓶冷水」，
    // 同一句话在一屏上写了两遍，看着像渲染重了。
    const dupEye = b.pageTitle && (bare(b.text).includes(bare(b.pageTitle)) || bare(b.pageTitle).includes(bare(b.text)))
    if (page && page.title && !dupEye && t > page.start + 1.6 && b.pageTitle) {
      const eye = '● ' + b.pageTitle
      txt(c, eye, BGL.left, top - 18, { size: TY.eyebrow, family: F.disp, weight: 600, color: R(P.lime, 0.85), spacing: 2.6 })
    }
    c.textBaseline = 'alphabetic'
    lines.forEach((ln, li) => {
      const at = b.f0 + li * (b.lineIn || 0.1)
      const k = E.outExpo(clamp(seg(t, at, at + 0.32)))
      if (k <= 0.01) return
      const y = top + li * lh + size * 0.86
      const baseX = BGL.left + (1 - k) * size * 0.10
      c.globalAlpha = k
      drawRuns(c, ln, baseX, y, size, b.style, b.hot, true)
    })
    c.restore()
    // 盒子跟着板走：质检量对比度时，量的就是字所在的那块板
    reg(plate.x, plate.y, plate.w, plate.h, 'big')
  }

  /** 一行字按高亮拆成 before / hot / after 三段画；hot 可以是黄字、荧光绿底黑字、红底白字 */
  function drawRuns(c, ln, x, y, size, style, hot, shadow) {
    const parts = []
    const hotText = hot && ln.includes(hot) ? hot : ''
    const useStyle = hotText ? style : 'plain'
    if (!hotText) parts.push({ text: ln, style: 'plain' })
    else {
      const i = ln.indexOf(hotText)
      if (i > 0) parts.push({ text: ln.slice(0, i), style: 'plain' })
      parts.push({ text: hotText, style: useStyle })
      if (i + hotText.length < ln.length) parts.push({ text: ln.slice(i + hotText.length), style: 'plain' })
    }
    let cx = x
    c.font = font(size, F.sans, 900)
    for (const p of parts) {
      const pw = measure(c, p.text, size, F.sans, 900)
      const accent = p.style === 'yellow'
      const lime = p.style === 'limeMark'
      const red = p.style === 'redBox'
      if (lime || red) {
        const padX = size * 0.08, padY = size * 0.10
        c.save()
        c.fillStyle = lime ? R(P.lime, 1) : R(P.red, 1)
        c.fillRect(cx - padX, y - size * 0.80 - padY * 0.4, pw + padX * 2, size * 0.92 + padY)
        c.restore()
      }
      c.save()
      if (shadow && !lime && !red) { c.shadowColor = R(P.void, 0.88); c.shadowBlur = 38; c.shadowOffsetY = 9 }
      c.fillStyle = lime || red ? R(P.void, 1) : accent ? R(P.yellow, 1) : R(P.paper, 1)
      c.textAlign = 'left'
      c.fillText(p.text, cx, y)
      c.restore()
      cx += pw
    }
  }

  // ───────── 字幕：一句一张，关键词在行内换色 ─────────
  function drawSub(c, t) {
    const cur = (S.subs || []).find(s => t >= s.f0 && t < s.f1)
    if (!cur) return
    const nb = (S.bigs || []).find(b => t >= b.f0 && t < b.f1)
    if (nb && bare(nb.text) === bare(cur.text)) return
    const kIn = E.outCubic(seg(t, cur.f0, cur.f0 + 0.14))
    const kOut = 1 - seg(t, cur.f1 - 0.10, cur.f1)
    const a = Math.min(kIn, kOut)
    if (a <= 0.01) return
    let size = TY.sub
    const avail = w - M * 2 - SUBL.padX * 2
    let lines = [cur.text]
    if (textEm(cur.text) * size > avail) {
      size = TY.subSmall
      if (textEm(cur.text) * size > avail) {
        // 两行：按词边界切（数据层已经断好过一次，这里只兜底）
        const mid = Math.ceil([...cur.text].length / 2)
        lines = [cur.text.slice(0, mid), cur.text.slice(mid)]
      }
    }
    const lh = size * 1.28
    const ph = Math.round(lines.length * lh + SUBL.padY * 2)
    const pw = Math.round(Math.min(avail, Math.max(...lines.map(l => textEm(l))) * size) + SUBL.padX * 2)
    const cx = w / 2
    const cy = h - SUBL.bottom - ph / 2
    c.save()
    c.globalAlpha *= a
    c.translate(0, (1 - kIn) * 10)
    rrect(c, cx - pw / 2, cy - ph / 2, pw, ph, SUBL.radius)
    c.fillStyle = R(P.void, 0.84); c.fill()
    c.strokeStyle = R(P.paper, 0.10); c.lineWidth = 1.5; c.stroke()
    c.restore()
    c.save()
    c.globalAlpha *= a
    c.translate(0, (1 - kIn) * 10)
    c.font = font(size, F.sans, 700)
    lines.forEach((ln, li) => {
      const runs = cur.runs && lines.length === 1 ? cur.runs : [{ text: ln, style: 'plain' }]
      let total = measure(c, ln, size, F.sans, 700)
      let x = cx - total / 2
      const y = cy - ph / 2 + SUBL.padY + size * 0.86 + li * lh
      for (const r of runs) {
        const rw = measure(c, r.text, size, F.sans, r.style === 'hot' ? 800 : 700)
        c.fillStyle = r.style === 'hot' ? R(P.yellow, 1) : R(P.paper, 1)
        c.textAlign = 'left'
        c.fillText(r.text, x, y)
        x += rw
      }
    })
    c.restore()
    reg(cx - pw / 2, cy - ph / 2, pw, ph, 'sub')
  }

  // ───────── 图形块 ─────────
  const blockCard = (c, x, y, ww, hh, r = 16) => {
    rrect(c, x, y, ww, hh, r)
    c.fillStyle = R(P.void, 0.76); c.fill()
    c.strokeStyle = R(P.paper, 0.13); c.lineWidth = 1.5; c.stroke()
  }

  /** 标签墙的左右两条窄带。哪边真放得下只有 >=140px 才算一条带：
   *  小窗页的人物窗口右对齐，右边根本没有空，按奇偶硬分左右会把标签画到画面外（自测13 实测出画）。 */
  function tagZones(shot) {
    const r = personRect(shot)
    const rawL = r.x - M - 18
    const rawR = w - M - (r.x + r.w + 18)
    return {
      useL: rawL >= 140, useR: rawR >= 140,
      left: { x: M, w: Math.max(140, rawL) },
      right: { x: r.x + r.w + 18, w: Math.max(140, rawR) },
    }
  }
  function tagWall(c, b, t) {
    const items = b.items || []
    const shot = shotAt(t)
    const z = tagZones(shot)
    const onRight = j => z.useR && (!z.useL || j % 2 === 1)
    const r = personRect(shot)
    const top = r.y + 40, bottom = r.y + r.h - 60
    const size = TY.blockSmall + 2
    items.forEach((it, i) => {
      const at = b.f0 + i * 0.13
      const k = E.outBack(clamp(seg(t, at, at + 0.26)))
      if (k <= 0.01) return
      const right = onRight(i)
      const zone = right ? z.right : z.left
      const chipsInZone = items.filter((_, j) => onRight(j) === right).length || 1
      // 槽位按「同侧第几个」算：一侧放不下时所有标签都在另一侧，还按 i/2 排会互相压住
      const slot = items.filter((_, j) => j < i && onRight(j) === right).length
      const y = top + (slot + 0.5) * ((bottom - top) / chipsInZone)
      const cw = Math.min(zone.w, measure(c, it, size, F.sans, 700) + 30)
      const chh = 46
      const x = right ? zone.x : zone.x + Math.max(0, (zone.w - cw) * 0.5)
      c.save()
      c.globalAlpha *= Math.min(1, k)
      c.translate(x + cw / 2, y); c.scale(0.9 + 0.1 * k, 0.9 + 0.1 * k); c.translate(-(x + cw / 2), -y)
      const hot = i === 0
      blockCard(c, x, y - chh / 2, cw, chh, 10)
      if (hot) { c.fillStyle = R(P.paper, 0.96); rrect(c, x, y - chh / 2, cw, chh, 10); c.fill() }
      txt(c, it, x + 15, y + 8, { size, family: F.sans, weight: 700, color: hot ? R(P.void, 1) : R(P.paper, 0.95) })
      c.restore()
      reg(x, y - chh / 2, cw, chh, 'block:tag')
    })
  }

  // 刻度卡：柱高从「过去」到「现在」逐格下降——这是「门槛越来越低」的形状。
  // 自测11 画成了从左往右涨的进度条，标签却写「越来越低」，画面自己说错了话（抽帧对参考片才看出来）。
  // 参考片的柱是五根递减的短柱 + 两端 过去 / 现在 小标，不带任何数值。
  function gauge(c, b, t) {
    const k = clamp(seg(t, b.f0 + 0.2, b.f0 + 0.9))
    const cw = Math.min(430, w - M * 2), chh = 210
    const x = w - M - cw, y = h * 0.575
    c.save()
    c.globalAlpha *= k
    blockCard(c, x, y, cw, chh, 18)
    txt(c, 'BARRIER', x + 24, y + 34, { size: TY.blockSmall - 2, family: F.disp, weight: 700, color: R(P.ash, 0.9), spacing: 3 })
    txt(c, b.label || '门槛', x + 24, y + 74, { size: TY.block + 2, family: F.sans, weight: 900, color: R(P.paper, 1) })
    const cells = 5, gap = 10, cellW = (cw - 48 - gap * (cells - 1)) / cells
    const base = y + 136, tall = 44
    const fill = E.outCubic(k)
    for (let i = 0; i < cells; i++) {
      const cx = x + 24 + i * (cellW + gap)
      // 底槽：整格高，说明这一格「曾经」能到的高度
      rrect(c, cx, base - tall, cellW, tall, 4)
      c.fillStyle = R(P.paper, 0.10); c.fill()
      const hRatio = 1 - i * 0.17
      const on = clamp(fill * 1.6 - i * 0.15)
      const hh = tall * hRatio * clamp(on)
      if (hh > 1) {
        rrect(c, cx, base - hh, cellW, hh, 4)
        c.fillStyle = R(i < 2 ? P.green : P.lime, 0.95); c.fill()
        // 柱顶一道亮线：参考片的柱有边，不是一块糊上去的色块
        line(c, cx, base - hh, cx + cellW, base - hh, R(P.paper, 0.85), 2)
      }
    }
    txt(c, '过去', x + 24, base + 20, { size: TY.blockSmall - 6, family: F.sans, weight: 600, color: R(P.ash, 0.85) })
    const nowW = measure(c, '现在', TY.blockSmall - 6, F.sans, 600)
    txt(c, '现在', x + cw - 24 - nowW, base + 20, { size: TY.blockSmall - 6, family: F.sans, weight: 600, color: R(P.ash, 0.85) })
    txt(c, '越来越低 ↓', x + 24, y + 190, { size: TY.blockSmall + 2, family: F.sans, weight: 700, color: R(P.lime, 0.95) })
    c.restore()
    reg(x, y, cw, chh, 'block:gauge')
  }

  function checkCard(c, b, t) {
    const k = E.outBack(clamp(seg(t, b.f0, b.f0 + 0.3)))
    if (k <= 0.01) return
    const size = TY.block + 2
    const tw = Math.min(w - M * 2, measure(c, b.text, size, F.sans, 800) + 128)
    const cw = tw, chh = 84
    const shot = shotAt(t)
    // 小窗版式的大字现在压在 0.74h 的胸口（以前在 0.50h），对勾卡跟着让到 0.50h：
    // 小窗只到 0.50h，卡正好落在窗口下面、大字上面那块空处。
    let yBase = shot.kind === 'corner' ? h * 0.50 : shot.kind === 'frame' ? h * 0.86 : h * 0.775
    // 满幅页的大字底边也在 0.775h、往上长，卡按原来的位置画就是字压字
    // （自测14 质检抓到 7 帧「big × block:check」重叠 36226px²）。有大字就让到大字上面去：
    // 参考片里图形块本来就在大字上方，卡在大字下面反而挤掉胸口那一片。
    // 这条对**所有**版式都成立：小窗页的卡原来只在满幅页避让大字，
    // 实测竖框页（frame）上大字也在下半区，卡落在 1484–1568px 正好压字
    // （自测15 质检抓到 7 帧「big × block:check」11052px²）。有大字就一律让到大字上方。
    // 让位按「这张卡活着的整段」算，不按当前这一帧算，理由两条：
    //  ① 卡跨两句大字时，按当前帧算会在第二句起来的瞬间往上跳一下（自测21 第 1104 帧：
    //     卡 34.167–37.017s，前半段那句大字 size 106、后半段 121，卡在中途跳了 16px）；
    //  ② 缝要量到**底板**上沿，不是墨迹上沿——自测18 给大字加了 0.14×字号的内边距，
    //     墨迹让 22px 实际到板只剩 5px，卡贴着板边，看着就像压在一起。
    // 定死一条：卡底 = 这段里**最高那块板**的上沿 − 22px。位置不随时间动，
    // 质检那份按数据重算的盒子（src/layout-boxes.mjs）才可能算出和画面同一个数。
    let plateTop = null
    for (const b2 of S.bigs || []) {
      // 被章节卡压住的那段不算：那 1.5 秒它根本没画出来（质检盒子也按同一条口径裁）
      if (b2.f1 <= Math.max(b.f0, bigVisibleFrom(b2)) || b2.f0 >= b.f1) continue
      const pt = bigGeom(b2).plateTop
      if (plateTop === null || pt < plateTop) plateTop = pt
    }
    if (plateTop !== null) yBase = Math.max(h * 0.30, plateTop - 22)
    // 小窗页原来把卡放在 0.86h，正好压在字幕 pill 上（自测14 抓到 7 帧「sub × block:check」）。
    // 卡底不许越过字幕顶——这条对三种版式都成立。
    const subPh = Math.round(TY.sub * 1.28 + SUBL.padY * 2)
    yBase = Math.min(yBase, h - SUBL.bottom - subPh - 12)
    const x = M, y = Math.round(yBase) - chh
    c.save()
    c.globalAlpha *= Math.min(1, k)
    c.translate(M, y); c.scale(0.94 + 0.06 * k, 0.94 + 0.06 * k); c.translate(-M, -y)
    blockCard(c, x, y, cw, chh, 16)
    dot(c, x + 42, y + chh / 2, 17, R(P.lime, 1))
    c.strokeStyle = R(P.void, 1); c.lineWidth = 4; c.beginPath()
    c.moveTo(x + 34, y + chh / 2); c.lineTo(x + 40, y + chh / 2 + 7); c.lineTo(x + 51, y + chh / 2 - 8); c.stroke()
    txt(c, b.text, x + 72, y + chh / 2 + size * 0.36, { size, family: F.sans, weight: 800, color: R(P.paper, 1) })
    c.restore()
    reg(x, y, cw, chh, 'block:check')
  }

  function banner(c, b, t) {
    const k = E.outExpo(clamp(seg(t, b.f0, b.f0 + 0.26)))
    if (k <= 0.01) return
    const text = b.text || ''
    const size = TY.block + 6
    const bh = 56
    // 两条斜杠压在胸口，不压脸：0.455/0.545h 正好横穿眼睛和鼻子（自测13 抽帧里眼睛被红条盖住 2.3 秒）。
    // 抬到下巴以下、大字以上这一段（0.575 / 0.635h）才读得懂「划掉」又能看见人。
    for (let i = 0; i < 2; i++) {
      const ang = (i ? 2.6 : -2.2) * Math.PI / 180
      const y = h * (i ? 0.635 : 0.575)
      c.save()
      c.globalAlpha *= Math.min(1, k) * (i ? 0.92 : 1)
      c.translate(w / 2, y); c.rotate(ang)
      const bw = w * 1.1
      c.fillStyle = R(P.red, 0.96)
      c.fillRect(-bw / 2, -bh / 2, bw, bh)
      const unit = measure(c, text, size, F.sans, 900) + 74
      const reps = Math.max(2, Math.floor((bw - 48) / unit))
      for (let r = 0; r < reps; r++) {
        const x = -bw / 2 + 26 + r * unit
        txt(c, text, x, 12, { size, family: F.sans, weight: 900, color: R(P.void, 1) })
        txt(c, '×', x + measure(c, text, size, F.sans, 900) + 20, 12, { size: size + 6, family: F.sans, weight: 900, color: R(P.void, 1) })
      }
      c.restore()
      reg(0, y - bh / 2, w, bh, 'block:banner')
    }
  }

  function dataLine(c, b, t) {
    const k = clamp(seg(t, b.f0, b.f0 + 1.0))
    if (k <= 0.01) return
    const x0 = M, x1 = w - M, y0 = h * 0.66, y1 = h * 0.44
    const pts = []
    for (let i = 0; i < 5; i++) pts.push([lerp(x0, x1, i / 4), lerp(y0 + 20, y1, Math.pow(i / 4, 1.5)) + (i % 2 ? -12 : 8)])
    c.save()
    glowStroke(c, () => polyProgress(c, pts, k), P.lime, 3, 0.90)
    pts.forEach((p, i) => {
      const q = clamp((k * 5 - i) / 1)
      if (q <= 0) return
      glowDot(c, p[0], p[1], 5 * q, P.lime, 0.8)
    })
    c.restore()
    reg(pts[0][0], pts[pts.length - 1][1], x1 - x0, y0 - y1 + 20, 'block:line')
  }

  function avatarCard(c, b, t) {
    const k = E.outCubic(clamp(seg(t, b.f0, b.f0 + 0.3)))
    if (k <= 0.01) return
    const cw = Math.min(560, w - M * 2), chh = 132
    const x = M, y = h * 0.32
    c.save()
    c.globalAlpha *= k
    c.translate(0, (1 - k) * 12)
    blockCard(c, x, y, cw, chh, 18)
    ring(c, x + 52, y + chh / 2, 30, R(P.lime, 0.9), 3)
    const initials = [...b.name].slice(0, 1).join('')
    txt(c, initials, x + 52, y + chh / 2 + 14, { size: 34, family: F.sans, weight: 900, color: R(P.lime, 1), align: 'center' })
    txt(c, b.name, x + 100, y + 58, { size: 34, family: F.sans, weight: 900, color: R(P.paper, 1) })
    txt(c, 'AUTHOR', x + 100, y + 92, { size: TY.blockSmall - 2, family: F.disp, weight: 700, color: R(P.ash, 0.9), spacing: 3 })
    c.restore()
    reg(x, y, cw, chh, 'block:avatar')
  }

  // ───────── 句子级小标签：说过就留在屏上 ─────────
  // 折光同一屏能叠三五张小标签：一句话说一个词条，词条冒出来就不走，下一句再叠一张。
  // 只画 scene.chips 里的词（术语表 / 拉丁专名 / 已挑成大字高亮的词），时间是它被说出来的那一刻。
  const CHIPL = L.chips || { lanes: [0.255, 0.345, 0.435], left: M, right: 150, h: 46, padX: 20 }
  function chipLayer(c, t, shot) {
    if (shot.kind === 'card' || shot.kind === 'outro') return
    const list = (S.chips || []).filter(x => t >= x.f0 && t < x.f1)
    if (!list.length) return
    const size = TY.chip || 24
    for (const chip of list) {
      const k = Math.min(E.outCubic(clamp(seg(t, chip.f0, chip.f0 + 0.26))), 1 - clamp(seg(t, chip.f1 - 0.30, chip.f1)))
      if (k <= 0.02) continue
      const cw = Math.round(measure(c, chip.text, size, F.sans, 700) + CHIPL.padX * 2)
      const hh = CHIPL.h
      // 位置 = 泳道 + 每张自己的偏移（偏移存在 scene.json 里，质检盒子读同一份）
      const y = h * ((CHIPL.lanes || [])[chip.lane] || 0.3) + (chip.dy || 0)
      // 小窗/竖框页：标签贴着人物窗口的边排，不飘到画面最外侧（参考片的标签就是紧贴窗口的一列）
      // 满幅页：人物是整幅，标签压在画面左右两条边上，中间的脸留空
      const x0 = (shot.kind === 'frame' || shot.kind === 'corner')
        ? (chip.side ? personRect(shot).x + personRect(shot).w + 18 : personRect(shot).x - 18 - cw)
        : (chip.side ? w - CHIPL.right - cw : CHIPL.left)
      // 右边只让到页边（不是平台安全区的 150）：标签都在 0.20–0.44h 的上半区，
      // 平台按钮压的是下半区；按 150 卡死时，长词（Claude）会被钉在 74% 线上 0.2px，判成「压脸」。
      const x = Math.max(M, Math.min(w - M - cw, x0 + (chip.dx || 0)))
      c.save()
      c.globalAlpha *= k
      // 从边上滑进来一点点：静止出现像贴图，滑进来才像「跟着这句话冒出来」
      c.translate((chip.side ? 1 : -1) * (1 - k) * 18, 0)
      rrect(c, x, y - hh / 2, cw, hh, 10)
      c.fillStyle = R(P.void, 0.72); c.fill()
      c.strokeStyle = R(P.paper, 0.16); c.lineWidth = 1.5; c.stroke()
      txt(c, chip.text, x + CHIPL.padX, y + size * 0.35, { size, family: F.sans, weight: 700, color: R(chip.hot ? P.lime : P.paper, 0.95) })
      c.restore()
      reg(x, y - hh / 2, cw, hh, 'block:chip')
    }
  }

  // ───────── 全屏字卡 / 结尾画中画 ─────────
  function cardShot(c, t, shot, img) {
    // 字卡的正文要撑满整个卡片时长：自测16 的 50.0–53.3s 那张卡里两条大字之间有空档，
    // 空档处按「此刻有没有大字」取文本会取到空串——以前整屏荧光绿把这件事盖住了，
    // 改成暗底之后就是一秒黑屏。这里改成取卡片窗口内的第一条/当前条大字。
    const win = (S.bigs || []).filter(x => x.f1 > shot.f0 + 0.01 && x.f0 < shot.f1 - 0.01)
    const b = win.find(x => t >= x.f0 && t < x.f1) || win[0] || null
    const page = pageAt(t)
    // 字卡是「让画面停下来听一句话」，不是整屏刷荧光绿。
    // 自测16 量出来全片强调色占 9.29%、参考片只有 0.97%——99.4% 的那些帧全来自两张整屏绿卡，
    // 它们同时是全片最亮的帧（Y=229，全片平均 106），把亮度波动拉到参考片的 1.49×。
    // 改成暗底 + 纸白大字 + 一个绿词：强调色回到参考片的量级，也不再一屏闪白。
    // 底色不用纯黑：把这一帧的本人压暗、虚化当底纹。纯黑卡片一下把全片平均亮度砸掉 19 级
    // （106 → 86.8），而且 2–3 秒的黑屏在时间线上是「画面死了」；参考片的字卡背后始终还是这个人。
    if (img && img.width) {
      c.save()
      // 0.40 是量出来的下限：调到 0.55 时字卡上的白字压在虚化后的人脸上只有 1.03:1（质检 32s 抓到）
      c.filter = 'blur(24px) brightness(0.40) saturate(0.6)'
      const s = Math.max(w / img.width, h / img.height) * 1.18
      const dw = img.width * s, dh = img.height * s
      c.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
      c.restore()
      c.fillStyle = R(P.void, 0.40)
      c.fillRect(0, 0, w, h)
    } else {
      c.fillStyle = R(P.void, 1)
      c.fillRect(0, 0, w, h)
    }
    cornerTicks(c, M, M, w - M * 2, h - M * 2, 26, R(P.paper, 0.20), 3)
    // ── 字卡的版面结构（自测18）──
    // 自测17 把整屏荧光绿换成暗底之后，字卡就剩「一行字 + 一条绿线」——抽帧对照参考片，
    // 中间那一大片是空的，看起来像没画完。参考片同类的卡上永远有三层：小字眉、正文、页码层。
    // 这里补的都是从数据来的东西（页码、下一页码、章节序号），没有一个是编出来的文案。
    if (page) {
      const pg = n => String(n).padStart(2, '0')
      // 左下：巨大的半透明章节序号，压住画面的一角
      const numSize = Math.round(h * 0.17)
      c.save()
      c.globalAlpha *= 0.13
      txt(c, pg(page.index), M - 6, h - Math.round(h * 0.055), { size: numSize, family: F.disp, weight: 800, color: R(P.lime, 1), spacing: -4 })
      c.restore()
      line(c, M, Math.round(h * 0.795), M + 96, Math.round(h * 0.795), R(P.lime, 0.55), 3)
      // 右上：页码流转 —— 参考片的字卡上都标着「P.02 → P.03」，观众知道自己在第几段
      const nxt = page.index < page.total ? pg(page.index + 1) : null
      const marker = nxt ? 'P.' + pg(page.index) + '  →  P.' + nxt : 'P.' + pg(page.index) + '  /  ' + pg(page.total)
      const mSize = TY.eyebrow
      const mw = measure(c, marker, mSize, F.disp, 700, 2.4)
      txt(c, marker, w - M - mw, HUD_Y + 66, { size: mSize, family: F.disp, weight: 700, color: R(P.ash, 0.92), spacing: 2.4 })
    }
    const text = b ? b.text : (page && page.title) || ''
    if (!text) return
    const lines = (b && b.lines && b.lines.length) ? b.lines : [text]
    const size = Math.min(TY.big + 56, Math.floor((w - M * 2) / Math.max(1, ...lines.map(l => textEm(l)))))
    const lh = size * 1.02
    const top = (h - lines.length * lh) / 2 - 40
    c.save()
    // 小字眉用页面标题（原话摘的），不是编出来的英文
    // 小字眉和正文是同一句话时不画（自测16 的 32s 那屏上写了「知道的人会做的人」两遍，
  // 看着像渲染重了）。
    const eye = page && page.title ? page.title : 'WHY'
    const dupEye = bare(eye).includes(bare(text)) || bare(text).includes(bare(eye))
    if (!dupEye) {
      txt(c, eye, M, top - 52, { size: TY.eyebrow + 2, family: F.disp, weight: 700, color: R(P.lime, 0.85), spacing: 4 })
      line(c, M, top - 34, M + 56, top - 34, R(P.lime, 0.5), 3)
    }
    c.textBaseline = 'alphabetic'
    lines.forEach((ln, i) => {
      const at = (b ? b.f0 : t) + i * 0.12
      const k = E.outExpo(clamp(seg(t, at, at + 0.40)))
      c.globalAlpha = k
      // 沿用大字的强调规则：一个词进荧光绿/红底，其余纸白；字卡不再整屏上色
      drawRuns(c, ln, M + (1 - k) * size * 0.12, top + i * lh + size * 0.88, size, b ? b.style : 'plain', b ? b.hot : '', false)
    })
    // 一条短绿线压住正文：卡片上除了大字什么都没有，空得像没画完（自测16 对比抽帧看到的）
    line(c, M, top + lines.length * lh + 22, M + 74, top + lines.length * lh + 22, R(P.lime, 0.92), 4)
    c.restore()
    reg(M, top - 60, w - M * 2, lh * lines.length + 80, 'big')
  }

  return {
    frames: S.frames,
    fps: S.fps,
    async prepare(f) {
      const i = srcIdx(f)
      await media.need([['person', i]])
      media.prefetch([['person', i + 1], ['person', i + 2]])
    },
    samples(f) {
      const t = f / S.fps
      const shot = shotAt(t)
      return shot && shot.f0 > t - 0.4 && shot.f0 <= t ? 1 : 0.5
    },
    draw(c, t, f) {
      const shot = shotAt(t)
      const img = media.frame('person', srcIdx(f))
      c.fillStyle = R(P.void, 1)
      c.fillRect(0, 0, w, h)
      if (shot.kind === 'card') cardShot(c, t, shot, img)
      else {
        drawPerson(c, img, shot)
        scrim(c, shot, t)
        frameMarks(c, shot)
      }
      const onCard = shot.kind === 'card'
      const onOutro = shot.kind === 'outro'
      // 图形块压在大字下面，先画；色卡是纯字卡，上面不叠任何块
      if (!onCard) {
        for (const b of blockAt(t)) {
          if (b.kind === 'tagwall') tagWall(c, b, t)
          else if (b.kind === 'gauge') gauge(c, b, t)
          else if (b.kind === 'check') checkCard(c, b, t)
          else if (b.kind === 'banner' && !onOutro) banner(c, b, t)
          else if (b.kind === 'avatar') avatarCard(c, b, t)
        }
        chipLayer(c, t, shot)
        if (!onOutro) {
          const act = (S.bigs || []).find(b => t >= b.f0 && t < b.f1)
          if (act) drawBig(c, act, t, shot)
        }
        chapterCard(c, t)
      }
      // 字卡改成暗底之后，HUD 也回到亮墨（dark=true 只给亮底用）
      chrome(c, t, false)
      if (onCard) return
      if (onOutro) {
        const page = pageAt(t)
        if (page && page.title) {
          txt(c, 'END', M, h * 0.685, { size: TY.eyebrow, family: F.disp, weight: 700, color: R(P.lime, 0.9), spacing: 4 })
          const tsize = Math.min(64, Math.floor((w - M * 2) / Math.max(1, textEm(page.title))))
          txt(c, page.title, M, h * 0.685 + 68, { size: tsize, family: F.sans, weight: 900, color: R(P.paper, 1) })
        }
        return
      }
      drawSub(c, t)
    },
    cues: () => S.cues,
    // vig 0.30 → 0.18：叠在上面那层压光之上，边缘再乘一次暗化，全片平均亮度被吃掉一大截
  post: () => ({ bloom: 0.20, grain: 0.020, vig: 0.10, ca: 0.8 }),
    qa() { const b = QA.boxes; QA.boxes = []; return { boxes: b, layout: { shots: (S.shots || []).length, pages: (S.pages || []).length } } },
  }
}
