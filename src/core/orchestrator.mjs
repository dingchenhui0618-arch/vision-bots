/**
 * 编排：制片人只听用户，派活给谁由阶段决定；每个 bot 干完在自己的群里说话。
 * 模型只做判断和措辞，不碰时间码——所有数字来自管线。
 */
import { Runner } from './runner.mjs'
import { runCut } from '../handlers/cut.mjs'
import { runPack } from '../handlers/pack.mjs'
import { runQc } from '../handlers/qc.mjs'
import { TEMPLATES, templateById, specOf, ratiosOf } from '../bots/roster.mjs'

const PLATFORMS = ['视频号', '抖音', '小红书']
const PLATFORM_HINT = /视频号|抖音|小红书|B站|快手/

// 短视频平台都是竖屏优先：用户没提画幅时按平台给默认值，卡片上可以改。
const PLATFORM_RATIO = { 抖音: '9:16', 视频号: '9:16', 小红书: '9:16', 快手: '9:16', B站: '9:16' }
const RATIO_HINT = [
  [/竖屏|竖版|9s*[:：]s*16|手机/, '9:16'],
  [/横屏|横版|16s*[:：]s*9|宽屏/, '16:9'],
  [/3s*[:：]s*4/, '3:4'],
]

const guessPlatform = text => (String(text).match(PLATFORM_HINT) || [])[0] || '视频号'

/** 画幅：用户明说了就听用户，没说按平台默认 */
function guessRatio(text, platform) {
  const s = String(text || '')
  for (const [re, r] of RATIO_HINT) if (re.test(s)) return r
  return PLATFORM_RATIO[platform] || '9:16'
}

function guessDuration(text) {
  const s = String(text)
  const m = s.match(/(\d+)\s*秒/)
  if (m) return Number(m[1])
  const n = s.match(/(\d+)\s*分钟/)
  if (n) return Number(n[1]) * 60
  return 60
}

function guessTemplate(text) {
  const s = String(text)
  if (/光轨/.test(s)) return 'lighttrail'
  if (/ppt|PPT|底座/.test(s)) return 'ppt-base'
  return 'subtitle-only'
}

export class Orchestrator {
  constructor(group) {
    this.group = group
    this.runner = new Runner(group)
  }

  /** 用户在群里说一句话；带素材就会一起进来。 */
  async say(text, { assets = [] } = {}) {
    this.group.user(text || '', assets.length ? { assets } : {})
    if (assets.length) {
      const added = this.group.addAssets(assets)
      this.group.emit({ type: 'assets', files: added, name: added.map(a => a.split(/[\\/]/).pop()).join('、') })
    }
    const phase = this.group.meta.phase
    if (phase === 'intake') return this.intake(text)
    if (phase === 'confirm') return this.awaitConfirm(text)
    if (phase === 'delivered') return this.revise(text)
    return this.busy(text)
  }

