/**
 * 编排：用户只跟制片人说话；制片人自己看项目、派活、验收、交付。
 *
 * 这一层只做三件事：
 *   1. 状态机（要素材、等确认、跑着、已交付）——规则，不确定的事不交给模型
 *   2. 把「自然语言 → 结构化动作」里稳定的部分做掉（改一句的解析）
 *   3. 硬门兜底：模型忘了验收、忘了报差额，规则补一条系统提示，不静默
 *
 * bot 说的每句话都来自模型（Director → runAgent）；模板句只允许走 group.note。
 */
import { Director } from '../agent/director.mjs'
import { TEMPLATES, templateById, specOf, ratiosOf } from '../bots/roster.mjs'
import { parseEdit } from '../revise.mjs'
import { TARGET_TOLERANCE } from '../qa.mjs'
import { understand, templateLine, PLATFORMS } from '../brief.mjs'

export class Orchestrator {
  constructor(group) {
    this.group = group
    this.state = {}
    this.director = null
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
      this.group.note('素材还没进来。把口播视频拖进群，有稿子一起给，没有也行。')
      return { phase: 'intake', waiting: 'assets' }
    }
    if (!hasBrief) {
      this.group.note('素材收到了。还差一句需求：平台、大概多长、有没有稿子。')
      return { phase: 'intake', waiting: 'brief' }
    }

    // 模型读需求，规则逐个字段校验：用户明说的模型改不掉，模型读岔了也记在 corrected 里
    this.group.emit({ type: 'progress', bot: 'producer', text: '制片人在读需求…', transient: true })
    const u = await understand({ text })
    const brief = { ...u.brief, createdAt: new Date().toISOString() }
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
        why: u.why || null,
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

