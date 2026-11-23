/**
 * bot 的一轮：模型 ⇄ 工具，直到它说出一句有出处的话。
 *
 * 三条硬规矩（这不是提示词，是代码）：
 *   1. 干活只能通过工具。工具是确定性代码，模型只能选工具、传参。
 *   2. 说出来的每个数字必须能在这一轮的事实表里找到出处，找不到重写一次，
 *      还编就把数字标出来交出去——不许静默放过。
 *   3. 步数有上限。模型绕圈就停，把已经干到的结果如实报出来。
 *
 * chatFn 可注入：离线自测不需要网络。
 */
import { chat as realChat } from '../llm.mjs'
import { FactBook } from './facts.mjs'

const MAX_STEPS = 8
const MAX_REPAIRS = 1

/** 从会话历史里还原成对话消息：只回放「他说过的话」和「用户说过的话」 */
function replay(entries) {
  const out = []
  for (const e of entries) {
    if (!e || !e.content) continue
    if (e.kind === 'user') out.push({ role: 'user', content: String(e.content) })
    else if (e.kind === 'say') out.push({ role: 'assistant', content: String(e.content) })
  }
  return out
}

/** bot 的人设 + 这个项目的现状 + 它自己记得的事 */
export function buildSystem(bot, { notes = [], context = '' } = {}) {
  const lines = [
    '你是「' + bot.name + '」' + (bot.mark || '') + '，这个项目群里的一号' + bot.name + '。',
    '职责：' + bot.role,
    '说话：' + bot.voice,
  ]
  if (bot.refuses && bot.refuses.length) lines.push('不干：' + bot.refuses.join('、'))
  if (bot.contract && bot.contract.length) { lines.push('', '红线：'); for (const c of bot.contract) lines.push('· ' + c) }
  lines.push(
    '',
    '规矩：',
    '· 干活只能调工具，你自己没有手。',
    '· 话里每个数字都必须来自工具返回，不许自己算、不许估、不许写「大约」。',
    '· 结论先行，短句，不寒暄，不夸人。',
    '· 做不到就说做不到，差多少说多少。',
    '· 群聊是口语，不是报告：不许用 Markdown（**加粗**、# 标题、- 或 1. 列表、`代码`），不许贴字段名、JSON、变量名。',
    '· 不许说「工具」「接口」「字段」「返回」「参数」「phase」「confirm」这类内部词。用户只关心片子。',
    '· 数字最多一位小数：说 17.1s，不说 17.099999。',
    '· 一条不超过四句。说清了就停，不要复述自己刚干了什么。',
  )
  if (context) lines.push('', '项目现状：', context)
  if (notes && notes.length) {
    lines.push('', '你记得的事：')
    for (const n of notes) lines.push('· ' + n.key + '：' + n.text)
  }
  return lines.join('\n')
}

export async function runAgent({
  session,
  bot,
  task,
  tools = [],
  facts = null,
  context = '',
  log = () => {},
  chatFn = realChat,
  maxSteps = MAX_STEPS,
  maxRepairs = MAX_REPAIRS,
  maxTokens = 700,
  timeoutMs = undefined,
} = {}) {
  const book = facts || new FactBook(bot.id)
  const schemas = tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }))
  const byName = new Map(tools.map(t => [t.name, t]))

  const messages = [
    { role: 'system', content: buildSystem(bot, { notes: session.notes, context }) },
    ...replay(session.tail(24)),
    { role: 'user', content: String(task) },
  ]
  session.push({ role: 'user', kind: 'user', content: String(task) })

  const t0 = Date.now()
  const used = []
  const toolResults = []
  let repairs = 0
  let lastText = ''
  let lastCheck = null

  for (let step = 0; step < maxSteps; step++) {
    const r = await chatFn({ messages, tools: schemas, maxTokens, ...(timeoutMs ? { timeoutMs } : {}) })
    if (!r.ok) {
      return { ok: false, skipped: r.skipped, detail: r.detail || null, ms: Date.now() - t0, stepsUsed: step, used, toolResults, facts: book }
    }

    // 一步里可能同时给多个工具调用
    if (r.toolCalls && r.toolCalls.length) {
      messages.push({ role: 'assistant', content: r.content || '', tool_calls: r.toolCalls })
      for (const tc of r.toolCalls) {
        const name = tc.function?.name
        const tool = byName.get(name)
        let args = {}
        try { args = JSON.parse(tc.function?.arguments || '{}') } catch { args = {} }
        if (!tool) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ error: '没有这个工具：' + name }) })
          continue
        }
        log(tool.label || name, { tool: name, transient: true })
        let result
        const t1 = Date.now()
        try {
          result = await tool.run(args)
        } catch (err) {
          result = { error: err && err.message ? err.message : String(err), hint: '工具抛错了。把错误原文说给派活的人，不要自己编原因。' }
        }
        const ms = Date.now() - t1
        used.push({ name, args, ms, ok: !result || !result.error })
        toolResults.push({ name, args, ms, result })
        // 事实表吃工具返回的一切数字（全精度，校验时用）
        book.addAll(result, name)
        // 但模型只该看见说话要用的摘要：全精度中间值（7.893333）它一复述就难看
        const forModel = result && typeof result === 'object' && result.narrative ? result.narrative : result
        const payload = typeof forModel === 'string' ? forModel : JSON.stringify(forModel)
        messages.push({ role: 'tool', tool_call_id: tc.id, content: payload.length > 1800 ? payload.slice(0, 1800) + '…' : payload })
      }
      continue
    }

    // 没有工具调用：这是它要说的话
    const text = String(r.content || '').trim()
    if (!text) break
    const check = book.check(text)
    lastText = text
    lastCheck = check
    if (check.ok) {
      session.push({ role: 'assistant', kind: 'say', content: text, tools: used.map(u => u.name), check: { ok: true } })
      return { ok: true, text, ms: Date.now() - t0, stepsUsed: step + 1, used, toolResults, facts: book, check }
    }
    // 编了数字：还一次重写机会
    if (repairs < maxRepairs) {
      repairs++
      log('这句话里有编的数，让它重写：' + check.bad.map(b => b.raw).join('、'), { transient: true })
      messages.push({ role: 'assistant', content: text })
      messages.push({ role: 'user', content: book.hint(check.bad) })
      continue
    }
    // 还是不老实：如实交出去，把没出处的数字标出来
    const flagged = text + '\n（这句里有没出处的数：' + check.bad.map(b => b.raw).join('、') + '，我核对不上，别当准数用）'
    session.push({ role: 'assistant', kind: 'say', content: flagged, tools: used.map(u => u.name), check: { ok: false, bad: check.bad } })
    return { ok: false, skipped: 'unverified-numbers', text: flagged, ms: Date.now() - t0, stepsUsed: step + 1, used, toolResults, facts: book, check }
  }

  // 步数用尽
  const text = lastText || '这轮我没跑出结论（工具调到上限）。'
  session.push({ role: 'assistant', kind: 'say', content: text, tools: used.map(u => u.name), check: lastCheck })
  return { ok: Boolean(lastText), skipped: lastText ? undefined : 'step-limit', text, ms: Date.now() - t0, stepsUsed: maxSteps, used, toolResults, facts: book, check: lastCheck }
}
