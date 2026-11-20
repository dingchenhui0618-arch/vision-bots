import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const run = promisify(execFile)
const UV = join(homedir(), '.local', 'bin', 'uv.exe')
const SCRIPT = new URL('../tools/asr.py', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export async function transcribe(audio, { out, model = 'small', language = 'zh', threads = 4, hotwords = '' }) {
  const base = existsSync(UV)
    ? { cmd: UV, pre: ['run', '--python', '3.12', '--with', 'faster-whisper', '--with', 'av<14', '--with', 'opencc-python-reimplemented', 'python'] }
    : { cmd: 'python', pre: [] }
  const args = [...base.pre, SCRIPT, '--audio', audio, '--out', out, '--model', model, '--language', language, '--threads', String(threads)]
  if (hotwords) args.push('--hotwords', hotwords)
  const { stdout } = await run(base.cmd, args, { maxBuffer: 32 << 20, timeout: 30 * 60 * 1000 })
  const stat = JSON.parse(stdout.trim().split('\n').at(-1))
  return { ...stat, json: JSON.parse(readFileSync(out, 'utf8')) }
}
