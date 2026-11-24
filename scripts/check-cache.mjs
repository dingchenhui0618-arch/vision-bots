/**
 * 分段缓存的判定规则：哪些改动必须触发重渲。
 * 纯逻辑，不渲一帧、不起浏览器。
 *
 * 自测13 踩到的坑：planPatch 只比 bigs / beats，于是「只改了 chips（或 blocks）」被判成
 * 「画面完全一样」，直接把上一版成片交回去——scene 变了、成片没变，而且是静默的。
 * 所以这里盯的不是「算法快不快」，是「该重渲的有没有被漏掉」。
 */
import { hashOf, planPatch } from '../src/render-cache.mjs'

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '：' + detail : '')) }

const base = () => ({
  template: 'zheguang', ratio: '9:16', size: [1080, 1920], fps: 30, frames: 600, duration: 20,
  shots: [{ f0: 0, f1: 20, kind: 'full' }],
  pages: [{ index: 1, start: 0, end: 20, title: '标题' }],
  sections: [{ index: 1, start: 0, end: 20, text: '原话' }],
  cues: [{ t: 0.1, sfx: 'click', gain: 0.6 }],
  bigs: [{ index: 1, f0: 2, f1: 5, text: '一句大字', lines: ['一句大字'] }],
  beats: [{ f0: 2, f1: 5, text: '一句大字', chars: [{ ch: '一', f0: 2, f1: 2.3 }] }],
  subs: [{ f0: 2, f1: 5, text: '一句大字', runs: [] }],
  chips: [{ text: 'GPT', f0: 3, f1: 7, side: 0, lane: 0, page: 1, hot: 1 }],
  blocks: [{ kind: 'gauge', f0: 6, f1: 9, at: 'mid' }],
})
const run = (mutate) => {
  const scene = base()
  const next = JSON.parse(JSON.stringify(scene))
  mutate(next)
  const hash = hashOf('tpl', 'film')
  return planPatch({ prev: { scene, hash, peaks: 'p' }, next: { scene: next, hash, peaks: 'p' }, fps: 30 })
}

ok('画面完全一样 → 复用（不重渲）', run(() => {}).mode === 'reuse', run(() => {}).mode)
const chipOnly = run(n => { n.chips[0].text = 'Claude' })
ok('只改小标签 → 必须重渲（不是 reuse）', chipOnly.mode !== 'reuse', chipOnly.mode + ' ' + chipOnly.reason)
ok('只改小标签 → 只重渲它那一段（不是整条）', chipOnly.mode === 'patch' && chipOnly.from <= 90 && chipOnly.to >= 210, JSON.stringify(chipOnly))
const blockOnly = run(n => { n.blocks[0].f1 = 11 })
ok('只改图形块 → 必须重渲', blockOnly.mode !== 'reuse', blockOnly.mode)
const subOnly = run(n => { n.subs[0].text = '改一句字幕' })
ok('只改字幕 → 必须重渲', subOnly.mode !== 'reuse', subOnly.mode)
const shotChange = run(n => { n.shots[0].kind = 'corner' })
ok('版式一换 → 整条重渲（人物位置全变）', shotChange.mode === 'full', shotChange.mode + ' ' + shotChange.reason)
const pageChange = run(n => { n.pages[0].title = '换个章节名' })
ok('章节名一换 → 整条重渲（章节卡逐页变）', pageChange.mode === 'full', pageChange.mode)
const bigChange = run(n => { n.bigs[0].text = '另一句字'; n.bigs[0].lines = ['另一句字'] })
ok('改一条大字 → 只重渲那几秒', bigChange.mode === 'patch' && bigChange.from <= 58 && bigChange.to >= 152, JSON.stringify(bigChange))
const tooWide = run(n => { for (const c of n.chips) c.f1 = 19.5; n.blocks[0].f1 = 19.5 })
ok('改动超过 45% 帧 → 干脆整条重渲', tooWide.mode === 'full', tooWide.mode)

console.log('缓存判定：' + pass + ' 通过，' + fails.length + ' 失败')
for (const f of fails) console.log('  ✗ ' + f)
if (fails.length) process.exit(1)
