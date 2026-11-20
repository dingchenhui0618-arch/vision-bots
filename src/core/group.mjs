/**
 * 群 = 一个项目现场：独立记忆、独立工作文件夹、独立事件流。
 * 事件流是真相：界面、CLI、导出都从 events.jsonl 重建。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync, copyFileSync, readdirSync } from 'node:fs'
import { basename, join, dirname } from 'node:path'
import { byId } from '../bots/roster.mjs'

let counter = 0
const rid = (p = '') => p + (counter++).toString(36) + Math.random().toString(36).slice(2, 6)

const slugify = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'group'

export class Group {
  constructor(dir, meta) {
    this.dir = dir
    this.meta = meta
    this.events = []
    this.listeners = new Set()
    for (const sub of ['assets', 'work', 'out']) mkdirSync(join(dir, sub), { recursive: true })
    if (existsSync(this.logPath)) {
      this.events = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean).map(l => {
        try { return JSON.parse(l) } catch { return null }
      }).filter(Boolean)
    }
  }

  static create(root, name) {
    const id = slugify(name) + '-' + rid()
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    const meta = {
      id, name, dir,
      createdAt: new Date().toISOString(),
      phase: 'intake',
      brief: null,
      template: null,
      assets: [],
      artifacts: {},
    }
    const g = new Group(dir, meta)
    g.save()
    return g
  }

  static open(root, id) {
    const dir = join(root, id)
    if (!existsSync(join(dir, 'group.json'))) throw new Error('找不到群: ' + id)
    return new Group(dir, JSON.parse(readFileSync(join(dir, 'group.json'), 'utf8')))
  }

  static list(root) {
    if (!existsSync(root)) return []
    return readdirSafe(root)
      .map(d => join(root, d, 'group.json'))
      .filter(p => existsSync(p))
      .map(p => JSON.parse(readFileSync(p, 'utf8')))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  get logPath() { return join(this.dir, 'events.jsonl') }
  get path() { return this.dir }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  emit(ev) {
    const e = { seq: this.events.length + 1, id: rid('e'), ts: new Date().toISOString(), ...ev }
    this.events.push(e)
    appendFileSync(this.logPath, JSON.stringify(e) + '\n', 'utf8')
    for (const fn of this.listeners) { try { fn(e) } catch { /* 监听器坏了不影响主流程 */ } }
    return e
  }

  say(botId, text, extra = {}) {
    const bot = byId(botId)
    return this.emit({ type: 'bot', bot: botId, name: bot ? bot.name : botId, text, ...extra })
  }

  user(text, extra = {}) { return this.emit({ type: 'user', text, ...extra }) }

  addAssets(paths) {
    const added = []
    for (const src of paths) {
      const dest = join(this.dir, 'assets', basename(src))
      if (src !== dest) copyFileSync(src, dest)
      added.push(dest)
    }
    this.meta.assets = [...new Set([...(this.meta.assets || []), ...added])]
    this.save()
    return added
  }

  setPhase(phase) {
    this.meta.phase = phase
    this.save()
    this.emit({ type: 'phase', phase })
  }

  artifact(kind, file, meta = {}) {
    this.meta.artifacts = { ...(this.meta.artifacts || {}), [kind]: file }
    this.save()
    return this.emit({ type: 'artifact', kind, file, name: basename(file), ...meta })
  }

  save() {
    writeFileSync(join(this.dir, 'group.json'), JSON.stringify(this.meta, null, 2), 'utf8')
  }
}

function readdirSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}