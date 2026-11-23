/**
 * bot 的手。每个工具都是确定性代码，模型只能选它、传参，改不了里面的时间码。
 *
 * 分工：
 *   制片人 —— 看项目、派活、改一句、重出、验收交付
 *   剪辑   —— 转写对齐、错字治理、气口压缩、字幕卡
 *   包装   —— 按模板逐帧出片、编码
 *   质检   —— 抽帧、量数值、语义审读
 *
 * 主 bot 的 dispatch_to 是小 bot 的入口：派活 → 小 bot 自己跑一轮 → 结论回流。
 */
import { join } from 'node:path'
import { probe } from '../probe.mjs'
import { templateById, specOf, TEMPLATES } from '../bots/roster.mjs'

const sec = n => Number(n).toFixed(1)

/** 项目现状：主 bot 说话的底气来自这里，不是猜的 */
export async function inspectProject({ group, brief, state }) {
  const assets = group.meta.assets || []
  const tpl = templateById(group.meta.template || brief.template) || null
  const spec = tpl ? specOf(tpl, brief.ratio) : null
  let src = state.source || null
  if (!src && assets.length) {
    try { src = await probe(assets[0]); state.source = state.source || src } catch { src = null }
  }
  const sourceSec = src ? Number(src.duration.toFixed(2)) : null
  const targetSec = Number(brief.duration) || null
  return {
    assets: assets.length,
    assetName: assets.length ? assets[0].split(/[\\/]/).pop() : null,
    sourceSec,
    sourceSize: src ? src.width + '×' + src.height : null,
    targetSec,
    template: tpl ? tpl.name : null,
    ratio: spec ? spec.ratio : null,
    size: spec ? spec.width + '×' + spec.height : null,
    maxPossibleSec: sourceSec,
    gapSec: sourceSec !== null && targetSec ? Number((targetSec - sourceSec).toFixed(1)) : null,
    // 剪辑跑过之后这个数才是真的可达时长（素材去掉气口之后还剩多少）
    outSec: state.plan ? Number(state.plan.outDuration.toFixed(1)) : null,
    cutSec: state.plan ? Number(state.plan.cutSeconds.toFixed(1)) : null,
    hasTimeline: Boolean(state.plan),
    reportRan: Boolean(state.report),
    reportPassed: state.report ? Boolean(state.report.passed) : null,
    hasScript: Boolean(brief.hasScript),
    stage: group.meta.phase,
  }
}

/** 每个 bot 能调的工具。job 是这次派活的执行单元（handler 要用它建工作目录）。 */
export function toolsFor(botId, { group, brief, state, runner, director }) {
  const cutJob = () => director.currentJob('cutter')
  const packJob = () => director.currentJob('packer')
  const qcJob = () => director.currentJob('qc')

  if (botId === 'producer') {
    return [
      {
        name: 'inspect_project',
        label: '看项目现状',
        description: '看这个项目现在的真实情况：素材多长、要多久、哪个模板、什么画幅、还能不能达标。说话前先调它。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => inspectProject({ group, brief, state }),
      },
      {
        name: 'dispatch_to',
        label: '派人',
        description: '把一项工作派给下属 bot，它自己会跑一轮再回你结论和真实数字。派活前先说清要它干什么、验收标准是什么。',
        parameters: {
          type: 'object',
          properties: {
            bot: { type: 'string', enum: ['cutter', 'packer', 'qc'], description: '剪辑 / 包装 / 质检' },
            task: { type: 'string', description: '要它干什么，一句话说清目标' },
          },
          required: ['bot', 'task'],
        },
        run: ({ bot, task }) => director.runBot(bot, task),
      },
      {
        name: 'revise_words',
        label: '改这一句',
        description: '把某一句里的词改掉。只改字，词数和每个词的起止时间码一个字都不动——时间线是剪辑定的。',
        parameters: {
          type: 'object',
          properties: {
            from: { type: 'string', description: '要改的原文' },
            to: { type: 'string', description: '改成什么' },
            chapter: { type: 'number', description: '第几章（不确定就不给）' },
          },
          required: ['from', 'to'],
        },
        run: args => director.revise(args),
      },
      {
        name: 'rerun_render',
        label: '按现有时间线重出',
        description: '用现有时间线重出一版。没改字的话画面一帧都不会变，会直接复用母版。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => director.repack('重跑'),
      },
      {
        name: 'finish_delivery',
        label: '交付',
        description: '交付。只有在质检真跑过、失败项都如实说完之后才调得通。',
        parameters: {
          type: 'object',
          properties: { note: { type: 'string', description: '交付时要说的一句话（不带数字）' } },
          additionalProperties: false,
        },
        run: args => director.deliver(args.note || ''),
      },
    ]
  }

  if (botId === 'cutter') {
    return [
      {
        name: 'cut_video',
        label: '开始剪',
        description: '跑完整个剪辑：转写逐字对齐 → 错字治理 → 气口压缩 → 保留区间 → 字幕卡。返回真实统计。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => director.runHandler('cutter', '转写与剪辑决策', cutJob, ctx =>
          director.handlers.cut({ ...ctx, brief, state, narrate: false })),
      },
      {
        name: 'describe_low_confidence',
        label: '查日志',
        description: '这一版转写里识别把握不高的词（这些词不会被改动，要如实报出来）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => {
          const p = state.lowConfidence || []
          return { count: p.length, words: p.slice(0, 12).map(w => ({ w: w.w, at: w.at })) }
        },
      },
    ]
  }

  if (botId === 'packer') {
    return [
      {
        name: 'render_film',
        label: '出片',
        description: '按模板出片：逐帧渲染 → 编码。改过一句的话只重渲受影响的那一段。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => director.runHandler('packer', '出片', packJob, ctx =>
          director.handlers.pack({ ...ctx, brief, state, narrate: false })),
      },
      {
        name: 'describe_templates',
        label: '看模板库',
        description: '现在能做哪些模板、各自什么画幅、什么时长区间。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => ({
          templates: TEMPLATES.map(t => ({ name: t.name, id: t.id, status: t.status, ratios: Object.keys(t.ratios || {}), duration: t.spec?.duration })),
          current: group.meta.template || null,
        }),
      },
    ]
  }

  if (botId === 'qc') {
    return [
      {
        name: 'inspect_film',
        label: '查片',
        description: '查成片：时长、响度、排版、对比度、断行、重复句、置信度、语义审读。每项结论都带证据。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: async () => {
          const r = await director.runHandler('qc', '质检', qcJob, ctx =>
            director.handlers.qc({ ...ctx, brief, state, narrate: false }))
          const n = r && r.narrative ? r.narrative : r
          if (n && n.gapSec) {
            n.note = '时长短 ' + n.gapSec + 's 是素材的物理限制：剪辑已经把气口剪掉了，重剪只会更短。' +
              '要让剪辑再剪一遍解决不了这个差额，只会多花几分钟。'
          }
          return r
        },
      },
    ]
  }

  return []
}
