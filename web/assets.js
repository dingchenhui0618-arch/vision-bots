/* 资产层：名册 / 模板库 / 术语表。三个块都从 /api/assets 来，术语表是唯一可写的。
   存盘前界面上不做「看起来能过」的判断——真正拦人的是服务器上的形状校验和同音门，
   这里只负责把它的理由原样摆出来，指到具体是哪一格的哪一条。 */
const $ = s => document.querySelector(s)
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const KINDS = [['homophone', '同音字'], ['term', '专有名词'], ['number', '数字'], ['punct', '标点']]
const splitList = s => String(s || '').split(/[,，、;；\s]+/).map(x => x.trim()).filter(Boolean)

const state = { bots: [], templates: [], terms: null, rev: null, draft: null, dirty: false, trialTimer: null }

async function api(path, opts) {
  const r = await fetch(path, opts)
  const body = await r.json().catch(() => ({}))
  return { ok: r.ok, status: r.status, body }
}

function loadTerms(t) {
  state.terms = t
  state.rev = t.rev
  state.draft = {
    hotwords: [...(t.hotwords || [])],
    terms: (t.terms || []).map(x => {
      const o = { kind: x.kind || 'term', to: String(x.to || ''), from: (x.from || []).map(String) }
      if (x.next !== undefined) o.next = x.next
      if (x.onlyIfLowConfidence) o.onlyIfLowConfidence = true
      return o
    }),
  }
  setDirty(false)
}

function setState(msg, level) {
  const el = $('#saveState')
  el.className = 'save-state' + (level ? ' ' + level : '')
  el.textContent = msg || ''
}

function setDirty(v) {
  state.dirty = Boolean(v)
  $('#save').disabled = !state.dirty
  if (state.dirty) setState('有未保存的改动', 'dirty')
  else if ($('#saveState').classList.contains('dirty')) setState('')
}

function render() {
  renderStamp()
  renderBots()
  renderTemplates()
  renderHotwords()
  renderTerms()
}

function renderStamp() {
  const d = state.draft
  const ready = state.templates.filter(t => t.status === 'ready').length
  $('#stamp').textContent = state.bots.length + ' bot · ' + ready + '/' + state.templates.length + ' 模板就绪 · ' +
    d.hotwords.length + ' 热词 / ' + d.terms.length + ' 术语'
  $('#botsCount').textContent = state.bots.length + ' 人'
  $('#tplCount').textContent = ready + ' / ' + state.templates.length + ' ready'
  $('#termsPath').textContent = 'config/terms.json'
}

function renderBots() {
  $('#bots').innerHTML = state.bots.map(b => {
    const kv = [
      ['模型', b.model],
      ['工具', (b.tools || []).join(' · ')],
      ['产物', (b.outputs || []).join(' · ')],
      ['不接', (b.refuses || []).join(' · ')],
    ].filter(x => x[1]).map(([k, v]) =>
      '<div class="kv"><i>' + esc(k) + '</i><b' + (k === '模型' ? ' class="mono"' : '') + '>' + esc(v) + '</b></div>').join('')
    return '<div class="bot">' +
      '<div class="bot-mark">' + esc(b.mark) + '</div>' +
      '<div>' +
        '<div class="bot-name"><b>' + esc(b.name) + '</b><span class="mono">' + esc(b.id) + '</span>' +
          '<span class="off">' + String(b.order).padStart(2, '0') + '</span></div>' +
        '<div class="bot-role">' + esc(b.role) + '</div>' +
        (b.voice ? '<div class="bot-voice">' + esc(b.voice) + '</div>' : '') +
      '</div>' +
      '<div class="bot-meta">' + kv + '</div>' +
    '</div>'
  }).join('')
}

function renderTemplates() {
  $('#tpls').innerHTML = state.templates.map(t => {
    const r = t.ratios || []
    const first = r[0]
    const rest = r.slice(1)
    const dur = (t.duration && t.duration.length === 2) ? t.duration[0] + '–' + t.duration[1] + 's' : '—'
    const built = t.built === null
      ? 'roster 自带规格，没有 template.json'
      : (t.built.error ? t.built.error : 'template.json · 布局 ' + (t.built.layouts || []).join(' / ') +
        (t.built.palette ? ' · 配色 ' + t.built.palette.length + ' 个' : ''))
    const kv = [
      ['画幅', first ? first.ratio + ' · ' + first.width + '×' + first.height : '—'],
      ['还做', rest.length ? rest.map(x => x.ratio + ' · ' + x.width + '×' + x.height).join('　') : '—'],
      ['时长', dur],
      ['帧率', (t.fps || 30) + 'fps'],
      ['引擎', t.engine],
    ].map(([k, v]) => '<div class="kv"><i>' + esc(k) + '</i><b' + (k === '画幅' || k === '还做' ? '' : ' class="mono"') + '>' + esc(v) + '</b></div>').join('')
    return '<div class="tpl">' +
      '<div>' +
        '<div class="tpl-name"><b>' + esc(t.name) + '</b><span class="mono">' + esc(t.id) + '</span>' +
          '<span class="pill ' + esc(t.status) + '">' + esc(t.status) + '</span></div>' +
        '<div class="tpl-note">' + esc(t.note || '') + '</div>' +
        '<div class="tpl-built">' + esc(built) + '</div>' +
      '</div>' +
      '<div class="tpl-spec">' + kv + '</div>' +
    '</div>'
  }).join('')
}

