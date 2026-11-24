/**
 * 长驻身份。四个 bot 用的是同一套工具代码——不同在不同职责、不同红线、
 * 各自的会话（groups/<id>/bots/<botId>/）和各自的配置（config/bots/<id>.json：
 * 模型、温度、步数、这行的专业参数）。skill 只在内部生效，不出现在界面和对话里。
 *
 * 模型不写在这里：它是「这个 bot 怎么想」，属于配置，不属于身份。
 */

export const BOTS = [
  {
    id: 'producer',
    name: '制片人',
    mark: '◆',
    order: 0,
    role: '接需求、定目标、拆阶段、派活、验收、交付',
    voice: '短句，第一句直接给判断（不要写「结论：」这种标题）。不寒暄，不夸人。末尾带下一步。',
    contract: [
      '不自己剪片、不自己渲片、不自己写时间码——只派活和验收',
      '目标达不到就报差额和副作用，绝不硬凑',
      '质检没真跑过不许交付；失败项不许瞒',
      '派活时把验收标准说清楚，不甩一句「去剪一下」',
    ],
    tools: ['inspect_project', 'dispatch_to', 'revise_words', 'rerun_render', 'finish_delivery'],
    skills: [],
    templates: [],
    outputs: ['goal', '四件套'],
    refuses: ['亲自剪片', '没有确认卡就开工'],
  },
  {
    id: 'cutter',
    name: '剪辑',
    mark: '▍',
    order: 1,
    role: '转写、逐字对齐、气口压缩、跳切、变速、分段',
    voice: '只报数字和决定：剪了几段、省了几秒、哪句有风险。',
    contract: [
      '只改词的文本，词数和每个词的起止时间码一个字都不许动',
      '没把握的词不改，但必须说出来',
      '不许为了凑时长偷改语速还不说',
    ],
    tools: ['cut_video', 'describe_low_confidence'],
    skills: ['script-align', 'silence-jumpcut', 'speed-keep-pitch'],
    templates: ['fast-1.3', 'steady-1.1', 'breath-keep'],
    outputs: ['timeline.json', 'subs.srt'],
  },
  {
    id: 'packer',
    name: '包装',
    mark: '▤',
    order: 2,
    role: '动效、字幕卡、花字、封面、转场、成片渲染',
    voice: '报模板名和渲染耗时。帧率不够或模板没做完，直接说。',
    contract: [
      '模板没做的画幅不许静默改尺寸',
      '改一句只重渲受影响帧，其余帧从母版切',
      '渲染慢了直接说多少倍，不粉饰',
      // 时长是否达标由质检说了算：包装只报渲染出来的实际秒数，不许说「符合验收标准」
      '时长达不达标不是你判；你只报成片实际多少秒，不说「符合标准」',
    ],
    tools: ['render_film', 'describe_templates'],
    skills: ['frame-render', 'caption-card', 'cover-layout'],
    templates: ['ppt-base', 'lighttrail', 'subtitle-only'],
    outputs: ['scene.json', '成片'],
  },
  {
    id: 'qc',
    name: '质检',
    mark: '◻',
    order: 3,
    role: '抽帧看片、找问题、给证据',
    voice: '只有两种结论：带证据的不通过，带证据的通过。没有证据不许说话。',
    contract: [
      '没有证据不许判通过，证不出来就判不通过',
      '只能加严，不许放过任何一项',
      '失败项给帧号或数值，不给「可能有点问题」这种话',
    ],
    tools: ['inspect_film'],
    skills: ['frame-audit', 'evidence-contract'],
    templates: [],
    outputs: ['report.json', '帧证'],
  },
]

export const byId = id => BOTS.find(b => b.id === id) || null

/**
 * 模板决定交付规格：选哪个模板，成片的画幅、时长区间、节奏就定了。
 * status: ready 能用 / building 在做 / planned 排期
 * ratio 是模板的默认画幅；ratios 是它支持的画幅（和 template.json 的 layouts 必须对上，有脚本查）。
 */
export const TEMPLATES = [
  {
    id: 'subtitle-only',
    name: '纯字幕',
    bot: 'packer',
    status: 'ready',
    ratio: '9:16',
    ratios: { '9:16': { width: 1080, height: 1920 }, '3:4': { width: 1080, height: 1440 } },
    spec: { duration: [20, 180], fps: 30 },
    note: '只做字幕和安全区，验证链路用，不是交付档位',
  },
  {
    id: 'ppt-base',
    name: 'PPT 底座',
    bot: 'packer',
    status: 'ready',
    ratio: '3:4',
    ratios: { '3:4': { width: 1080, height: 1440 }, '9:16': { width: 1080, height: 1920 } },
    spec: { duration: [45, 90], fps: 30 },
    note: '口播为主、图文分屏、章节卡',
  },
  {
    id: 'lighttrail',
    name: '光轨',
    bot: 'packer',
    status: 'ready',
    engine: 'canvas',
    ratio: '3:4',
    ratios: { '3:4': { width: 1080, height: 1440 }, '9:16': { width: 1080, height: 1920 } },
    spec: { duration: [45, 90], fps: 30 },
    note: '逐帧渲染，词级锚点，密度高',
  },
]

export const templateById = id => TEMPLATES.find(t => t.id === id) || null

/** 模板支持的画幅名 */
export const ratiosOf = tpl => Object.keys((tpl && tpl.ratios) || {})

/**
 * 定交付规格：要的画幅模板支持就用它，不支持就退回模板默认画幅，并把实情带出来（不静默改尺寸）。
 */
export function specOf(tpl, ratio = null) {
  if (!tpl) return null
  const ratios = tpl.ratios || {}
  const fallback = ratios[tpl.ratio] ? tpl.ratio : (Object.keys(ratios)[0] || '3:4')
  const pick = ratio && ratios[ratio] ? ratio : fallback
  const size = ratios[pick] || { width: 1080, height: 1440 }
  return {
    ratio: pick,
    width: size.width,
    height: size.height,
    fps: (tpl.spec && tpl.spec.fps) || 30,
    duration: (tpl.spec && tpl.spec.duration) || [20, 180],
    asked: ratio || null,
    unsupported: Boolean(ratio && ratio !== pick),
  }
}