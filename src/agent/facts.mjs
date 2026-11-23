/**
 * 事实表：这一轮工具返回过的所有数字。
 *
 * 为什么要有它——模型会顺手写「渲染用了 3 分钟」这种好听的假话。规矩是：
 * bot 说的话里每个数字都必须能在事实表里找到出处，找不到就重写一次；
 * 重写还编，就把那几个数标出来，不静默放过。
 *
 * 只做数字，不做语义：语义真假由工具的证据链负责（质检的每项都要带证据）。
 */

const NUM = /\d+(?:\.\d+)?/g
const round = n => {
  const r = Math.round(n * 1000) / 1000
  return String(r)
}

export class FactBook {
  constructor(label = '') {
    this.label = label
    this.map = new Map() // 规范化字符串 -> [原值]
  }

  /** 把任意结构里所有数字收进来（对象、数组、字符串里的数字都收） */
  addAll(value, source = 'tool') {
    const walk = v => {
      if (v === null || v === undefined) return
      if (typeof v === 'number' && Number.isFinite(v)) { this.add(v, source); return }
      if (typeof v === 'string') {
        const m = v.match(NUM)
        if (m) for (const x of m) this.add(Number(x), source)
        return
      }
      if (Array.isArray(v)) { for (const x of v) walk(x); return }
      if (typeof v === 'object') { for (const x of Object.values(v)) walk(x) }
    }
    walk(value)
    return this
  }

  add(n, source = 'tool') {
    if (!Number.isFinite(n)) return this
    const k = round(n)
    if (!this.map.has(k)) this.map.set(k, [])
    const arr = this.map.get(k)
    if (!arr.includes(source)) arr.push(source)
    return this
  }

  size() { return this.map.size }

  /**
   * 这个数有没有出处。
   * 宽松一点的地方：措辞允许按自己写的位数四舍五入（17.04 → 17.0，24.93 → 24.9，68.4 → 68）。
   * 不宽松的地方：差超过半格就算编（68.4 → 69 拦）。
   */
  has(n) {
    if (!Number.isFinite(n)) return null
    const k = round(n)
    if (this.map.has(k)) return { exact: true, sources: this.map.get(k) }
    const digits = (String(n).split('.')[1] || '').length
    if (digits > 2) return null
    for (const [key, sources] of this.map) {
      const v = Number(key)
      if (Math.abs(v - n) > 0.55) continue
      if (Number(v.toFixed(digits)) === n) return { exact: false, near: v, sources }
    }
    return null
  }

  /** 检查一段话：返回没出处的数字（违规）和有出处的（用于报告） */
  check(text) {
    const bad = []
    const hit = []
    const seen = new Set()
    for (const m of String(text || '').match(NUM) || []) {
      if (seen.has(m)) continue
      seen.add(m)
      const n = Number(m)
      const h = this.has(n)
      if (h) hit.push({ raw: m, value: n, exact: h.exact, sources: h.sources })
      else bad.push({ raw: m, value: n })
    }
    return { ok: bad.length === 0, bad, hit }
  }

  /** 违规数字的简短说明，用来让模型重写 */
  hint(bad) {
    if (!bad || !bad.length) return ''
    return '这几个数字没有出处，不许写：' + bad.map(b => b.raw).join('、') +
      '。要么删掉，要么先调工具拿到真数再说。'
  }
}
