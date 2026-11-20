/** 一次干活的执行单元：带状态、进度、产物和失败原因。 */

let n = 0
const jid = () => 'j' + (n++).toString(36) + Date.now().toString(36).slice(-3)

export class Runner {
  constructor(group) {
    this.group = group
  }

  /**
   * spec: { bot, title, run(ctx) }
   * run 拿到 { group, job, log, artifact, done }，返回值写进 job.result。
   */
  async run(spec) {
    const job = {
      id: jid(),
      bot: spec.bot,
      title: spec.title,
      status: 'running',
      startedAt: new Date().toISOString(),
      result: null,
      error: null,
    }
    this.group.emit({ type: 'job', job: { ...job } })

    const log = (text, meta = {}) =>
      this.group.emit({ type: 'progress', bot: spec.bot, job: job.id, text, ...meta })

    const artifact = (kind, file, meta = {}) => {
      job.result = { ...(job.result || {}), [kind]: file }
      return this.group.artifact(kind, file, { bot: spec.bot, job: job.id, ...meta })
    }

    try {
      job.result = await spec.run({ group: this.group, job, log, artifact })
      job.status = 'done'
      job.endedAt = new Date().toISOString()
      this.group.emit({ type: 'job', job: { ...job } })
      return job
    } catch (err) {
      job.status = 'failed'
      job.error = err && err.message ? err.message : String(err)
      job.endedAt = new Date().toISOString()
      this.group.emit({ type: 'job', job: { ...job } })
      throw err
    }
  }
}
