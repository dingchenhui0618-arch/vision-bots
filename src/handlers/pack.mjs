/**
 * 包装：按模板出片。模板 = 引擎代码 + template.json，内容 = scene.json。
 * 两种引擎：ffmpeg（ASS 烧字幕 / 构图）和 canvas（逐帧渲染，光轨）。
 */
import { join } from 'node:path'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderCut, renderStill } from '../render.mjs'
import { toASS, toSRT } from '../captions.mjs'
import { templateById, specOf } from '../bots/roster.mjs'

const TPL_ROOT = fileURLToPath(new URL('../../templates/', import.meta.url))

async function loadTemplate(id) {
  const dir = join(TPL_ROOT, id)
  const entry = join(dir, 'index.mjs')
  if (!existsSync(entry)) return null
  return import(pathToFileURL(entry).href)
}

export async function runPack({ group, job, log, artifact, brief, state }) {
  if (!state.plan) throw new Error('剪辑还没交时间线')
  const input = group.meta.assets[0]
  const tpl = templateById(group.meta.template) || templateById('subtitle-only')
  const spec = specOf(tpl, brief && brief.ratio)
  const work = join(group.dir, 'work', job.id)
  if (spec.unsupported) {
    log('「' + tpl.name + '」没有 ' + brief.ratio + '，按 ' + spec.ratio + ' 出片')
    group.say('packer', '「' + tpl.name + '」还没做 ' + brief.ratio + '，这条按 ' + spec.ratio + '（' + spec.width + '×' + spec.height + '）出。要 ' + brief.ratio + ' 我另排一版布局。', { job: job.id })
  }
  mkdirSync(work, { recursive: true })

  const mod = await loadTemplate(tpl.id)
  const builder = mod && (mod.buildPptBase || mod.build)
  if (!builder) {
    log('模板「' + tpl.name + '」没有渲染器，先用纯字幕出片')
    group.say('packer', '「' + tpl.name + '」的引擎还没做，这条先按纯字幕出片，时间线不用动。', { job: job.id })
  }

  let built = null
  if (builder) {
    built = builder({ words: state.transcript.words, segments: state.transcript.segments, plan: state.plan, brief: { ...brief, ratio: spec.ratio }, spec, captions: state.captions })
    if (built.scene) {
      const scenePath = join(work, 'scene.json')
      writeFileSync(scenePath, JSON.stringify(built.scene, null, 2), 'utf8')
      artifact('scene', scenePath)
      state.scene = built.scene
      log(tpl.name + '：' + (built.scene.chapters || built.scene.bigs || []).length + ' 章，' + (built.scene.ratio || spec.ratio) + ' ' + spec.width + '×' + spec.height)
    }
  }

  // 字幕跟着这一版的文字走：改一句之后片子里是新的，交付的 SRT 也必须是新的。
  // （以前 SRT 只在剪辑那一步写一次，改字之后片子对了、字幕还是旧的——交付物自相矛盾。）
  if (state.captions && state.captions.cards) {
    const subsPath = join(work, 'subs.srt')
    writeFileSync(subsPath, toSRT(state.captions.cards), 'utf8')
    artifact('subs', subsPath)
  }

  const engine = (built && built.engine) || tpl.engine || 'ffmpeg'
  const out = join(group.dir, 'out', 'video.mp4')
  mkdirSync(join(group.dir, 'out'), { recursive: true })
  const t0 = Date.now()
  let renderSeconds

  if (engine === 'canvas' && mod && mod.render) {
    log('逐帧渲染中（' + spec.width + '×' + spec.height + '，' + (built.scene.frames) + ' 帧，' + tpl.name + '）')
    const r = await mod.render({
      input, plan: state.plan, scene: built.scene, work, out,
      spec: { ...spec, template: mod.template }, log,
      // 母版放群级缓存：换一次工作目录也还是同一份母版，改一句才有的可切
      cacheDir: join(group.dir, 'cache', tpl.id),
    })
    renderSeconds = r.renderSeconds
    state.decision = r.decision || null
  } else {
    const assText = (built && built.assText) || toASS(state.captions.cards, {
      width: spec.width, height: spec.height,
      fontSize: Math.round(spec.height / 30),
      marginBottom: Math.round(spec.height * 0.12),
      font: brief.font || 'Microsoft YaHei',
    })
    log('渲染中（' + spec.width + '×' + spec.height + '，' + state.plan.keep.length + ' 段，' + tpl.name + '）')
    await renderCut({ input, plan: state.plan, assText, out, hasAudio: state.source.hasAudio, size: [spec.width, spec.height], layout: built ? built.layout || null : null })
    renderSeconds = (Date.now() - t0) / 1000
  }

  artifact('video', out, { template: tpl.id, duration: state.plan.outDuration })
  const preview = join(group.dir, 'out', 'preview.jpg')
  await renderStill(out, Math.min(1.2, state.plan.outDuration / 3), preview)
  artifact('preview', preview)

  state.video = out
  state.preview = preview
  state.renderSeconds = renderSeconds

  group.say('packer',
    '出片了：' + tpl.name + '，' + spec.width + '×' + spec.height + '，' + state.plan.outDuration.toFixed(1) + 's，渲染 ' + renderSeconds.toFixed(1) + 's。' +
    (state.scene && state.scene.bigs ? '\n' + state.scene.bigs.length + ' 章大字，逐字落在音节上；光轨一条到底，音效跟着动作走。' : '') +
    (state.scene && state.scene.chapters ? '\n分 ' + state.scene.chapters.length + ' 章，小节标题取的是原话，没有改写。' : '') +
    (state.decision && state.decision.mode === 'patch'
      ? '\n只是改了那一处：' + state.decision.reason + '，其余帧从母版切出来拼回去，渲染 ' + renderSeconds.toFixed(1) + 's。'
      : '') +
    (state.decision && state.decision.mode === 'reuse' ? '\n画面一点没变，直接复用母版，渲染 ' + renderSeconds.toFixed(1) + 's。' : '') +
    (state.decision && state.decision.mode === 'full' && renderSeconds > state.plan.outDuration * 1.2 ? '\n渲染比实时慢 ' + (renderSeconds / state.plan.outDuration).toFixed(2) + ' 倍（整条重渲），这条模板靠分段缓存省时间。' : ''),
    { job: job.id })

  return { video: out, preview, renderSeconds, engine }
}
