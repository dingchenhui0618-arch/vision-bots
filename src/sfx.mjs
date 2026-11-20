/**
 * 音效：只回应画面上看得见的动作，全部本地合成，不带样本文件。
 * 光轨的音效词汇里我们只用得上六个：click zip scan blip impact drop。
 */
import { writeFileSync } from 'node:fs'

const SR = 48000

const mulberry = seed => () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
  return ((x ^ (x >>> 14)) >>> 0) / 4294967296
}

const env = (n, a = 0.004, d = 0.12) => {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / SR
    const at = t < a ? t / a : 1
    out[i] = at * Math.exp(-Math.max(0, t - a) / d)
  }
  return out
}

const sweep = (dur, f0, f1) => {
  const n = Math.max(1, Math.round(dur * SR))
  const out = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const k = i / n
    const f = f0 * Math.pow(f1 / f0, k)
    phase += (2 * Math.PI * f) / SR
    out[i] = Math.sin(phase)
  }
  return out
}

const noise = (dur, rnd, lp = 0.25) => {
  const n = Math.max(1, Math.round(dur * SR))
  const out = new Float32Array(n)
  let y = 0
  for (let i = 0; i < n; i++) {
    y += (rnd() * 2 - 1 - y) * lp
    out[i] = y
  }
  return out
}

const shaped = (buf, e) => {
  const out = new Float32Array(buf.length)
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] * e[Math.min(i, e.length - 1)]
  return out
}

/** 一个 cue 一个声音；不认识的类型直接跳过，不猜。 */
function render(type, rnd) {
  switch (type) {
    case 'click':
      return shaped(sweep(0.03, 1700, 1500), env(Math.round(0.03 * SR), 0.001, 0.006))
    case 'blip':
      return shaped(sweep(0.09, 2200, 2600), env(Math.round(0.09 * SR), 0.002, 0.02))
    case 'zip':
      return shaped(sweep(0.24, 640, 4200), env(Math.round(0.24 * SR), 0.006, 0.10))
    case 'scan': {
      const n = Math.round(0.55 * SR)
      const bufs = noise(0.55, rnd, 0.10)
      const e = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        const k = i / n
        e[i] = Math.min(1, k / 0.25) * Math.exp(-Math.max(0, k - 0.25) * 3.2) * 0.7
      }
      return shaped(bufs, e)
    }
    case 'impact': {
      const n = Math.round(0.34 * SR)
      const low = shaped(sweep(0.34, 110, 44), env(n, 0.002, 0.11))
      const hit = shaped(noise(0.34, rnd, 0.55), env(n, 0.001, 0.035))
      return low.map((v, i) => v * 0.9 + hit[i] * 0.5)
    }
    case 'drop': {
      const n = Math.round(0.6 * SR)
      const low = shaped(sweep(0.6, 130, 34), env(n, 0.003, 0.22))
      return low
    }
    default:
      return null
  }
}

export function synthCues(cues, duration, out, { seed = 55, bus = 0.42 } = {}) {
  const n = Math.max(1, Math.round(duration * SR))
  const mix = new Float32Array(n)
  const rnd = mulberry(seed)
  let used = 0
  for (const cue of cues || []) {
    const buf = render(cue.sfx, rnd)
    if (!buf) continue
    used++
    const start = Math.max(0, Math.round(Number(cue.t || 0) * SR))
    const g = Number(cue.gain ?? 1) * bus
    for (let i = 0; i < buf.length && start + i < n; i++) mix[start + i] += buf[i] * g
  }
  // 只在超限时整体压，不压缩动态
  let peak = 0
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(mix[i]))
  const k = peak > 0.92 ? 0.92 / peak : 1
  const pcm = Buffer.alloc(n * 2)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mix[i] * k))
    pcm.writeInt16LE(Math.round(v * 32767), i * 2)
  }
  writeFileSync(out, Buffer.concat([wavHeader(n * 2, n), pcm]))
  return { out, cues: used, peak: Number((peak * k).toFixed(3)) }
}

function wavHeader(dataBytes, frames) {
  const b = Buffer.alloc(44)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + dataBytes, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(SR, 24)
  b.writeUInt32LE(SR * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(dataBytes, 40)
  return b
}

/** 从一段 PCM 里量出 100Hz 的峰值包络，给声波基线用。 */
export function peaksFromPCM(buf, rate = 100, sampleRate = SR) {
  const total = Math.floor(buf.length / 2)
  const win = Math.max(1, Math.round(sampleRate / rate))
  const out = []
  for (let i = 0; i + win <= total; i += win) {
    let m = 0
    for (let k = 0; k < win; k++) m = Math.max(m, Math.abs(buf.readInt16LE((i + k) * 2)))
    out.push(Number((m / 32768).toFixed(3)))
  }
  return { rate, peak: out }
}
