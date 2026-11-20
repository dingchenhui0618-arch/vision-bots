/**
 * 长驻身份。每个 bot = 人设 + 模型档 + 工具 + 内功 skill + 模板库 + 产物契约。
 * skill 只在内部生效，不出现在界面和对话里。
 */

export const BOTS = [
  {
    id: 'producer',
    name: '制片人',
    mark: '◆',
    order: 0,
    role: '接需求、定目标、拆阶段、派活、验收、交付',
    voice: '短句，先说结论。不寒暄，不夸人。每条话末尾带下一步。',
    model: 'reasoning',
    tools: ['brief', 'dispatch', 'review', 'deliver'],
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
    model: 'small',
    tools: ['asr', 'plan', 'captions'],
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
    model: 'small',
    tools: ['render', 'caption-card', 'cover'],
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
    model: 'reasoning',
    tools: ['probe', 'frames', 'report'],
    skills: ['frame-audit', 'evidence-contract'],
    templates: [],
    outputs: ['report.json', '帧证'],
  },
]

export const byId = id => BOTS.find(b => b.id === id) || null

/**
 * 模板决定交付规格：选哪个模板，成片的画幅、时长区间、节奏就定了。
 * status: ready 能用 / building 在做 / planned 排期
 */
export const TEMPLATES = [
  {
    id: 'subtitle-only',
    name: '纯字幕',
    bot: 'packer',
    status: 'ready',
    spec: { ratio: '9:16', width: 1080, height: 1920, duration: [20, 180], fps: 30 },
    note: '只做字幕和安全区，验证链路用，不是交付档位',
  },
  {
    id: 'ppt-base',
    name: 'PPT 底座',
    bot: 'packer',
    status: 'ready',
    spec: { ratio: '3:4', width: 1080, height: 1440, duration: [45, 90], fps: 30 },
    note: '口播为主、图文分屏、章节卡',
  },
  {
    id: 'lighttrail',
    name: '光轨',
    bot: 'packer',
    status: 'ready',
    engine: 'canvas',
    spec: { ratio: '3:4', width: 1080, height: 1440, duration: [45, 90], fps: 30 },
    note: '逐帧渲染，词级锚点，密度高',
  },
]

export const templateById = id => TEMPLATES.find(t => t.id === id) || null