    // 这段必须由它自己说：模型读岔了、替用户定了什么，都得从它嘴里出来
    const d = new Director(this.group, { brief, state: {} })
    await d.utter('producer', briefTask(brief, u.meta, spec, tpl), {
      platform: brief.platform, duration: brief.duration, width: spec.width, height: spec.height,
      unsupported: spec.unsupported, asked: spec.asked, assumed: brief.assumed, corrected: brief.corrected,
      modelSkipped: u.meta && u.meta.skipped !== 'off' ? (u.meta.skipped || null) : null,
    })
    return { phase: 'confirm', brief }
  }

  async awaitConfirm(text) {
    const s = String(text || '').trim()
    if (/^开始|确认|开工|go/i.test(s)) return this.confirm({})
    // 「先去改改」这类：让它按用户的原话重新读一遍字段
    return this.intake(s + '（用户在看确认卡，要改字段）')
  }

  /** 确认卡落地 → 定 Goal → 派活。派活顺序由制片人自己定，阶段只用来兜底。 */
  async confirm(values = {}) {
    const brief = { ...(this.group.meta.brief || {}), ...cleanValues(values) }
    if (!brief.template) brief.template = 'subtitle-only'
    this.group.meta.brief = brief
    if (brief.template) this.group.meta.template = brief.template
    this.group.save()

    const tpl = templateById(brief.template)
    const spec = specOf(tpl, brief.ratio)
    if (spec.unsupported) {
      brief.ratio = spec.ratio
      this.group.note(tpl.name + ' 还没做 ' + spec.asked + '，这条按 ' + spec.ratio + ' 出。要 ' + spec.asked + ' 得另排一版布局，时间线不用重剪。')
    }
    this.group.emit({ type: 'goal', goal: { platform: brief.platform, ratio: spec.ratio, duration: brief.duration, template: brief.template, stages: ['剪辑', '包装', '质检', '交付'] } })
    this.group.note(`开工。目标 ${brief.platform} · ${spec.ratio} · ${brief.duration}s · ${tpl ? tpl.name : brief.template} · ${brief.hasScript ? '按稿' : '没稿直接口播'}。`)

    await this.dispatch(brief)
    return { phase: this.group.meta.phase, brief }
  }

  /** 派活：不是按固定顺序调三个 handler，是让制片人自己决定派给谁、验收不过再派一次 */
  async dispatch(brief) {
    this.state = {}
    const d = new Director(this.group, { brief, state: this.state })
    this.director = d
    try {
      this.group.setPhase('cutting')
      const r = await d.producerTurn(dispatchTask(brief, this.group))

      // 硬门：模型忘了走完流程，规则把真实情况摆到群里，不许静默收工
      if (!this.state.report) {
        this.group.setPhase('blocked')
        this.group.note('这轮没跑到质检，不算交付。要我按现状硬交，你说一声。')
        return { phase: 'blocked', reason: 'no-qc', said: r.said }
      }
      await this.deliver(this.state)
      return { phase: 'delivered', said: r.said, used: r.used }
    } catch (err) {
      const stuckAt = this.group.meta.phase
      this.group.setPhase('blocked')
      this.group.note('卡在「' + stuckAt + '」：' + err.message + '。我看过再给方案，不用你动手。')
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
    this.group.emit({ type: 'deliver', items, report: report ? { passed: report.passed, checks: report.checks.length } : null })

    // 差额写进系统层：模型说不说是它的事，事实在这里，藏不住
    const brief = this.group.meta.brief || {}
    const target = Number(brief.duration) || 0
    const actual = state.plan ? Number(state.plan.outDuration) : null
    if (target && actual && Math.abs(actual - target) > target * TARGET_TOLERANCE) {
      this.group.note(`目标 ${target}s，成片 ${actual.toFixed(1)}s，差 ${Math.abs(actual - target).toFixed(1)}s。`)
    }
    if (report && !report.passed) {
      this.group.note('质检 ' + report.checks.length + ' 项里有 ' + report.checks.filter(c => !c.ok).length + ' 项没过，逐项在报告里。')
    }
    this.group.setPhase('delivered')
  }

  /**
   * 交付之后说一句改动。
   * 解析「把X改成Y」用规则（稳定、快），改字和重出用管线，说的话由模型说。
   */
  async revise(text) {
    const s = String(text || '').trim()
    const d = new Director(this.group, { brief: this.group.meta.brief || {}, state: this.state })
    this.director = d
    const parsed = parseEdit(s)
    if (!parsed) {
      const pipeNote = '要改哪句这么说：把「划走」改成「溜走」，我改完只重跑那一处。'
      this.group.note(pipeNote)
      return { phase: 'delivered', ask: 'edit' }
    }

    if (parsed.kind === 'rerun') {
      const r = await d.repack('重跑')
      await d.utter('producer', [
        '用户没改字，只让你重跑一版。',
        packLine(r),
        qcLine(r),
        '把结果告诉他：片子换没换、质检几项过。一两个短句。它没出片就说没出片，不许说已经重出。',
      ].join('\n'), { reason: '重跑', packer: r.packer, qc: r.qc, qcOk: r.qcOk, packed: r.packed, qcPassed: r.qcPassed })
      return { phase: this.group.meta.phase, reason: 'rerun', said: r }
    }

    const edited = await d.revise({ from: parsed.from, to: parsed.to, chapter: parsed.chapter || null })
    if (!edited.ok) {
      await d.utter('producer', '用户要改一句，但改不成：' + edited.error + (edited.hint ? '（' + edited.hint + '）' : '') + '。如实告诉他，别自己编原因，也别动时间线。两三句。', { from: parsed.from, to: parsed.to, ok: false })
      return { phase: this.group.meta.phase, error: edited.error }
    }
    this.state = d.state
    const r = await d.repack('改一句')
    await d.utter('producer', [
      '用户这句话你已经改完了：把「' + parsed.from + '」改成「' + parsed.to + '」。',
      '改了 ' + edited.changed + ' 个词，词数 ' + edited.words + ' 没变，每个词的起止时间码一个没动。',
      packLine(r),
      qcLine(r),
      '把结果告诉他：改了哪一处、只重渲了受影响的部分、质检几项过。三五句，不要复述时间码。',
    ].join('\n'), { changed: edited.changed, words: edited.words, chapter: edited.chapter, filmSec: edited.filmSec, qc: r.qc, packer: r.packer, packed: r.packed, qcPassed: r.qcPassed })
    return { phase: this.group.meta.phase, reason: '改一句', edited }
  }

  async busy() {
    this.group.note('在跑，跑完我报。要改的话现在说，我记进这版。')
    return { phase: this.group.meta.phase }
  }
}

