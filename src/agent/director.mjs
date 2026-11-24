/**
 * 导演层：它不管具体怎么剪怎么渲，只管「谁在什么时候说给谁听」。
 *
 * 一个团队就一套事件流、一套 state、一套时间线。每个 bot 有自己的会话（说过的话、
 * 记得的事），但它调的每个工具都是同一份确定性代码——所以四个 bot 是同一个 AI 的四个
 * 会话，不是四套能力。
 *
 * 主 bot 派活走 dispatch_to：小 bot 自己跑一轮 → 它说的话回流给主 bot 当结论。
 * 主 bot 判断能不能验收，不能就再派一次。这就是「协调分配」。
 */
import { byId } from '../bots/roster.mjs'
import { Runner } from '../core/runner.mjs'
import { runCut } from '../handlers/cut.mjs'
import { runPack } from '../handlers/pack.mjs'
import { runQc } from '../handlers/qc.mjs'
import { BotSession } from './session.mjs'
import { FactBook } from './facts.mjs'
import { runAgent } from './loop.mjs'
import { callProfile } from '../llm.mjs'
import { paramsOf } from '../bots/config.mjs'
import { toolsFor, inspectProject } from './tools.mjs'
import { parseEdit, locate, applyEdit, assertUntouched, loadPipeline, loadScene, savePipeline } from '../revise.mjs'
import { buildCaptions } from '../captions.mjs'
import { specOf, templateById } from '../bots/roster.mjs'

export class Director {
  constructor(group, { chatFn = undefined, brief = null, state = null } = {}) {
    this.group = group
    this.chatFn = chatFn
    this.brief = brief || group.meta.brief || {}
    this.state = state || {}
    this.runner = new Runner(group)
    this.handlers = { cut: runCut, pack: runPack, qc: runQc }
    this._sessions = new Map()
    this._jobCtx = new Map()
    this._dispatched = new Map()
    this.depth = 0
  }

  session(botId) {
    if (!this._sessions.has(botId)) this._sessions.set(botId, new BotSession(this.group, botId))
    return this._sessions.get(botId)
  }

  currentJob(botId) { return this._jobCtx.get(botId) || null }

  /** 项目现状：给所有 bot 的上下文，也是事实表的底数（模板、画幅、素材都算有出处） */
  async contextFacts() {
    const info = await inspectProject({ group: this.group, brief: this.brief, state: this.state })
    const tpl = templateById(this.group.meta.template || this.brief.template)
    const spec = tpl ? specOf(tpl, this.brief.ratio) : null
    const facts = new FactBook('project').addAll(info, 'inspect')
    if (spec) facts.addAll({ width: spec.width, height: spec.height, fps: spec.fps, ratio: spec.ratio }, 'template')
    facts.addAll({ duration: this.brief.duration, assets: info.assets }, 'brief')
    if (this.state.plan) facts.addAll({ outDuration: this.state.plan.outDuration, cutSeconds: this.state.plan.cutSeconds, kept: this.state.plan.keptSeconds, segments: this.state.plan.keep.length }, 'plan')
    if (this.state.scene) facts.addAll({ frames: this.state.scene.frames, sections: (this.state.scene.sections || []).length, bigs: (this.state.scene.bigs || []).length }, 'scene')
    return { info, facts }
  }

  contextText(info) {
    const bits = []
    if (info.sourceSec) bits.push('素材 ' + info.sourceSec + 's（' + (info.sourceSize || '') + '）')
    if (info.targetSec) bits.push('要做 ' + info.targetSec + 's')
    if (info.template) bits.push('模板 ' + info.template + ' · ' + info.ratio + ' · ' + info.size)
    bits.push('阶段 ' + this.group.meta.phase)
    return bits.join('，')
  }

  /** 跑一个 handler，套在 job 里（界面能看见谁在干活）。工具内部复用外层 job，不重复开。 */
  async runHandler(botId, title, _jobFn, fn) {
    const existing = this.currentJob(botId)
    if (existing) return fn(existing)
    return this.runner.run({ bot: botId, title, run: async ctx => {
      this._jobCtx.set(botId, ctx)
      try { return await fn(ctx) } finally { this._jobCtx.delete(botId) }
    } })
  }

