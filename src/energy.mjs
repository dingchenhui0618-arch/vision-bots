/**
 * 音频能量包络：给剪辑的接缝吸附用（在刀口附近找最安静的地方下刀）。
 *
 * 只读 ffmpeg 抽出来的 16k 单声道 PCM16 WAV（extractAudio 的产物），不引第三方解码库：
 * 这是整条管线里唯一需要「听」音频的地方，加一个依赖不值得。
 */
import { readFileSync } from 'node:fs'

/** 解析 RIFF/WAVE：只认 PCM16，其他格式直接说清楚，不猜。 */
export function readWavPcm16(path) {
  const buf = readFileSync(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件：' + path)
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = { start: body, size: Math.min(size, buf.length - body) }
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺 fmt 或 data 段：' + path)
  if (fmt.bits !== 16 || (fmt.format !== 1 && fmt.format !== 0xfffe)) {
    throw new Error('只支持 PCM16 WAV（拿到 ' + fmt.bits + 'bit / format ' + fmt.format + '）')
  }
  const n = Math.floor(data.size / 2 / fmt.channels)
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let v = 0
    for (let c = 0; c < fmt.channels; c++) v += buf.readInt16LE(data.start + (i * fmt.channels + c) * 2)
    samples[i] = v / fmt.channels / 32768
  }
  return { samples, sampleRate: fmt.sampleRate, channels: fmt.channels }
}

/**
 * dB 包络：5ms 一步、20ms 一窗的 RMS。
 * 用前缀和算，3 分钟 16k 音频约 0.2s，比逐窗重算快一个量级。
 */
export function envelope16(path, { hopMs = 5, winMs = 20 } = {}) {
  const { samples, sampleRate } = readWavPcm16(path)
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000))
  const win = Math.max(hop, Math.round((sampleRate * winMs) / 1000))
  const frames = Math.floor(samples.length / hop)
  const ps = new Float64Array(samples.length + 1)
  for (let i = 0; i < samples.length; i++) ps[i + 1] = ps[i] + samples[i] * samples[i]
  const db = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    const a = f * hop
    const b = Math.min(samples.length, a + win)
    const mean = (ps[b] - ps[a]) / Math.max(1, b - a)
    db[f] = 10 * Math.log10(mean + 1e-12)
  }
  return { db, hopSec: hop / sampleRate, winSec: win / sampleRate, sampleRate }
}
