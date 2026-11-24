/**
 * 量「画面有多暗」：每帧缩成 1×1 灰度，统计平均亮度低于阈值的帧占比。
 *
 * 这是「像不像参考片」里最靠前的一条硬指标：自测08 有 29.3% 的帧是近黑（<40/255），
 * 参考片只有 0.2%——三成时长在看黑屏，字调得再好也没用。自测09 修到 0%。
 *
 * 用法：node scripts/measure-dark.mjs <视频> [阈值=40]
 * ffmpeg 路径可用环境变量 FFMPEG 覆盖。
 */

// 量"画面有多暗"：每帧缩成 1×1 灰度，统计平均亮度低于阈值的帧占比。
// 用途：证明小窗/章节卡那种"整屏近黑"占了多少时长——这是和参考片最直观的差。
import { execFileSync } from 'node:child_process'
const FF = process.env.FFMPEG || 'C:/Users/123/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe'
const file = process.argv[2]
const thr = Number(process.argv[3] || 40)
const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', 'scale=1:1,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 })
const vals = [...raw]
const dark = vals.filter(v => v < thr).length
const veryDark = vals.filter(v => v < 20).length
console.log(JSON.stringify({
  file: file.split(/[\\/]/).pop(),
  frames: vals.length,
  darkShare: +(dark / vals.length * 100).toFixed(1),
  veryDarkShare: +(veryDark / vals.length * 100).toFixed(1),
  mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1),
}))