  async intake(text) {
    const assets = this.group.meta.assets || []
    const hasBrief = Boolean(String(text || '').trim())
    if (!assets.length) {
      this.group.say('producer', '素材呢？把口播视频拖进群里。\n有稿子一起给，没有也行，我让剪辑直接听。')
      return { phase: 'intake', waiting: 'assets' }
    }
    if (!hasBrief) {
      this.group.say('producer', '素材收到了。\n想要什么：平台、大概多长、有没有稿子。一句话说完就行。')
      return { phase: 'intake', waiting: 'brief' }
    }

    const platform = guessPlatform(text)
    const brief = {
      platform,
      ratio: guessRatio(text, platform),
      duration: guessDuration(text),
      template: guessTemplate(text),
      hasScript: /有稿|稿子.*(给|在)|按稿/.test(String(text)),
      banned: '',
      speed: 1,
      createdAt: new Date().toISOString(),
    }
    this.group.meta.brief = brief
    this.group.save()

    const tpl = templateById(brief.template)
    const spec = specOf(tpl, brief.ratio)
    const ratioText = spec.ratio + ' · ' + spec.width + '×' + spec.height + (spec.unsupported ? '（' + tpl.name + ' 没有 ' + spec.asked + '）' : '')
    this.group.emit({
      type: 'card',
      card: {
        id: 'brief',
        title: '开工确认',
        subtitle: `素材 ${assets.map(a => a.split(/[\\/]/).pop()).join('、')}，按这张卡开始`,
        fields: [
          { key: 'platform', label: '平台', value: brief.platform, options: PLATFORMS },
          { key: 'ratio', label: '画幅', value: ratioText, options: ratiosOf(tpl) },
          { key: 'duration', label: '时长', value: brief.duration + 's', options: ['45s', '60s', '90s'] },
          { key: 'template', label: '模板', value: tpl ? tpl.name : brief.template, options: TEMPLATES.map(t => t.name + (t.status === 'ready' ? '' : '（在建）')) },
          { key: 'hasScript', label: '稿子', value: brief.hasScript ? '有稿' : '没稿，直接口播', options: ['没稿，直接口播', '有稿'] },
        ],
        actions: ['开始', '先去改改'],
      },
    })
    this.group.setPhase('confirm')
    this.group.say('producer', `我按你说的填好了：${brief.platform} · ${spec.ratio} · ${brief.duration}s · ${tpl ? tpl.name : brief.template}。\n看一眼，没问题就点开始。`)
    return { phase: 'confirm', brief }
  }

  async awaitConfirm(text) {
    if (/^开始|确认|开工|go/i.test(String(text || '').trim())) return this.confirm({})
    this.group.say('producer', '卡在上面，改哪个字段直接说，或者说「开始」。')
    return { phase: 'confirm' }
  }

  /** 确认卡落地 → 定 Goal → 派活。 */
  async confirm(values = {}) {
    const brief = { ...(this.group.meta.brief || {}), ...cleanValues(values) }
    if (!brief.template) brief.template = guessTemplate('')
    this.group.meta.brief = brief
    if (brief.template) this.group.meta.template = brief.template
    this.group.save()

    const tpl = templateById(brief.template)
    const spec = specOf(tpl, brief.ratio)
    if (spec.unsupported) {
      this.group.say('producer', `${tpl.name} 还没做 ${spec.asked}，这条按 ${spec.ratio} 出。\n要 ${spec.asked} 我另排一版布局，时间线不用重剪。`)
      brief.ratio = spec.ratio
    }
    this.group.say('producer',
      `定了。\n目标：${brief.platform}，${brief.duration}s，${tpl ? tpl.name + '（' + spec.ratio + '，' + spec.width + '×' + spec.height + '）' : brief.template}，${brief.hasScript ? '按稿' : '没稿直接口播'}。\n阶段：剪辑 → 包装 → 质检 → 交付。${brief.hasScript ? '' : '没有稿子，我让剪辑直接听素材，不给你排逐字稿校对。'}`)
    this.group.emit({ type: 'goal', goal: { platform: brief.platform, ratio: spec.ratio, duration: brief.duration, template: brief.template, stages: ['剪辑', '包装', '质检', '交付'] } })

    await this.dispatch(brief)
    return { phase: this.group.meta.phase, brief }
  }

