/**
 * 编排：制片人只听用户，派活给谁由阶段决定；每个 bot 干完在自己的群里说话。
 * 模型只做判断和措辞，不碰时间码——所有数字来自管线。
 */
import { Runner } from './runner.mjs'
import { runCut } from '../handlers/cut.mjs'
import { runPack } from '../handlers/pack.mjs'
import { runQc } from '../handlers/qc.mjs'
import { TEMPLATES, templateById, specOf, ratiosOf } from '../bots/roster.mjs'
import { parseEdit, locate, applyEdit, assertUntouched, loadPipeline, loadScene, savePipeline } from '../revise.mjs'
import { buildCaptions } from '../captions.mjs'
import { TARGET_TOLERANCE } from '../qa.mjs'
import { understand, whyText, templateLine, PLATFORMS } from '../brief.mjs'

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
        why: whyText(brief),
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
    this.group.say('producer', this.briefSpeech(brief, u.meta, spec, tpl))
    return { phase: 'confirm', brief }
  }

  /**
   * 把「我怎么读的、哪个模板为什么、哪些是我替他定的」说清楚。
   * 模型没接上要直说——不能拿规则填的卡冒充听懂了。
   */
  briefSpeech(brief, meta, spec, tpl) {
    const lines = [`我按你说的填好了：${brief.platform} · ${spec.ratio} · ${brief.duration}s · ${tpl ? tpl.name : brief.template}。`]
    if (spec.unsupported) lines.push(`你问 ${spec.asked}，${tpl.name} 没做这个画幅，这条按 ${spec.ratio} 出；要 ${spec.asked} 我另排一版布局，时间线不用重剪。`)
    lines.push(templateLine(brief))
    if (brief.assumed && brief.assumed.length) lines.push('我替你定的：' + brief.assumed.join('、') + '。')
    if (brief.corrected && brief.corrected.length) {
      const show = brief.corrected.slice(0, 2).join('；')
      lines.push('模型读岔了，我按你的原话算：' + show + (brief.corrected.length > 2 ? ` 等 ${brief.corrected.length} 处` : '') + '。')
    }
    if (meta && meta.skipped && meta.skipped !== 'off') lines.push(`（模型没接上：${meta.skipped}，这版是规则填的）`)
    lines.push('看一眼，没问题就点开始。')
    return lines.join('\n')
  }

  async awaitConfirm(text) {
    if (/^开始|确认|开工|go/i.test(String(text || '').trim())) return this.confirm({})
    this.group.say('producer', '卡在上面，改哪个字段直接说，或者说「开始」。')
    return { phase: 'confirm' }
  }

  /** 确认卡落地 → 定 Goal → 派活。 */
  async confirm(values = {}) {
    const brief = { ...(this.group.meta.brief || {}), ...cleanValues(values) }
    if (!brief.template) brief.template = 'subtitle-only'
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
      if (target && Math.abs(actual - target) > target * TARGET_TOLERANCE) {
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
      `\n要改哪句直接说「把『划走』改成『溜走』」，我改完只重跑那一处。` +
      (fix && fix.stats && fix.stats.changed ? `字幕里的错字改了 ${fix.stats.changed} 处，清单在错字清单里。` : '') +
      (fix && fix.pending.length ? `还有 ${fix.pending.length} 个词我没把握，没动它，也在清单里——发布前扫一眼那几个字。` : '') +
      (report && report.passed ? '质检全过。' : report ? `质检有 ${report.failed.length} 项没过，看报告。` : ''))
    this.group.setPhase('delivered')
  }

  /**
   * 交付之后说一句改动：变成 scene 的改动，只重渲那一处。
   * 只改字的文本，词数和时间码由 revise.mjs 内部断言；渲染走模板的分段缓存。
   */
  async revise(text) {
    const s = String(text || '').trim()
    const pipe = loadPipeline(this.group)
    if (!pipe) {
      this.group.say('producer', '这条没有可改的时间线（剪辑那一步没留下状态）。\n素材再拖进来，我整条重走一遍。')
      return { phase: this.group.meta.phase, error: 'no-pipeline' }
    }
    const parsed = parseEdit(s)
    if (!parsed) {
      const scene = loadScene(this.group) || { bigs: [] }
      const list = (scene.bigs || []).map(b => '· 第 ' + b.index + ' 章（' + b.f0 + '–' + b.f1 + 's）：' + b.text).join('\n')
      this.group.say('producer', '改哪句？照这个样子说，我改完只重跑那一处：\n把「划走」改成「溜走」' + (list ? '\n\n现在是这 ' + scene.bigs.length + ' 章：\n' + list : ''))
      return { phase: 'delivered', ask: 'edit' }
    }
    if (parsed.kind === 'rerun') {
      this.group.say('producer', '重跑。没改字的话画面一帧都不会变，直接复用母版。')
      return this.repack(pipe, '重跑')
    }

    const scene = loadScene(this.group)
    const located = locate(pipe.transcript.words, parsed.from, { plan: pipe.plan, scene, chapter: parsed.chapter })
    if (!located.ok) {
      this.group.say('producer', located.reason + '。' + (located.hint ? '\n' + located.hint : '') + '\n时间线一个字没动。')
      return { phase: 'delivered', error: 'not-found' }
    }

    let edit
    try {
      edit = applyEdit({ words: pipe.transcript.words, segments: pipe.transcript.segments, match: located.match, to: parsed.to })
      assertUntouched(pipe.transcript.words, edit.words, { changed: edit.changed })
    } catch (err) {
      this.group.say('producer', '这句我不敢改：' + err.message + '\n时间码是剪辑定的，不会为了改字动它。')
      return { phase: 'delivered', error: 'unsafe-edit' }
    }

    const brief = pipe.brief || {}
    const next = {
      ...pipe,
      transcript: { ...pipe.transcript, words: edit.words, segments: edit.segments },
      captions: buildCaptions(edit.words, pipe.plan, { maxChars: brief.maxChars || 14 }),
    }
    savePipeline(this.group, next)

    const m = located.match
    const show = t => String(t).replace(/[，。！？、；：,.!?;:…—~·\s]+$/u, '')
    const where = (m.chapter ? '第 ' + m.chapter + ' 章' : '') + (m.film !== null ? '（' + m.film + 's）' : '')
    this.group.say('producer',
      where + '那句：' + edit.changed.map(c => '「' + show(c.from) + '」→「' + show(c.to) + '」').join('、') +
      '。\n只动了 ' + edit.changed.length + ' 个词，词数和每个词的起止时间码都没动——时间线是剪辑定的，那句话改不了它。\n包装按改动重出，只重渲这一处。')

    return this.repack(next, '改一句')
  }

  /** 用同一份时间线重出：画面没变就复用母版，变了就只重渲变化的那一段。 */
  async repack(pipe, reason) {
    const brief = pipe.brief || {}
    // 字幕从词表重算：断句/断行规则改过之后，旧卡片就是错的（stale 的派生物不能当源头）
    const captions = buildCaptions(pipe.transcript.words, pipe.plan, { maxChars: brief.maxChars || 14 })
    const state = {
      transcript: pipe.transcript,
      plan: pipe.plan,
      captions,
      fixReport: pipe.fixReport || null,
      source: pipe.source || null,
    }
    try {
      this.group.setPhase('packing')
      await this.runner.run({ bot: 'packer', title: reason + ' · 重出', run: ctx => runPack({ ...ctx, brief, state }) })
      this.group.setPhase('qc')
      await this.runner.run({ bot: 'qc', title: reason + ' · 重检', run: ctx => runQc({ ...ctx, brief: qcBrief(brief, pipe.plan), state }) })
      await this.deliver(state)
      return { phase: 'delivered', reason, decision: state.decision || null }
    } catch (err) {
      this.group.setPhase('blocked')
      this.group.say('producer', '重出卡住了：' + err.message + '\n我看过再给你方案，不用你动手。')
      throw err
    }
  }

  async busy() {
    this.group.say('producer', '在跑，跑完我报。\n要改的话现在说，我记进这版。')
    return { phase: this.group.meta.phase }
  }
}

/**
 * 目标时长没达到时，质检不拿那个达不到的数字当标准（拍板过程在 dispatch 里写明）。
 * 这里按当前时间线重算一遍，不读存下来的 met——重出之后那字段可能是旧的。
 */
function qcBrief(brief = {}, plan = null) {
  const target = Number(brief.duration) || 0
  const actual = plan ? Number(plan.outDuration) : null
  const ok = !target || !actual ? true : Math.abs(actual - target) <= target * TARGET_TOLERANCE
  return { ...brief, duration: ok ? target : 0 }
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
