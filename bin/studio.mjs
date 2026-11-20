#!/usr/bin/env node
/** dsm studio：群聊编排的 CLI。同一套 group/orchestrator，界面以后接在上面。 */
import { parseArgs } from 'node:util'
import { join, resolve, basename } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { Group } from '../src/core/group.mjs'
import { Orchestrator } from '../src/core/orchestrator.mjs'

const ROOT = process.env.DSM_HOME || resolve(process.cwd(), 'groups')
mkdirSync(ROOT, { recursive: true })

const [cmd, ...rest] = process.argv.slice(2)
const opts = parseOpts(rest)

function parseOpts(argv) {
  const out = { _: [], attach: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--attach') { out.attach.push(argv[++i]); continue }
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; continue }
    out._.push(a)
  }
  return out
}

function openGroup() {
  if (opts.group) return Group.open(ROOT, opts.group)
  const all = Group.list(ROOT)
  if (!all.length) die('还没有群，先 dsm studio new "项目名"')
  return Group.open(ROOT, all[0].id)
}

const t = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

function render(group, { verbose = false } = {}) {
  const lines = []
  lines.push('─'.repeat(64))
  lines.push(`${group.meta.name}  ·  ${group.meta.id}  ·  ${group.meta.phase}`)
  lines.push('─'.repeat(64))
  for (const e of group.events) {
    if (e.type === 'user') {
      lines.push(`\n  你 · ${t(e.ts)}`)
      if (e.assets) lines.push(`  [附件] ${e.assets.join(', ')}`)
      for (const l of String(e.text || '').split('\n')) lines.push('  ' + l)
    } else if (e.type === 'bot') {
      lines.push(`\n${mark(e.bot)} ${e.name} · ${t(e.ts)}`)
      for (const l of String(e.text || '').split('\n')) lines.push('  ' + l)
    } else if (e.type === 'card') {
      lines.push(`\n[卡] ${e.card.title}`)
      for (const f of e.card.fields) lines.push(`    ${f.label.padEnd(4, '　')} ${f.value}`)
      lines.push(`    按钮   ${e.card.actions.join(' / ')}`)
    } else if (e.type === 'job' && verbose) {
      lines.push(`  · ${e.job.bot} ${e.job.title} → ${e.job.status}${e.job.error ? '：' + e.job.error : ''}`)
    } else if (e.type === 'progress' && verbose) {
      lines.push(`  · ${e.text}`)
    } else if (e.type === 'deliver') {
      lines.push(`\n[交付] ${e.items.length} 件`)
      for (const i of e.items) lines.push(`    ${i.label}  ${i.file}`)
    }
  }
  return lines.join('\n')
}

const mark = id => ({ producer: '◆', cutter: '▍', packer: '▤', qc: '◻' }[id] || '·')

function die(msg) { console.error(msg); process.exit(2) }

async function main() {
  if (!cmd || cmd === 'help') {
    console.log(`dsm studio <命令>

  new "<项目名>"          建一个群
  say "<话>" --attach <文件>   在群里说一句（可带素材）
  confirm [--platform 视频号] [--ratio 9:16] [--duration 60] [--template 纯字幕] [--script]
  log [--group id] [--verbose] 打印群聊记录
  list                    列出所有群
  demo --input <视频>     一条龙跑完，打印全过程
`)
    return
  }

  if (cmd === 'new') {
    const name = opts._.join(' ') || '未命名'
    const g = Group.create(ROOT, name)
    console.log(g.meta.id)
    console.log(render(g))
    return
  }

  if (cmd === 'list') {
    for (const m of Group.list(ROOT)) console.log(`${m.id}  ${m.name}  ${m.phase}  ${m.createdAt.slice(0, 16)}`)
    return
  }

  if (cmd === 'log') {
    const g = openGroup()
    console.log(render(g, { verbose: Boolean(opts.verbose) }))
    return
  }

  if (cmd === 'say') {
    const g = openGroup()
    const o = new Orchestrator(g)
    const text = opts._.join(' ')
    const assets = opts.attach.map(a => resolve(a))
    for (const a of assets) if (!existsSync(a)) die('找不到素材: ' + a)
    const r = await o.say(text, { assets })
    if (opts.json) console.log(JSON.stringify(r, null, 2))
    else console.log(render(g, { verbose: Boolean(opts.verbose) }))
    return
  }

  if (cmd === 'confirm') {
    const g = openGroup()
    const o = new Orchestrator(g)
    const t0 = Date.now()
    const values = {
      platform: opts.platform,
      ratio: opts.ratio,
      duration: opts.duration,
      template: opts.template,
      hasScript: opts.script ? true : undefined,
      banned: opts.banned,
    }
    await o.confirm(values)
    console.error(`[用时 ${((Date.now() - t0) / 1000).toFixed(1)}s]`)
    console.log(render(g, { verbose: Boolean(opts.verbose) }))
    return
  }

  if (cmd === 'demo') {
    const input = resolve(opts.input || '.test/talk.mp4')
    if (!existsSync(input)) die('找不到素材: ' + input)
    const g = Group.create(ROOT, basename(input).replace(/\.\w+$/, ''))
    const o = new Orchestrator(g)
    const req = opts._.join(' ') || ('按折光做个 ' + (opts.duration || 60) + ' 秒的，发' + (opts.platform || '视频号'))
    await o.say(req, { assets: [input] })
    await o.confirm({ template: opts.template || 'subtitle-only', duration: opts.duration, platform: opts.platform, ratio: opts.ratio })
    console.log(render(g, { verbose: true }))
    return
  }

  die('未知命令: ' + cmd)
}

await main()