  async dispatch(brief) {
    const state = {}
    try {
      this.group.setPhase('cutting')
      await this.runner.run({ bot: 'cutter', title: '转写与剪辑决策', run: ctx => runCut({ ...ctx, brief, state }) })

      // 主 bot 的验收职责：先核对目标能不能达到，再决定让不让下游开工
      const target = Number(brief.duration) || 0
      const actual = state.plan.outDuration
      let effectiveTarget = target
      if (target && Math.abs(actual - target) > target * 0.15) {
        effectiveTarget = 0
        const short = actual < target
        this.group.say('producer', short
          ? `到不了 ${target}s。素材 ${state.source.duration.toFixed(1)}s，剪完 ${actual.toFixed(1)}s，差 ${(target - actual).toFixed(1)}s。\n要凑到 ${target}s 得把语速压到 ${(state.plan.keptSeconds / target).toFixed(2)}×，声音会发闷，我不做这个决定。这条按 ${actual.toFixed(1)}s 交；你补素材我重剪，不额外收费也不占你时间。`
          : `超了 ${target}s，现在是 ${actual.toFixed(1)}s。\n平台对超时长的限流是真的，我再压一档还是就这样？先说清楚，我按你说的办。`)
        brief.met = { target, actual, ok: false }
      } else {
        brief.met = { target, actual, ok: true }
      }

      this.group.setPhase('packing')
      await this.runner.run({ bot: 'packer', title: '出片', run: ctx => runPack({ ...ctx, brief, state }) })

      this.group.setPhase('qc')
      const job = await this.runner.run({ bot: 'qc', title: '质检', run: ctx => runQc({ ...ctx, brief: { ...brief, duration: effectiveTarget }, state }) })

      await this.deliver(state, job)
    } catch (err) {
      const stuckAt = this.group.meta.phase
      this.group.setPhase('blocked')
      this.group.say('producer', `卡在「${stuckAt}」：${err.message}。\n我看过再给你方案，不用你动手。`)
      throw err
    }
  }

  async deliver(state) {
    this.group.setPhase('delivering')
    const a = this.group.meta.artifacts || {}
    const items = [
      { key: 'video', label: '成片', file: a.video },
      { key: 'subs', label: '字幕', file: a.subs },
      { key: 'timeline', label: '时间线', file: a.timeline },
      { key: 'fix', label: '错字清单', file: a.fix },
      { key: 'report', label: '质检报告', file: a.report },
      { key: 'audit', label: '抽帧', file: a.audit },
    ].filter(i => i.file)

    const report = state.report
    const fix = state.fixReport
    this.group.emit({ type: 'deliver', items, report: report ? { passed: report.passed, checks: report.checks.length } : null })
    this.group.say('producer',
      `交付。\n` + items.map(i => `· ${i.label}：${i.file.split(/[\\/]/).pop()}`).join('\n') +
      `\n封面和发布文案归包装和运营，这条先不占你时间。` +
      (fix && fix.stats && fix.stats.changed ? `字幕里的错字改了 ${fix.stats.changed} 处，清单在错字清单里。` : '') +
      (fix && fix.pending.length ? `还有 ${fix.pending.length} 个词我没把握，没动它，也在清单里——发布前扫一眼那几个字。` : '') +
      (report && report.passed ? '质检全过。' : report ? `质检有 ${report.failed.length} 项没过，看报告。` : ''))
    this.group.setPhase('delivered')
  }

  async revise(text) {
    // 下一版接分段缓存：改一句只重渲相关片段。现在先如实说，别假装已经能。
    this.group.say('producer', '收到，记下了。\n分段缓存还没接，改动目前整条重跑；接完以后改一句只重渲那两段。要现在就重跑就说「重跑」。')
    return { phase: 'delivered' }
  }

  async busy() {
    this.group.say('producer', '在跑，跑完我报。\n要改的话现在说，我记进这版。')
    return { phase: this.group.meta.phase }
  }
}

function cleanValues(v = {}) {
  const out = {}
  if (v.platform) out.platform = String(v.platform)
  if (v.ratio) out.ratio = String(v.ratio).replace(/\s+/g, '')
  if (v.duration) out.duration = Number(String(v.duration).replace(/[^0-9.]/g, '')) || undefined
  if (v.template) {
    const t = TEMPLATES.find(x => x.id === v.template || x.name === v.template)
    if (t) out.template = t.id
  }
  if (v.hasScript !== undefined) out.hasScript = Boolean(v.hasScript)
  if (v.banned !== undefined) out.banned = String(v.banned)
  return Object.fromEntries(Object.entries(out).filter(([, x]) => x !== undefined))
}