  /**
   * 一个 bot 的一轮。它自己决定调哪个工具、自己说话；它说的话回流给派活的人。
   * 小 bot 没有 dispatch_to，所以不可能自己再往下派——层级是代码定的，不是提示词。
   */
  async runBot(botId, task) {
    const bot = byId(botId)
    if (!bot) return { ok: false, error: '没有这个 bot：' + botId }
    if (this.depth > 2) return { ok: false, error: '派活层数太深（' + this.depth + '），停。' }
    const session = this.session(botId)
    const { info, facts } = await this.contextFacts()
    const tools = toolsFor(botId, { group: this.group, brief: this.brief, state: this.state, runner: this.runner, director: this })

    this.depth++
    let out
    try {
      out = await this.runner.run({
        bot: botId,
        title: String(task || '').slice(0, 24) || '干活',
        run: async ctx => {
          this._jobCtx.set(botId, ctx)
          try {
            return await runAgent({
              session, bot, task, tools, facts,
              // 这个 bot 自己的模型、温度、步数预算（config/bots/<id>.json）
              profile: callProfile(botId),
              context: this.contextText(info),
              log: (t, m) => ctx.log(t, m),
              ...(this.chatFn ? { chatFn: this.chatFn } : {}),
            })
          } finally { this._jobCtx.delete(botId) }
        },
      })
    } finally { this.depth-- }

    const r = out.result || {}
    if (r.text) this.group.say(botId, r.text, { job: out.id, tools: (r.used || []).map(u => u.name) })
    if (!r.ok) {
      this.group.emit({
        type: 'progress', bot: botId, job: out.id, transient: true,
        text: bot.name + '这轮没跑出结论：' + (r.skipped || 'unknown'),
      })
    }
    const times = (this._dispatched.get(botId) || 0) + 1
    this._dispatched.set(botId, times)
    // 第几次派活就该提醒「这是第几次」，是制片人自己的配置，不是写死的 2
    const warnAt = Number(paramsOf('producer').warnAfterDispatch) || 2
    return {
      bot: botId, name: bot.name, ok: Boolean(r.ok),
      said: r.text || null,
      skipped: r.skipped || null,
      tools: (r.used || []).map(u => u.name),
      numbers: (r.facts ? r.facts.size() : 0),
      ms: r.ms || null,
      // 同一个问题派第二遍还派回来，多半不是它不干活，是素材或规格的物理限制
      times,
      ...(times >= warnAt ? { warn: '这是第 ' + times + ' 次派给它。如果问题还是同一个，那是素材或规格的限制，不是它没干。别拿同一个要求再派第三遍。' } : {}),
    }
  }

  /** 主 bot 的一轮：从这句话开始，它自己决定看什么、派给谁、什么时候交付 */
  async producerTurn(task) {
    const bot = byId('producer')
    const session = this.session('producer')
    const { info, facts } = await this.contextFacts()
    const tools = toolsFor('producer', { group: this.group, brief: this.brief, state: this.state, runner: this.runner, director: this })
    const out = await this.runner.run({
      bot: 'producer',
      title: '接需求 · 派活',
      run: async ctx => {
        this._jobCtx.set('producer', ctx)
        try {
          return await runAgent({
            session, bot, task, tools, facts,
            profile: callProfile('producer'),
            context: this.contextText(info),
            log: (t, m) => ctx.log(t, m),
            ...(this.chatFn ? { chatFn: this.chatFn } : {}),
          })
        } finally { this._jobCtx.delete('producer') }
      },
    })
    const r = out.result || {}
    if (r.text) this.group.say('producer', r.text, { job: out.id, tools: (r.used || []).map(u => u.name) })

    // 硬门：主 bot 忘了验收就想收工，规则补一句，不静默
    if (!this.state.report) {
      this.group.say('producer', '这一版没跑质检，按未验收交付，别当成能直接发。')
      this.state.unverified = true
    }
    return { ok: Boolean(r.ok), said: r.text || null, skipped: r.skipped || null, delivered: Boolean(this.state.delivered), used: (r.used || []).map(u => u.name) }
  }

