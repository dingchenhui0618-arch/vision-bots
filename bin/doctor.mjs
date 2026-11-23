#!/usr/bin/env node
/**
 * dsm doctor：这台机器能不能出片、用什么编、每个编码器的结论。
 *
 * 装机第一件事、换机器第一件事都跑它。它不猜：每个编码器都真编一段、真切一段、
 * 真拼回去逐帧比，过不了就把原因写下来（「驱动版本不够」比「不支持」有用）。
 * 加 --bench 再量速度／体积，--save 把结论记进 work/machine.json，以后开片沿用。
 */
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { existsSync, globSync, statSync } from 'node:fs'
import { FFMPEG, FFMPEG_DIR, CHROME, LIGHTTRAIL_FONTS } from '../src/env.mjs'
import { candidates, verify, bench, resolveEncoder, rememberEncoder, pickBest, plainName, explain, SIZE_SLACK } from '../src/encoder.mjs'
import { readTerms, validateTerms } from '../src/assets.mjs'
import { pinyinOf } from '../src/asr-fix.mjs'
import { llmStatus } from '../src/llm.mjs'

const { values } = parseArgs({
  options: {
    bench: { type: 'boolean', default: false },
    save: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    source: { type: 'string' },
  },
  allowPositionals: true,
})

/** 中日韩字符按两格宽算，表格才对得齐 */
function width(s) {
  let n = 0
  for (const ch of String(s)) n += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return n
}
function pad(s, w) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, w - width(t)))
}

function ffVersion() {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8' })
  const line = String(r.stdout || '').split('\n')[0] || ''
  return { ok: r.status === 0, version: (line.match(/ffmpeg version (\S+)/) || [])[1] || '?', path: FFMPEG }
}

async function pingModel() {
  const st = llmStatus()
  if (!st.key) return { ...st, ok: false, why: '没有凭证（~/.codex/auth.json 或 DSH_MEDIA_LLM_KEY）' }
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 3000)
    const res = await fetch(st.base.replace(/\/v1$/, '') + '/v1/models', { signal: ctl.signal })
    clearTimeout(timer)
    return { ...st, ok: res.ok, why: res.ok ? '' : 'HTTP ' + res.status }
  } catch (e) {
    return { ...st, ok: false, why: String(e.message || e).slice(0, 60) }
  }
}

/** 最近一条真实母版：用它量出来的时间和体积才是这台机器出片的口径。 */
function newestMaster() {
  let best = null
  for (const f of globSync('groups/*/cache/*/master.mkv')) {
    const t = statSync(f).mtimeMs
    if (!best || t > best.t) best = { f, t }
  }
  return best && best.f
}

const ffv = ffVersion()
if (!ffv.ok) {
  console.error('找不到能跑的 ffmpeg（' + FFMPEG + '）。设置 FFMPEG_DIR 或把 ffmpeg 加进 PATH 再来。')
  process.exit(2)
}

const list = candidates()
const contract = []
for (const c of list) contract.push({ ...c, verify: await verify(c) })
const feasible = contract.filter(c => c.verify.ok)

let sizes = null
let sourceInfo = ''
let realSource = null
if (values.bench) {
  realSource = values.source && existsSync(values.source) ? values.source : newestMaster()
  sourceInfo = values.source && existsSync(values.source)
    ? '指定素材 ' + values.source
    : realSource ? '最近一条真实母版 ' + realSource : '合成源（太干净，口径不准——只用来验契约，不参与选型）'
  sizes = []
  for (const c of feasible) sizes.push(await bench(c, { source: realSource }))
}

// 合成源上算出来的胜负不算数：平色画面把 x264 和硬编的差距压平了，
// 在这上面选型会选错（本机实测：合成源选 QuickSync，真母版选 veryfast）。
const best = sizes && realSource ? pickBest(sizes) : null
const plan = resolveEncoder()
if (values.save && best) rememberEncoder(best.chosen.id, 'doctor --bench 选型')

const py = await pinyinOf(['转场'])
const pinyinOk = Array.isArray(py) && Boolean(py[0])
let terms = null
try {
  const t = readTerms()
  terms = { hotwords: (t.hotwords || []).length, terms: (t.terms || []).length, warnings: validateTerms(t).warnings }
} catch (e) {
  terms = { error: String(e.message || e).slice(0, 80) }
}
const model = await pingModel()

