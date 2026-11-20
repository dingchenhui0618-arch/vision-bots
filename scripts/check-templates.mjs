#!/usr/bin/env node
/**
 * 模板一致性检查：roster 里写的画幅，必须和 template.json 里的 layouts 一模一样。
 * 两处数字对不上，就会在渲染时静默退回默认画幅——这种错只能靠机器查。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEMPLATES, specOf } from '../src/bots/roster.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PALETTE = ['void', 'bone', 'signal', 'ash']

const fail = []
const ok = []
const bad = (tpl, msg) => fail.push(tpl + '：' + msg)

for (const tpl of TEMPLATES) {
  const spec = specOf(tpl)
  if (!spec) { bad(tpl.id, 'specOf 返回空'); continue }
  if (!tpl.ratios[spec.ratio]) bad(tpl.id, '默认画幅 ' + spec.ratio + ' 不在 ratios 里')

  const file = join(ROOT, 'templates', tpl.id, 'template.json')
  if (!existsSync(file)) {
    // 纯字幕没有 template.json：整份规格在 roster 里，属于预期
    ok.push(tpl.id + '：roster 自带规格（无 template.json）')
    continue
  }

  const t = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const layouts = Object.keys(t.layouts || {})
  const roster = Object.keys(tpl.ratios || {})
  const missing = roster.filter(r => !layouts.includes(r))
  const extra = layouts.filter(r => !roster.includes(r))
  if (missing.length) bad(tpl.id, 'roster 有 ' + missing.join('/') + '，template.json 没有')
  if (extra.length) bad(tpl.id, 'template.json 有 ' + extra.join('/') + '，roster 没有')
  if (t.ratio !== spec.ratio) bad(tpl.id, '默认画幅对不上：roster ' + spec.ratio + ' / template.json ' + t.ratio)
  if (t.id !== tpl.id) bad(tpl.id, 'template.json 的 id 是 ' + t.id)
  const engine = tpl.engine || 'ffmpeg'
  if (t.engine !== engine) bad(tpl.id, '引擎对不上：roster ' + engine + ' / template.json ' + t.engine)

  for (const r of layouts) {
    const L = t.layouts[r]
    const size = tpl.ratios[r]
    if (!size) continue
    if (!Array.isArray(L.size) || L.size[0] !== size.width || L.size[1] !== size.height) {
      bad(tpl.id, r + ' 尺寸对不上：template ' + JSON.stringify(L.size) + ' / roster ' + size.width + 'x' + size.height)
    }
    if (specOf(tpl, r).ratio !== r) bad(tpl.id, r + ' 在 specOf 里解析不出来')
  }

  if (engine === 'canvas') {
    for (const k of PALETTE) if (!t.palette || !t.palette[k]) bad(tpl.id, '配色缺 ' + k)
    for (const r of layouts) {
      const L = t.layouts[r]
      for (const k of ['rail', 'band', 'big', 'label']) if (!L[k]) bad(tpl.id, r + ' 布局缺 ' + k)
      if (L.rail && (L.rail.x + L.rail.right) >= L.size[0]) bad(tpl.id, r + ' 光轨宽度算出负数')
      if (L.big && (L.big.left + L.big.right) >= L.size[0]) bad(tpl.id, r + ' 大字可用宽度算出负数')
    }
  }
  if (!fail.length) ok.push(tpl.id + '：' + roster.join(' / ') + ' 都合上了')
}

const out = fail.length ? 'FAIL\n' + fail.map(f => '  · ' + f).join('\n') : 'PASS\n' + ok.map(o => '  · ' + o).join('\n')
console.log(out)
process.exit(fail.length ? 1 : 0)