  /** 让它说一句话（不调工具）。用于「我把需求读成这样」这类必须由它自己说、又不该派活的时候。 */
  async utter(botId, task, factValues = null) {
    const bot = byId(botId)
    const session = this.session(botId)
    const { info, facts } = await this.contextFacts()
    if (factValues) facts.addAll(factValues, 'context')
    const r = await runAgent({
      session, bot, task, tools: [], facts,
      profile: callProfile(botId),
      context: this.contextText(info),
      // 只让它说一句话：步数和预算是这一次的临时覆盖，压过配置里的值
      maxSteps: 2, maxTokens: 500,
      ...(this.chatFn ? { chatFn: this.chatFn } : {}),
    })
    if (r.text) this.group.say(botId, r.text)
    return r
  }

  /** 改一句：只动字，词数和时间码由 revise.mjs 断言 */
  async revise({ from, to, chapter = null } = {}) {
    const pipe = loadPipeline(this.group)
    if (!pipe) return { ok: false, error: '这条没有可改的时间线（剪辑那步没留状态），得整条重走。' }
    const scene = loadScene(this.group)
    const located = locate(pipe.transcript.words, from, { plan: pipe.plan, scene, chapter })
    if (!located.ok) return { ok: false, error: located.reason, hint: located.hint || null }
    let edit
    try {
      edit = applyEdit({ words: pipe.transcript.words, segments: pipe.transcript.segments, match: located.match, to })
      assertUntouched(pipe.transcript.words, edit.words, { changed: edit.changed })
    } catch (err) {
      return { ok: false, error: '这句不敢改：' + err.message }
    }
    const brief = pipe.brief || this.brief
    const next = {
      ...pipe,
      transcript: { ...pipe.transcript, words: edit.words, segments: edit.segments },
      captions: buildCaptions(edit.words, pipe.plan, { maxChars: brief.maxChars || 14 }),
    }
    savePipeline(this.group, next)
    this._pipe = next
    return {
      ok: true,
      changed: edit.changed.length,
      pairs: edit.changed.map(c => ({ from: c.from, to: c.to })),
      chapter: located.match.chapter || null,
      filmSec: located.match.film,
      words: edit.words.length,
      unchanged: true,
    }
  }

  /** 用同一份时间线重出 */
  async repack(reason = '重跑') {
    const pipe = this._pipe || loadPipeline(this.group)
    if (!pipe) return { ok: false, error: '没有时间线可复用，得先剪辑。' }
    const brief = pipe.brief || this.brief
    const captions = buildCaptions(pipe.transcript.words, pipe.plan, { maxChars: brief.maxChars || 14 })
    const state = this.state
    state.transcript = pipe.transcript
    state.plan = pipe.plan
    state.captions = captions
    state.fixReport = pipe.fixReport || null
    state.source = pipe.source || null
    this.state = state
    const rank = await this.runBot('packer', '按现有时间线' + reason + '，别动时间线')
    const q = await this.runBot('qc', '重出后复查成片')
    return { ok: Boolean(rank.ok), reason, packer: rank.said, qc: q.said, qcOk: q.ok }
  }

  /** 交付前的硬门：质检没跑过不许交，交过了不许重复交 */
  async deliver(note) {
    if (!this.state.report) return { ok: false, error: '质检还没跑，不许交付。先 dispatch_to qc。' }
    if (this.state.delivered) return { ok: false, error: '已经交付过了。要改就说改哪句。' }
    this.state.delivered = true
    this.state.deliverNote = String(note || '')
    const failed = this.state.report.checks.filter(c => !c.ok).map(c => c.id)
    return { ok: true, passed: Boolean(this.state.report.passed), failed, checks: this.state.report.checks.length, note: this.state.deliverNote }
  }
}
