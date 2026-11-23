const $ = s => document.querySelector(s)
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const PHASE = { intake: '接需求', confirm: '待确认', cutting: '剪辑', packing: '包装', qc: '质检', delivering: '交付中', delivered: '已交付', blocked: '卡住' }
const MARKS = { producer: '◆', cutter: '▍', packer: '▤', qc: '◻' }
const time = ts => new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

const state = { groups: [], id: null, group: null, panel: null, tab: 'video', es: null, pending: [] }

async function api(path, opts) {
  const r = await fetch(path, opts)
  return r.json()
}

// 素材：拖拽或选择，先上传进项目，跟着下一句话一起发
function renderPending() {
  const box = $('#pending')
  if (!state.pending.length) { box.innerHTML = ''; return }
  box.innerHTML = state.pending.map((p, i) =>
    '<span class="chip"><b>' + esc(p.name) + '</b>' + Math.round(p.size / 1024) + 'KB<button data-drop="' + i + '">×</button></span>').join('')
}

async function upload(file) {
  if (!state.id) return
  const r = await fetch('/api/groups/' + state.id + '/assets?name=' + encodeURIComponent(file.name), { method: 'POST', body: file })
  const j = await r.json()
  if (!j.ok) { alert(j.error || '上传失败'); return }
  state.pending.push({ path: j.path, name: j.name, size: j.size })
  renderPending()
}

$('#pick').onclick = () => $('#file').click()
$('#file').onchange = async e => { for (const f of e.target.files) await upload(f); e.target.value = '' }
document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragging') })
document.addEventListener('dragleave', e => { if (e.relatedTarget === null) document.body.classList.remove('dragging') })
document.addEventListener('drop', async e => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  for (const f of e.dataTransfer.files) await upload(f)
})
document.addEventListener('click', e => {
  const b = e.target.closest('[data-drop]')
  if (!b) return
  state.pending.splice(Number(b.dataset.drop), 1)
  renderPending()
})

async function boot() {
  state.groups = await api('/api/groups')
  if (state.groups.length) await open(state.groups[0].id)
  else renderAll()
}

async function open(id) {
  state.id = id
  state.group = await api('/api/groups/' + id)
  state.panel = await api('/api/groups/' + id + '/panel')
  renderAll()
  subscribe(id)
}

function subscribe(id) {
  if (state.es) state.es.close()
  const es = new EventSource('/api/groups/' + id + '/stream')
  es.onmessage = async ev => {
    const e = JSON.parse(ev.data)
    if (state.id !== id) return
    state.group.events.push(e)
    if (e.type === 'artifact' || e.type === 'deliver' || e.type === 'phase' || e.type === 'job') {
      state.panel = await api('/api/groups/' + id + '/panel')
      state.group.meta.phase = (state.group.meta.phase || '')
      renderPanel()
    }
    renderStream()
    renderHead()
  }
  state.es = es
}

function renderAll() { renderRail(); renderHead(); renderStream(); renderPanel() }

function renderRail() {
  $('#groups').innerHTML = state.groups.map(g =>
    '<button class="group' + (g.id === state.id ? ' active' : '') + '" data-id="' + esc(g.id) + '">' +
      '<span class="name">' + esc(g.name) + '</span>' +
      '<span class="meta">' + esc(PHASE[g.phase] || g.phase) + ' · ' + esc(g.id.slice(0, 12)) + '</span>' +
    '</button>').join('') || '<div class="empty">还没有项目</div>'
  document.querySelectorAll('.group').forEach(b => b.onclick = () => open(b.dataset.id))
}

function renderHead() {
  const g = state.group
  if (!g) return
  $('#groupName').textContent = g.meta.name
  $('#phase').textContent = PHASE[g.meta.phase] || g.meta.phase
  $('#roster').innerHTML = g.bots.map(b => '<span class="bot-chip"><i>' + MARKS[b.id] + '</i>' + esc(b.name) + '</span>').join('')
}

function renderStream() {
  const g = state.group
  const el = $('#stream')
  if (!g) { el.innerHTML = ''; return }
  const parts = ['<div class="stream-inner">']
  for (const e of g.events) parts.push(renderEvent(e))
  parts.push('</div>')
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  el.innerHTML = parts.join('')
  if (atBottom && location.hash !== '#top') el.scrollTop = el.scrollHeight
}