const report = {
  platform: process.platform + ' ' + process.arch,
  node: process.version,
  ffmpeg: ffv,
  encoder: { chosen: plan.id, label: plainName(plan), source: plan.source },
  best: best && best.chosen,
  contract: contract.map(c => ({ id: c.id, label: c.label, ok: c.verify.ok, stage: c.verify.stage, why: c.verify.why, hint: explain(c.verify.why) })),
  bench: sizes,
  tools: {
    chrome: CHROME || null,
    fonts: LIGHTTRAIL_FONTS || null,
    pinyin: pinyinOk,
    model: { base: model.base, model: model.model, ok: model.ok, why: model.why },
    terms,
  },
}

if (values.json) {
  console.log(JSON.stringify(report, null, 2))
} else {
  const L = []
  L.push('Vision Bots · 这台机器的出片能力')
  L.push('')
  L.push('  ' + pad('平台', 10) + report.platform + ' · Node ' + report.node)
  L.push('  ' + pad('ffmpeg', 10) + ffv.version + ' · ' + ffv.path)
  L.push('  ' + pad('编码器', 10) + plainName(plan) + (plan.source === 'cache' ? '（上次 doctor --save 记下的）' : plan.source === 'env' ? '（VISION_BOTS_ENCODER 指定的）' : '（默认）'))
  L.push('')
  L.push('契约自检：编得出来 · 关键帧落在 32 帧栅格 · 切出来拼得回（窗口外逐帧一致）')
  for (const c of contract) {
    const v = c.verify
    L.push('  ' + pad(c.label, 26) + (v.ok ? '通过' : '不过') + '  ' + (v.ok
      ? v.checks.frames + ' 帧，关键帧 ' + v.checks.keyframes + ' 个，窗口外 ' + v.checks.spliceOutsideFrames + ' 帧逐帧一致'
      : explain(v.why)))
  }
  if (sizes) {
    const widest = Math.max(...sizes.map(s => width(s.label)))
    L.push('')
    L.push('实测：' + sourceInfo + '，96 帧，只计编码')
    for (const s of sizes.filter(x => x.ok)) {
      const mark = best && best.chosen.id === s.id ? '  ← 按规则选它' : ''
      L.push('  ' + pad(s.label, widest + 2) + String(s.seconds.toFixed(1)).padStart(5) + 's  ' + s.mb.toFixed(2).padStart(6) + 'MB' + mark)
    }
    if (best) {
      L.push('')
      L.push('  规则：体积不超过最小体积（' + best.minMB.toFixed(2) + 'MB）的 ' + Math.round((SIZE_SLACK - 1) * 100) + '% 里取最快的，')
      L.push('        因为平台会二次压缩，体积大的先掉画质；同体积下快一截才是白拿的。')
      if (values.save) L.push('  已记进 work/machine.json：以后开片用 ' + plainName(best.chosen))
    } else if (sizes.some(x => x.ok)) {
      L.push('')
      L.push('  这次没有真实母版，只验了契约、没选型：装上第一条真素材后跑 node bin/doctor.mjs --bench --save')
    } else {
      L.push('')
      L.push('  没有一个候选能跑起来。')
    }
  } else {
    L.push('')
    L.push('  加 --bench 量速度与体积（每种可行编码器真编 96 帧）。')
  }
  L.push('')
  L.push('其它')
  L.push('  ' + pad('Chrome', 14) + (report.tools.chrome || '缺（光轨模板要用：设置 LIGHTTRAIL_CHROME）'))
  L.push('  ' + pad('光轨字体', 14) + (report.tools.fonts || '缺（设置 LIGHTTRAIL_FONTS 指向含 NotoSansSC.ttf 的目录）'))
  L.push('  ' + pad('拼音校验', 14) + (pinyinOk ? '有（术语表存盘时同音门会跑，1–2 秒）' : '没有（同音门会明说「没跑」，不假装验过）'))
  L.push('  ' + pad('模型端点', 14) + (model.ok ? model.model + ' @ ' + model.base : '不可用：' + (model.why || '?')))
  L.push('  ' + pad('术语表', 14) + (terms.error ? '读不了：' + terms.error : terms.hotwords + ' 热词 / ' + terms.terms + ' 术语 / ' + terms.warnings.length + ' 提醒'))
  L.push('')
  if (!values.bench) L.push('换机器就再跑一次：node bin/doctor.mjs --bench --save')
  console.log(L.join('\n'))
}