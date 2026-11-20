/** 本地服务：同一套 group/orchestrator，界面和 CLI 共用。 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, resolve, relative, isAbsolute } from 'node:path'
import { Group } from './core/group.mjs'
import { Orchestrator } from './core/orchestrator.mjs'
import { BOTS } from './bots/roster.mjs'
import { botRoster, templateLibrary, readTerms, validateTerms, auditTerms, writeTerms, trial } from './assets.mjs'

const ROOT = process.env.DSM_HOME || resolve(process.cwd(), 'groups')
const WEB = resolve(process.cwd(), 'web')
const PORT = Number(process.env.PORT || 4188)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.srt': 'text/plain; charset=utf-8',
}

const cache = new Map()
const clients = new Map()

function getGroup(id) {
  if (!cache.has(id)) {
    const g = Group.open(ROOT, id)
    g.on(ev => {
      const set = clients.get(id)
      if (!set) return
      const payload = 'data: ' + JSON.stringify(ev) + '\n\n'
      for (const res of set) { try { res.write(payload) } catch { } }
    })
    cache.set(id, g)
  }
  return cache.get(id)
}

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

async function body(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

const rel = (g, file) => (file ? relative(g.dir, file).split('\\').join('/') : null)
const url = (g, file) => (file ? '/file?g=' + encodeURIComponent(g.meta.id) + '&p=' + encodeURIComponent(rel(g, file)) : null)

function panel(g) {
  const a = g.meta.artifacts || {}
  const out = { video: url(g, a.video), preview: url(g, a.preview), subs: [], report: null, timeline: null }
  if (a.subs && existsSync(a.subs)) {
    out.subs = readFileSync(a.subs, 'utf8').split('\n\n').filter(Boolean).map(block => {
      const rows = block.trim().split('\n')
      const [start, end] = (rows[1] || '').split(' --> ').map(parseTime)
      return { start, end, text: rows.slice(2).join(' ') }
    })
  }
  if (a.report && existsSync(a.report)) {
    const r = JSON.parse(readFileSync(a.report, 'utf8'))
    out.report = { passed: r.passed, checks: r.checks.map(c => ({ id: c.id, ok: c.ok, detail: c.detail })), frames: r.frames || [] }
  }
  if (a.timeline && existsSync(a.timeline)) {
    const p = JSON.parse(readFileSync(a.timeline, 'utf8'))
    out.timeline = { keep: p.keep, outDuration: p.outDuration, cutSeconds: p.cutSeconds, removedPauses: p.removedPauses, segments: p.keep ? p.keep.length : 0 }
  }
  return out
}

function parseTime(s) {
  const m = String(s || '').replace(',', '.').split(':').map(Number)
  return m.length === 3 ? m[0] * 3600 + m[1] * 60 + m[2] : 0
}

const routes = [
  ['GET', /^\/api\/groups$/, (req, res) => {
    send(res, 200, Group.list(ROOT).map(m => ({ id: m.id, name: m.name, phase: m.phase, createdAt: m.createdAt, assets: (m.assets || []).length })))
  }],
  ['POST', /^\/api\/groups$/, async (req, res) => {
    const b = await body(req)
    const g = Group.create(ROOT, b.name || '未命名项目')
    send(res, 200, { id: g.meta.id })
  }],
  ['GET', /^\/api\/groups\/([^/]+)$/, (req, res, m) => {
    const g = getGroup(m[1])
    send(res, 200, { meta: g.meta, events: g.events, bots: BOTS })
  }],
  ['GET', /^\/api\/groups\/([^/]+)\/panel$/, (req, res, m) => send(res, 200, panel(getGroup(m[1])))],
  ['POST', /^\/api\/groups\/([^/]+)\/assets$/, async (req, res, m) => {
    const g = getGroup(m[1])
    const q = new URL('http://x' + req.url).searchParams
    const raw = q.get('name') || 'asset.bin'
    const name = raw.replace(/[\\/:*?"<>|]/g, '_').slice(-80)
    const chunks = []
    for await (const c of req) chunks.push(c)
    const buf = Buffer.concat(chunks)
    if (!buf.length) return send(res, 400, { ok: false, error: '空文件' })
    mkdirSync(join(g.dir, 'assets'), { recursive: true })
    const dest = join(g.dir, 'assets', name)
    writeFileSync(dest, buf)
    g.meta.assets = [...new Set([...(g.meta.assets || []), dest])]
    g.save()
    g.emit({ type: 'assets', files: [dest], name: name, size: buf.length })
    send(res, 200, { ok: true, path: dest, name: name, size: buf.length })
  }],
  ['GET', /^\/api\/groups\/([^/]+)\/stream$/, (req, res, m) => {
    const id = m[1]
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': ok\n\n')
    if (!clients.has(id)) clients.set(id, new Set())
    clients.get(id).add(res)
    req.on('close', () => clients.get(id).delete(res))
  }],
  ['POST', /^\/api\/groups\/([^/]+)\/say$/, async (req, res, m) => {
    const g = getGroup(m[1])
    const b = await body(req)
    const o = new Orchestrator(g)
    try {
      const r = await o.say(b.text || '', { assets: b.assets || [] })
      send(res, 200, { ok: true, result: r })
    } catch (e) { send(res, 500, { ok: false, error: e.message }) }
  }],
  ['POST', /^\/api\/groups\/([^/]+)\/confirm$/, async (req, res, m) => {
    const g = getGroup(m[1])
    const b = await body(req)
    const o = new Orchestrator(g)
    try {
      await o.confirm(b)
      send(res, 200, { ok: true })
    } catch (e) { send(res, 500, { ok: false, error: e.message }) }
  }],
  // ── 资产层：机器级的资产，不属于某个项目 ──
  ['GET', /^\/api\/assets$/, (req, res) => {
    const terms = readTerms()
    send(res, 200, { bots: botRoster(), templates: templateLibrary(), terms: { ...terms, warnings: validateTerms(terms).warnings } })
  }],

  // 存术语表：先形状校验，再同音门。两道门都过才落盘，落盘走临时文件 + rename。
  ['POST', /^\/api\/assets\/terms$/, async (req, res) => {
    const b = await body(req)
    const cur = readTerms()
    if (b.rev && b.rev !== cur.rev) {
      return send(res, 409, { ok: false, error: '术语表在别处被改过（你手里这版是旧的），刷新再存', rev: cur.rev })
    }
    const draft = { version: cur.version, note: cur.note, hotwords: b.hotwords || [], terms: b.terms || [] }
    const v = validateTerms(draft)
    if (!v.ok) return send(res, 400, { ok: false, stage: 'shape', errors: v.errors, warnings: v.warnings })
    const a = await auditTerms(draft)
    if (a.errors.length) {
      return send(res, 400, { ok: false, stage: 'homophone', errors: a.errors, warnings: [...v.warnings, ...a.warnings], pinyinMode: a.pinyinMode })
    }
    const saved = writeTerms(draft)
    send(res, 200, { ok: true, terms: saved, warnings: [...v.warnings, ...a.warnings], pinyinMode: a.pinyinMode, checked: a.checked })
  }],

  // 试验台：拿草稿（不用先存）在真 applyTerms 上跑一遍，验的是「会不会命中」，不是转写本身。
  ['POST', /^\/api\/assets\/terms\/trial$/, async (req, res) => {
    const b = await body(req)
    const terms = Array.isArray(b.terms) ? b.terms.filter(t => t && typeof t === 'object') : readTerms().terms
    send(res, 200, { ok: true, ...trial(String(b.text || ''), terms) })
  }],

  ['GET', /^\/file$/, (req, res, m) => {
    const q = new URL('http://x' + req.url).searchParams
    const g = getGroup(q.get('g'))
    const target = resolve(g.dir, q.get('p') || '')
    if (!target.startsWith(g.dir)) return send(res, 403, { error: 'forbidden' })
    if (!existsSync(target)) return send(res, 404, { error: 'not found' })
    send(res, 200, readFileSync(target), MIME[extname(target)] || 'application/octet-stream')
  }],
]

const server = createServer(async (req, res) => {
  const path = new URL('http://x' + req.url).pathname
  try {
    for (const [method, re, fn] of routes) {
      if (req.method !== method) continue
      const m = path.match(re)
      if (m) {
        m[1] = m[1] ? decodeURIComponent(m[1]) : m[1]
        return await fn(req, res, m)
      }
    }
  } catch (err) {
    console.error(err)
    return send(res, 500, { ok: false, error: err.message })
  }
  // 静态资源
  const file = resolve(WEB, '.' + (path === '/' ? '/index.html' : path))
  if (file.startsWith(WEB) && existsSync(file)) return send(res, 200, readFileSync(file), MIME[extname(file)] || 'text/plain')
  send(res, 404, 'not found', 'text/plain')
})

server.listen(PORT, '127.0.0.1', () => console.log('studio http://127.0.0.1:' + PORT))