function renderEvent(e) {
  if (e.type === 'user') {
    const files = (e.assets || []).map(a => '<span class="attach">' + esc(a.split(/[\\/]/).pop()) + '</span>').join(' ')
    return '<div class="msg user"><div class="who"><span class="name">你</span><span class="time">' + time(e.ts) + '</span></div>' +
      (files ? '<div>' + files + '</div>' : '') + '<p>' + esc(e.text) + '</p></div>'
  }
  if (e.type === 'bot') {
    return '<div class="msg"><div class="who"><span class="mark">' + (MARKS[e.bot] || '·') + '</span><span class="name">' + esc(e.name) + '</span><span class="time">' + time(e.ts) + '</span></div><p>' + esc(e.text) + '</p></div>'
  }
  if (e.type === 'card') {
    const rows = e.card.fields.map(f => '<div class="card-row"><div class="k">' + esc(f.label) + '</div><div class="v">' + esc(f.value) + '</div></div>').join('')
    const why = e.card.why ? '<div class="card-why"><span class="k">模板理由</span><span class="v">' + esc(e.card.why) + '</span></div>' : ''
    const done = state.group.meta.phase !== 'confirm'
    const actions = done
      ? '<div class="card-done">已按这张卡开工</div>'
      : '<button class="btn-ghost">先去改改</button><button class="btn-primary" data-confirm="1">开始</button>'
    return '<div class="card"><div class="card-head"><b>' + esc(e.card.title) + '</b><span>' + esc(e.card.subtitle || '') + '</span></div>' +
      '<div class="card-rows">' + rows + '</div>' + why + '<div class="card-actions">' + actions + '</div></div>'
  }
  // 系统提示：状态机说的话。bot 的发言必须来自模型，这类消息不挂 bot 头像
  if (e.type === 'note') {
    return '<div class="line"><span class="st">·</span><span>' + esc(e.text) + '</span></div>'
  }
  // 临时状态（「在读需求」这类）：同一个 bot 后面已经说话了就收起来，别留在时间线里
  if (e.type === 'progress') {
    if (e.transient && (state.group ? state.group.events : []).some(x => x.type === 'bot' && x.bot === e.bot && x.ts > e.ts)) return ''
    return '<div class="line' + (e.transient ? ' waiting' : '') + '"><span class="st">' + (MARKS[e.bot] || '·') + '</span><span>' + esc(e.text) + '</span></div>'
  }
  if (e.type === 'job') {
    const st = e.job.status === 'failed' ? 'paused' : e.job.status
    if (e.job.status === 'running') return '<div class="line"><span class="st">▸</span><span>' + esc(e.job.title) + '</span></div>'
    if (e.job.status === 'failed') return '<div class="line"><span class="st bad">×</span><span class="bad">' + esc(e.job.title) + '：' + esc(e.job.error || '') + '</span></div>'
    return ''
  }
  if (e.type === 'deliver') {
    const rows = e.items.map(i => '<div class="deliver-row"><span class="k">' + esc(i.label) + '</span><span class="v">' + esc(i.file.split(/[\\/]/).pop()) + '</span></div>').join('')
    return '<div class="deliver"><div class="deliver-head">交付 · ' + e.items.length + ' 件</div>' + rows + '</div>'
  }
  return ''
}

/** 场记条：保留段按源时长等比排开，被剪掉的气口留成空档。 */
function takeStrip(t) {
  const total = t.keep.reduce((s, r) => s + (r[1] - r[0]), 0) + (t.cutSeconds || 0)
  if (!total) return ''
  const parts = []
  t.keep.forEach((r, i) => {
    if (i > 0) {
      const gap = r[0] - t.keep[i - 1][1]
      if (gap > 0) parts.push('<span class="take-gap" style="flex:' + (gap / total) + '"></span>')
    }
    parts.push('<span class="take-seg" style="flex:' + ((r[1] - r[0]) / total) + '"></span>')
  })
  return '<div class="take"><div class="take-head"><b>场记</b><span>' + t.removedPauses + ' 个气口 / ' + t.cutSeconds.toFixed(1) + 's</span></div>' +
    '<div class="take-bar">' + parts.join('') + '</div>' +
    '<div class="take-legend"><span>实线 保留</span><span>虚槽 剪掉</span></div></div>'
}

