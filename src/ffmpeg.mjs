import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdirSync } from 'node:fs'
import { FFMPEG, FFPROBE } from './env.mjs'

const run = promisify(execFile)
export const MAXBUF = 64 << 20

/** 带进度回调地跑一个命令；超长任务靠 maxBuffer 兜住。 */
export function ff(args, opts = {}) {
  return run(process.env.FFMPEG_BIN || FFMPEG, args, { maxBuffer: MAXBUF, ...opts })
}

export function probeFile(file) {
  return run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: MAXBUF })
    .then(({ stdout }) => JSON.parse(stdout))
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function even(n) {
  return n % 2 === 0 ? n : n - 1
}

/** 抽 16k 单声道音频给 ASR。 */
export async function extractAudio(input, output) {
  await ff(['-y', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output])
  return output
}
