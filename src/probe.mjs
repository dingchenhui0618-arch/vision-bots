import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { FFPROBE } from './env.mjs'

const run = promisify(execFile)

export async function probe(file) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file], { maxBuffer: 8 << 20 })
  const info = JSON.parse(stdout)
  const video = info.streams.find(s => s.codec_type === 'video')
  const audio = info.streams.find(s => s.codec_type === 'audio')
  if (!video) throw new Error('没有视频流')
  const [num, den] = String(video.r_frame_rate || '30/1').split('/').map(Number)
  return {
    file,
    duration: Number(info.format.duration || 0),
    width: video.width,
    height: video.height,
    fps: den ? num / den : 30,
    hasAudio: Boolean(audio),
    audioRate: audio ? Number(audio.sample_rate) : 0,
    sizeBytes: Number(info.format.size || 0),
  }
}
