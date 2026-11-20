/**
 * 断行自检：换行只允许落在词边界上，且一个字都不能丢。
 *
 * 机器看不见「难看」，但看得出「这一行的结尾不在词边界上」——
 * 「很多人做口播视 / 频最大的问题」就是这种硬错。审美另看抽帧（docs/）。
 *
 *   node scripts/check-wrapping.mjs
 */
import { segment, wrapWords } from '../src/segment.mjs'

// 真实测试素材的章节原文（合成语音那版），加几句长短不一的
const CORPUS = [
  '很多人做口播视频最大的问题不是不会说话',
  '而是录完之后不知道怎么剪',
  '删掉停顿吧画面会一跳一跳的',
  '不删吧观众三秒就划走了',
  '所以我们做了一个东西专门解决这件事',
  '这条片子我剪了八个小时',
  '完播率上不去是因为开头三秒没有钩子',
  '转场别用花手，观众看得出来',
  '光轨里的大字要挂在人物身后',
]

const WIDTHS = [6, 7, 8, 9, 10, 12, 14]

/** 分词边界：返回「从开头数第 n 个字」的合法断点集合 */
function boundaries(text) {
  const set = new Set()
  let n = 0
  for (const w of segment(text)) {
    n += w.length
    set.add(n)
  }
  return set
}

let fail = 0
let checked = 0
for (const text of CORPUS) {
  const ok = boundaries(text)
  for (const per of WIDTHS) {
    const lines = wrapWords(text, per)
    checked++
    const joined = lines.join('')
    if (joined !== text) {
      fail++
      console.log(`FAIL 丢字/多字 per=${per} 「${text}」 → 「${joined}」`)
      continue
    }
    let n = 0
    let bad = null
    for (const line of lines) {
      n += line.length
      if (n < text.length && !ok.has(n)) bad = line
    }
    if (bad) {
      fail++
      console.log(`FAIL 断在词中间 per=${per} 「${text}」 → ${JSON.stringify(lines)}`)
      continue
    }
    const over = lines.find(l => l.length > per + 4)
    if (over) {
      fail++
      console.log(`FAIL 一行超宽 per=${per} 「${text}」 → 「${over}」`)
    }
  }
}

// 词本身就是拼回去的原文，一条都别漏
for (const text of CORPUS) {
  const words = segment(text)
  if (words.join('') !== text) {
    fail++
    console.log(`FAIL 分词改了字 「${text}」 → 「${words.join('')}」`)
  }
}

console.log(fail ? `FAIL · ${fail}/${checked} 条断行有问题` : `PASS · ${checked} 条断行全部落在词边界上`)
process.exit(fail ? 1 : 0)
