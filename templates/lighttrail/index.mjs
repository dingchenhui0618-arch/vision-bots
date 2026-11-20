/**
 * 光轨：模板 = 引擎代码（film.js + vendor 渲染器）+ template.json，内容 = scene.json。
 * 这里只做两件事：把词级时间戳推导成 scene，再把 scene 交给固定引擎渲染。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScene } from './scene.mjs'
import { renderLighttrail } from './render.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const template = JSON.parse(readFileSync(join(HERE, 'template.json'), 'utf8'))

export function build({ words, segments, plan, brief, captions }) {
  const scene = buildScene({ words, segments, plan, brief, tpl: template, cards: (captions && captions.cards) || [] })
  return { scene, engine: 'canvas' }
}

export function render(ctx) {
  return renderLighttrail(ctx)
}
