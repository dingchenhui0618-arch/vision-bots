/**
 * 提案缓存：模型不保证可复现，产品就得自己保证。
 *
 * 为什么需要它（自测 19–21 量出来的）：同一份输入、同一个提示词，连问两次模型两次，
 * 分镜、图形块、强调词没有一次完全一样；把温度钉到 0 也一样不一样——
 * 温度只决定「怎么采」，决定不了后端批处理、路由落点带来的抖动。
 * 所以「同一素材、同一需求、出同一版片子」这件事**不能靠模型**，只能靠「问过一次就记住」。
 *
 * 判据是输入指纹：提示词全文 + 模型名 + 温度 + maxTokens + 输出形态。全都一样才算同一个问题。
 *   · 命中就交回上次那份，不再问模型（改一句重跑时，没动的地方不会重新洗牌）；
 *   · 换了模型（比如接 Opus）指纹就变了，自动重问一次，然后重新记住；
 *   · 提示词改一个字也指纹变化——改了规则不会被旧答案钉住。
 *
 * 落盘在 groups/<id>/proposals/，跟着群走。groups/ 已在 .gitignore 里，不进仓库。
 * 想强制重问：删掉那个目录，或设 VISION_BOTS_PROPOSAL_CACHE=0 关掉这一层。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const CACHE_VERSION = 'p1'

/** 输入指纹：同一个问题才可能命中；任何一个字段变了都是新问题。 */
export function proposalKey({ prompt = '', system = '', messages = null, model = '', temperature = null, maxTokens = null, kind = 'json' } = {}) {
  const body = JSON.stringify({
    v: CACHE_VERSION,
    kind,
    model: String(model || ''),
    temperature: temperature === null || temperature === undefined ? 'default' : temperature,
    maxTokens: maxTokens === null || maxTokens === undefined ? null : maxTokens,
    system: String(system || ''),
    // messages 是给多轮会话用的；这里只认「一次性问完」的 prompt
    messages: Array.isArray(messages) ? messages : null,
    prompt: String(prompt || ''),
  })
  return createHash('sha1').update(body).digest('hex').slice(0, 20)
}

const OFF = String(process.env.VISION_BOTS_PROPOSAL_CACHE || '') === '0'
export const cacheEnabled = () => !OFF

/** 读一份命中的提案；坏文件当没命中（缓存坏了不该让片子停住）。 */
export function cacheRead(dir, key) {
  if (OFF || !dir || !key) return null
  const p = join(dir, key + '.json')
  if (!existsSync(p)) return null
  try {
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
    if (!j || j.v !== CACHE_VERSION) return null
    return j
  } catch { return null }
}

/** 写一份提案：先写临时文件再改名，写一半断电也不会留下半份 JSON。 */
export function cacheWrite(dir, key, payload) {
  if (OFF || !dir || !key) return null
  try {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, key + '.json')
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, key, at: new Date().toISOString(), ...payload }, null, 1), 'utf8')
    renameSync(tmp, p)
    return p
  } catch { return null }
}
