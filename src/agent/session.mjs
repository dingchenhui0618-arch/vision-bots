/**
 * 一个 bot 一个会话。会话是长驻的：这个项目里它听过的话、做过的决定、记住的结论都在这里，
 * 下一轮接着用。不复用 Orchestrator 的内存状态，CLI 重开也能从盘上重建。
 *
 * 存两样东西：
 *   history.jsonl —— 说过的话和调过的工具，一行一条，append 写
 *   notes.json    —— 它自己决定要记住的事（上限 24 条，模型只能追加和覆盖同一 key）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

const NOTES_MAX = 24
const TAIL_DEFAULT = 24

export class BotSession {
  constructor(group, botId) {
    this.group = group
    this.botId = botId
    this.dir = join(group.dir, 'bots', botId)
    mkdirSync(this.dir, { recursive: true })
    this._history = null
    this._notes = null
  }

  get historyPath() { return join(this.dir, 'history.jsonl') }
  get notesPath() { return join(this.dir, 'notes.json') }

  /** 全量历史（第一次读盘，之后走内存） */
  get all() {
    if (this._history) return this._history
    if (!existsSync(this.historyPath)) { this._history = []; return this._history }
    this._history = readFileSync(this.historyPath, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
    return this._history
  }

  /** 最近 n 条（喂给模型的上下文，不是全量——上下文要钱也要命） */
  tail(n = TAIL_DEFAULT) {
    const h = this.all
    return h.slice(Math.max(0, h.length - n))
  }

  push(msg) {
    const e = { ts: new Date().toISOString(), ...msg }
    this.all.push(e)
    appendFileSync(this.historyPath, JSON.stringify(e) + '\n', 'utf8')
    return e
  }

  /** 清楚地说出了一句话（utterance 才是界面上的聊天，tool 只是它干了什么） */
  said(text, meta = {}) {
    return this.push({ role: 'assistant', content: String(text), kind: 'say', ...meta })
  }

  /**
   * 记住一条结论。key 相同就覆盖（同一个决定不该留两份），否则追加；超上限丢最老的。
   * 这不是长期记忆库，是这个项目里的工作备忘。
   */
  remember(key, text) {
    const list = this.notes
    const k = String(key || '').slice(0, 40) || 'note'
    const i = list.findIndex(x => x.key === k)
    const item = { key: k, text: String(text).slice(0, 400), ts: new Date().toISOString() }
    if (i >= 0) list[i] = item
    else list.push(item)
    while (list.length > NOTES_MAX) list.shift()
    this._notes = list
    writeFileSync(this.notesPath, JSON.stringify(list, null, 2), 'utf8')
    return item
  }

  get notes() {
    if (this._notes) return this._notes
    if (!existsSync(this.notesPath)) { this._notes = []; return this._notes }
    try { this._notes = JSON.parse(readFileSync(this.notesPath, 'utf8')) || [] } catch { this._notes = [] }
    return this._notes
  }

  /** 这个 bot 现在手上有哪些结论（给别的 bot 或界面看） */
  get state() {
    return { botId: this.botId, dir: this.dir, turns: this.all.filter(e => e.kind === 'turn').length, notes: this.notes }
  }
}

export const sessionsOf = group => {
  const cache = new Map()
  return botId => {
    if (!cache.has(botId)) cache.set(botId, new BotSession(group, botId))
    return cache.get(botId)
  }
}