/** 包装这一步的事实：它说没说出片不算，成片文件换没换才算 */
function packLine(r) {
  if (r.packed) return '包装这一步的成片文件确实换了（引擎按文件大小和时间核过），' + (r.fallback ? r.fallback + '。' : '') + '只重渲了改动命中的那几帧。'
  return '包装这一步没有出新成片文件（' + (r.fallback || '引擎兜底也没换文件') + '），你要如实说这一版没重出。'
}

/** 质检：pressed 是报告本身，不是 bot 这轮跑没跑通 */
function qcLine(r) {
  if (!r.qcPassed) return '质检报告这一版有不通过项，逐项在报告里，不许说「几项全过」。'
  return '质检报告这一版全部通过。'
}

/** 读到需求之后要它说的话：为什么是这个模板、替用户定了什么、模型读岔了什么 */
function briefTask(brief, meta, spec, tpl) {
  const L = [
    '用户刚给了需求和素材，你已经读完了。现在要在群里跟他说清楚，然后让他点「开始」。',
    '他的原话你自己组织，不要改他的意思。字段：平台 ' + brief.platform + '，时长 ' + brief.duration + 's，画幅 ' + spec.ratio + '（' + spec.width + '×' + spec.height + '），模板 ' + (tpl ? tpl.name : brief.template) + '，' + (brief.hasScript ? '有稿' : '没稿直接口播') + '。',
  ]
  const tl = templateLine(brief)
  if (tl) L.push('模板理由可以提一句：' + tl)
  if (brief.assumed && brief.assumed.length) L.push('你替他定了：' + brief.assumed.join('、') + '——要明说，别当成他说的。')
  if (brief.corrected && brief.corrected.length) L.push('模型读岔了这几处，你按他的原话算：' + brief.corrected.slice(0, 3).join('；') + '——也要明说。')
  if (meta && meta.skipped && meta.skipped !== 'off') L.push('注意：读需求那次模型没接上（' + meta.skipped + '），这些字段是规则填的，必须说清楚，不许装成 AI 读出来的。')
  L.push('三到五句，说完让他确认。字段卡上已经有了，别复述清单。')
  return L.join('\n')
}

/** 开工任务书：目标 + 验收标准 + 你自己的职责边界 */
function dispatchTask(brief, group) {
  const tpl = templateById(brief.template)
  const spec = specOf(tpl, brief.ratio)
  return [
    '用户点了开始，现在按确认卡执行。',
    '目标：' + brief.platform + '，' + brief.duration + 's，' + (tpl ? tpl.name : brief.template) + '（' + spec.ratio + '，' + spec.width + '×' + spec.height + '），' + (brief.hasScript ? '按稿' : '没稿直接口播'),
    '流程是你派活：剪辑先干（转写对齐、错字、气口、字幕），包装再出片，质检最后查。质检没过你要决定返工还是如实交付。',
    '验收标准：成片时长对得上目标（对不上就报差多少、代价是什么）；质检每一项都有证据；错字和低置信词如实报出来。',
    '每一步都要你亲自派，不许跳过质检就交付。干完用 finish_delivery 交付。',
    '同一件事最多派两次。对方明确说「做不到」，就别再派，改成如实报差额和代价——硬凑是错的。',
    '特别记住：剪辑剪完多长，是素材决定的。质检如果说「时长短了」，那不是剪辑没干好，重剪只会更短。这种情况直接如实报差额，或者让用户补素材，不许把剪辑再派一遍。',
  ].join('\n')
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