function renderPanel() {
  const p = state.panel
  const body = $('#panelBody')
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === state.tab))
  if (!p) { body.innerHTML = '<div class="empty">没有数据</div>'; return }
  if (state.tab === 'video') {
    if (!p.video) { body.innerHTML = '<div class="empty">还没出片</div>'; return }
    const stats = p.timeline ? '<div class="stats">' +
      '<div class="stat"><b>' + p.timeline.outDuration.toFixed(1) + 's</b><span>成片时长</span></div>' +
      '<div class="stat"><b>' + p.timeline.segments + '</b><span>保留段数</span></div>' +
      '<div class="stat"><b>' + p.timeline.cutSeconds.toFixed(1) + 's</b><span>剪掉</span></div></div>' + takeStrip(p.timeline) : ''
    body.innerHTML = '<div class="video-wrap" id="vwrap"><video controls playsinline ' + (p.preview ? 'poster="' + p.preview + '" ' : '') + 'src="' + p.video + '"></video></div>' + stats
    const v = body.querySelector('video')
    v.onloadedmetadata = () => { if (v.videoWidth) $('#vwrap').style.aspectRatio = v.videoWidth + ' / ' + v.videoHeight }
  } else if (state.tab === 'subs') {
    if (!p.subs.length) { body.innerHTML = '<div class="empty">还没有字幕</div>'; return }
    body.innerHTML = '<div class="sec">' + p.subs.length + ' 张 · 逐字对齐</div>' + p.subs.map(c =>
      '<div class="row"><span class="t">' + c.start.toFixed(1) + 's</span><span class="txt">' + esc(c.text) + '</span></div>').join('')
  } else if (state.tab === 'report') {
    if (!p.report) { body.innerHTML = '<div class="empty">还没质检</div>'; return }
    body.innerHTML = '<div class="sec">' + (p.report.passed ? '全部通过' : p.report.checks.filter(c => !c.ok).length + ' 项未通过') + ' · ' + p.report.checks.length + ' 项检查</div>' +
      p.report.checks.map(c => '<div class="row"><span class="' + (c.ok ? 'mark-ok' : 'mark-bad') + '"></span><span class="txt' + (c.ok ? '' : ' bad') + '">' + esc(c.detail) + '</span></div>').join('')
  } else {
    if (!p.timeline) { body.innerHTML = '<div class="empty">还没有时间线</div>'; return }
    body.innerHTML = '<div class="sec">' + p.timeline.segments + ' 段保留 · 剪掉 ' + p.timeline.removedPauses + ' 个停顿</div>' +
      p.timeline.keep.map((r, i) => '<div class="row"><span class="t">' + String(i + 1).padStart(2, '0') + '</span><span class="txt" style="font-family:var(--mono);font-size:12px">' + r[0].toFixed(2) + ' → ' + r[1].toFixed(2) + '　' + (r[1] - r[0]).toFixed(2) + 's</span></div>').join('')
  }
}

document.addEventListener('click', async e => {
  const btn = e.target.closest('[data-confirm]')
  if (!btn) return
  btn.disabled = true
  btn.textContent = '开工中'
  await api('/api/groups/' + state.id + '/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
})

document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; renderPanel() })

async function send() {
  const input = $('#input')
  const text = input.value.trim()
  const assets = state.pending.map(p => p.path)
  if ((!text && !assets.length) || !state.id) return
  input.value = ''
  state.pending = []
  renderPending()
  const r = await api('/api/groups/' + state.id + '/say', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text, assets: assets }) })
  if (!r.ok) alert(r.error)
  state.group = await api('/api/groups/' + state.id)
  renderAll()
}

$('#send').onclick = send
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
})
$('#newGroup').onclick = async () => {
  const name = prompt('项目名')
  if (!name) return
  const r = await api('/api/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
  state.groups = await api('/api/groups')
  await open(r.id)
}

boot()