function renderHotwords() {
  $('#hotwords').innerHTML = state.draft.hotwords.map((w, i) =>
    '<span class="hw">' + esc(w) + '<button data-hw="' + i + '" title="删掉">×</button></span>').join('')
}

function renderTerms() {
  const head = '<div class="tr th"><span>类型</span><span>写成（ASR 的错）</span><span>后接</span><span>改成（正确形态）</span><span>只改低置信</span><span></span></div>'
  const rows = state.draft.terms.map((t, i) => {
    const opts = KINDS.map(([v, label]) => '<option value="' + v + '"' + ((t.kind || 'term') === v ? ' selected' : '') + '>' + label + '</option>').join('')
    const next = [].concat(t.next === undefined ? [] : t.next).join('，')
    return '<div class="tr">' +
      '<select data-i="' + i + '" data-k="kind">' + opts + '</select>' +
      '<input type="text" data-i="' + i + '" data-k="from" value="' + esc((t.from || []).join('，')) + '" spellcheck="false">' +
      '<input type="text" data-i="' + i + '" data-k="next" value="' + esc(next) + '" placeholder="—" spellcheck="false">' +
      '<input type="text" data-i="' + i + '" data-k="to" value="' + esc(t.to || '') + '" spellcheck="false">' +
      '<label class="tick"><input type="checkbox" data-i="' + i + '" data-k="low"' + (t.onlyIfLowConfidence ? ' checked' : '') + '></label>' +
      '<button class="del" data-del="' + i + '" title="删掉这条">×</button>' +
    '</div>'
  }).join('')
  $('#terms').innerHTML = head + rows
  $('#termsHint').textContent = state.draft.terms.length
    ? '「写成」和「后接」里多个词用逗号分开；「后接」用来修被 ASR 拆成两个词的错（如「化」+「走」）'
    : '还没有术语。加一条：写成「画走」改成「划走」，类型同音字。'
}

function showIssues(list) {
  const box = $('#issues')
  if (!list || !list.length) { box.innerHTML = ''; return }
  box.innerHTML = list.map(x =>
    '<div class="issue ' + (x.level || 'warn') + '"><span class="at">' + esc(x.at || '提醒') + '</span><span class="why">' + esc(x.why) + '</span></div>').join('')
}

// ── 编辑 ──
$('#terms').addEventListener('input', e => {
  const el = e.target.closest('[data-i]')
  if (!el) return
  const i = Number(el.dataset.i)
  const t = state.draft.terms[i]
  if (!t) return
  const k = el.dataset.k
  if (k === 'kind') t.kind = el.value
  else if (k === 'from') t.from = splitList(el.value)
  else if (k === 'next') {
    const a = splitList(el.value)
    if (!a.length) delete t.next
    else t.next = a.length === 1 ? a[0] : a
  } else if (k === 'to') t.to = el.value
  else if (k === 'low') {
    if (el.checked) t.onlyIfLowConfidence = true
    else delete t.onlyIfLowConfidence
  }
  setDirty(true)
  showIssues([])
})

$('#terms').addEventListener('click', e => {
  const b = e.target.closest('[data-del]')
  if (!b) return
  state.draft.terms.splice(Number(b.dataset.del), 1)
  setDirty(true)
  renderTerms()
  showIssues([])
})

$('#hotwords').addEventListener('click', e => {
  const b = e.target.closest('[data-hw]')
  if (!b) return
  state.draft.hotwords.splice(Number(b.dataset.hw), 1)
  setDirty(true)
  renderHotwords()
  renderStamp()
})

$('#hwNew').addEventListener('keydown', e => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  const v = e.target.value.trim()
  if (!v) return
  if (state.draft.hotwords.includes(v)) { setState('「' + v + '」已经在表里了', 'bad'); return }
  state.draft.hotwords.push(v)
  e.target.value = ''
  setDirty(true)
  renderHotwords()
  renderStamp()
})

