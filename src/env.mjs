import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CANDIDATES = [
  process.env.FFMPEG_DIR,
  'C:/ffmpeg/bin',
  join(homedir(), 'AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
]

function findDir(name) {
  for (const dir of CANDIDATES) {
    if (dir && existsSync(join(dir, name))) return dir
  }
  // 在 WinGet 包目录里兜底搜索一次
  const pkgRoot = join(homedir(), 'AppData/Local/Microsoft/WinGet/Packages')
  if (existsSync(pkgRoot)) {
    for (const pkg of readdirSync(pkgRoot)) {
      if (!pkg.toLowerCase().startsWith('gyan.ffmpeg')) continue
      const base = join(pkgRoot, pkg)
      for (const sub of readdirSync(base)) {
        const bin = join(base, sub, 'bin')
        if (existsSync(join(bin, name))) return bin
      }
    }
  }
  return null
}

export const FFMPEG_DIR = findDir('ffmpeg.exe') || findDir('ffmpeg')
export const FFMPEG = FFMPEG_DIR ? join(FFMPEG_DIR, existsSync(join(FFMPEG_DIR, 'ffmpeg.exe')) ? 'ffmpeg.exe' : 'ffmpeg') : 'ffmpeg'
export const FFPROBE = FFMPEG_DIR ? join(FFMPEG_DIR, existsSync(join(FFMPEG_DIR, 'ffprobe.exe')) ? 'ffprobe.exe' : 'ffprobe') : 'ffprobe'

/**
 * 光轨引擎：本地 vendor 的 engine/ + tools/render.mjs，字体体积大，留在独立目录里按需指向。
 * 换机器时把 LIGHTTRAIL_FONTS 指过去即可，代码不用动。
 */
const LT_CANDIDATES = [
  process.env.LIGHTTRAIL_FONTS,
  'D:/Projects/koubo-cut/vendor/lighttrail/assets/fonts',
  join(homedir(), 'koubo-cut/vendor/lighttrail/assets/fonts'),
]

export const LIGHTTRAIL_FONTS = LT_CANDIDATES.find(d => d && existsSync(join(d, 'NotoSansSC.ttf'))) || null
export const CHROME =
  process.env.LIGHTTRAIL_CHROME ||
  ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync) ||
  null

export function assertCanvasTools() {
  assertTools()
  if (!LIGHTTRAIL_FONTS) throw new Error('找不到光轨字体：设置 LIGHTTRAIL_FONTS 指向含 NotoSansSC.ttf 的目录')
  if (!CHROME) throw new Error('找不到 Chrome：设置 LIGHTTRAIL_CHROME')
  return { fonts: LIGHTTRAIL_FONTS, chrome: CHROME }
}

export function assertTools() {
  if (!FFMPEG_DIR) throw new Error('找不到 ffmpeg：设置 FFMPEG_DIR 或把 ffmpeg 加进 PATH')
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE }
}