$('#addTerm').onclick = () => {
  state.draft.terms.push({ kind: 'homophone', to: '', from: [], onlyIfLowConfidence: true })
  setDirty(true)
  renderTerms()
  showIssues([])
  const inputs = document.querySelectorAll('#terms .tr:not(.th) input[data-k="from"]')
  if (inputs.length) inputs[inputs.length - 1].focus()
}

// ── 存盘 ──
$('#save').onclick = async () => {
  const btn = $('#save')
  btn.disabled = true
  setState('正在存…')
  const r = await api('/api/assets/terms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rev: state.rev, hotwords: state.draft.hotwords, terms: state.draft.terms }),
  })
  const b = r.body || {}
  if (!r.ok) {
    const issues = (b.errors || []).map(x => ({ at: x.at, why: x.why, level: 'bad' }))
      .concat((b.warnings || []).map(w => ({ at: '提醒', why: w, level: 'warn' })))
    if (b.error) issues.unshift({ at: r.status === 409 ? '冲突' : '没存上', why: b.error, level: 'bad' })
    showIssues(issues)
    setState(b.error || (b.stage === 'homophone' ? '同音门拦住了' : '有字段不合格'), 'bad')
    btn.disabled = !state.dirty
    return
  }
  loadTerms(b.terms)
  render()
  const tail = b.pinyinMode === 'off' ? '（本机没有拼音校验，同音门没跑）' : '同音门 ' + (b.checked || 0) + ' 条全过'
  setState('已保存 · ' + tail)
  showIssues((b.warnings || []).map(w => ({ at: '提醒', why: w, level: 'warn' })))
  runTrial()
}

// ── 试验台 ──
function renderTrial(b) {
  const out = $('#trialOut')
  if (!b || b.ok === false) { out.innerHTML = ''; return }
  const spans = (b.spans || []).slice().sort((x, y) => x.at - y.at)
  let html = ''
  let cur = 0
  for (const s of spans) {
    if (s.at < cur) continue
    html += esc(b.out.slice(cur, s.at))
    html += '<mark class="hit" title="' + esc(s.from + ' → ' + s.to) + '">' + esc(b.out.slice(s.at, s.at + s.len)) + '</mark>'
    cur = s.at + s.len
  }
  html += esc(b.out.slice(cur))
  const hits = (b.hits || []).map(h => h.from + '→' + h.to + '　' + h.at.toFixed(2) + 's　' + (h.verified || ''))
  const skipped = (b.skipped || []).map(s => s.from + '→' + s.to + '　' + s.why)
  const line = (k, v, bad) => v ? '<div class="trial-line' + (bad ? ' bad' : '') + '"><span class="k">' + k + '</span><span class="v">' + esc(v) + '</span></div>' : ''
  const missed = b.missed || []
  out.innerHTML = '<p class="trial-say">' + (b.changed ? html : '<span class="same">' + esc(b.out) + '</span>') + '</p>' +
    line('词位', b.words + ' 个（置信度按 0.5 算）') +
    line('命中', hits.length ? hits.length + ' 处 · ' + hits.join('；　') : '一条都没命中') +
    line('跳过', skipped.length ? skipped.length + ' 处 · ' + skipped.join('；　') : '', skipped.length > 0) +
    line('字面', (() => {
      const lit = b.literal || []
      if (!lit.length) return '0 处'
      const at = [...new Set(lit.map(x => x.at))]
      return at.length + ' 处' + (lit.length > at.length ? '（' + lit.length + ' 条规则都指向这里）' : '')
    })()) +
    (missed.length ? line('注意', missed.map(m => '「' + m.from + '」在原文里有，但分词把它切开了，按词切没走到；转写时 whisper 如果把它当一个词就会改').join('；'), true) : '') +
    (!b.changed && !missed.length ? line('说明', '要么这张表没覆盖这句话，要么原句本来就没写错') : '')
}

async function runTrial() {
  const text = $('#trialIn').value
  const r = await api('/api/assets/terms/trial', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: text, terms: state.draft.terms }),
  })
  renderTrial(r.body)
}

$('#trialGo').onclick = runTrial
$('#trialIn').addEventListener('input', () => {
  clearTimeout(state.trialTimer)
  state.trialTimer = setTimeout(runTrial, 400)
})

async function boot() {
  const r = await api('/api/assets')
  if (!r.ok) { setState('读不到资产：' + (r.body && r.body.error || r.status), 'bad'); return }
  state.bots = r.body.bots || []
  state.templates = r.body.templates || []
  loadTerms(r.body.terms)
  render()
  if (r.body.terms.warnings && r.body.terms.warnings.length) {
    showIssues(r.body.terms.warnings.map(w => ({ at: '提醒', why: w, level: 'warn' })))
  }
  runTrial()
}

boot()
