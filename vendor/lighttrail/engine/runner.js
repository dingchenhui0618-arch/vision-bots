// lighttrail · runner — drives a film module frame by frame inside headless Chrome and streams
// the result back to tools/render.mjs over plain HTTP (no CDP, no npm dependencies).
//
// URL query: film=<module url> & mode=frames|stills|cues|info & from & to & samples & stills=1,2,3
// A film module exports createFilm(ctx) → { frames, fps, prepare(f), prefetch(f), draw(c, t, f, tf), post(f), samples?(f), cues?() }
// Size defaults to 1920×1080; a film at another size calls setSize(w, h) from core.js before creating canvases.
import { W, H, loadFonts } from './core.js';
import { Post } from './post.js';
import { Media } from './media.js';
import { QA } from './devices.js';

const q = new URLSearchParams(location.search);
const send = (path, body, type = 'application/octet-stream') => fetch(path, { method: 'POST', body, headers: { 'content-type': type } });
const log = (...a) => send('/log', a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '), 'text/plain');
window.addEventListener('error', (e) => send('/error', String(e.error?.stack || e.message), 'text/plain'));
window.addEventListener('unhandledrejection', (e) => send('/error', String(e.reason?.stack || e.reason), 'text/plain'));

async function main() {
  await loadFonts('/fonts');
  const media = new Media({ maxEntries: 64 });
  const { createFilm } = await import(q.get('film'));
  const film = await createFilm({ media, query: q, log });
  const mode = q.get('mode') || 'frames';
  if (mode === 'frames' && q.get('size') && q.get('size') !== `${W}x${H}`) throw new Error(`film draws ${W}x${H} but the encoder expects ${q.get('size')}: pass --size ${W}x${H}`);
  if (mode === 'info') { await send('/info', JSON.stringify({ frames: film.frames, fps: film.fps }), 'application/json'); return; }
  if (mode === 'cues') { await send('/cues', JSON.stringify(film.cues ? film.cues() : []), 'application/json'); return; }
  if (mode === 'qa') {           // one draw per frame at the frame time; report every registered box + head boxes
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c2 = cv.getContext('2d');
    QA.on = true; let batch = [];
    const step = Math.max(1, Number(q.get('step') || 1)); // 采样步长：2052 帧不需要逐帧问盒子，盒子是按内容布局的
    for (let f = Number(q.get('from')); f <= Number(q.get('to')); f += step) {
      await film.prepare(f); film.prefetch?.(f + 1);
      c2.save(); film.draw(c2, f / film.fps, f, f / film.fps); c2.restore();
      batch.push(JSON.stringify({ f, ...film.qa(f) }));
      if (batch.length >= 60) { await send('/qa', batch.join('\n') + '\n', 'text/plain'); batch = []; }
    }
    if (batch.length) await send('/qa', batch.join('\n') + '\n', 'text/plain');
    await send('/done', 'ok', 'text/plain'); return;
  }

  const layer = document.createElement('canvas'); layer.width = W; layer.height = H;
  const ctx = layer.getContext('2d', { alpha: false, willReadFrequently: false });
  const out = document.getElementById('out'); out.width = W; out.height = H;
  const post = new Post(out);
  const S = Number(q.get('samples') || 8), shutter = Number(q.get('shutter') || 0.5);
  const list = mode === 'stills' ? q.get('stills').split(',').map(Number)
    : Array.from({ length: Number(q.get('to')) - Number(q.get('from')) + 1 }, (_, i) => Number(q.get('from')) + i);
  const t0 = performance.now();
  for (let n = 0; n < list.length; n++) {
    const f = list[n];
    await film.prepare(f);
    if (n + 1 < list.length) film.prefetch?.(list[n + 1]);
    if (n + 2 < list.length) film.prefetch?.(list[n + 2]);
    const s = Math.max(1, Math.round(S * (film.samples ? film.samples(f) : 1)));
    const tf = f / film.fps;
    post.begin();
    for (let k = 0; k < s; k++) {
      const t = (f + ((k + 0.5) / s) * shutter) / film.fps;
      ctx.save(); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
      film.draw(ctx, t, f, tf);
      ctx.restore();
      post.add(layer, 1 / s);
    }
    post.finish(film.post(f), f);
    if (mode === 'stills') {
      const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
      await send(`/still?f=${f}`, blob, 'image/png');
    } else {
      await send(`/frame?f=${f}`, post.pixels());
    }
    if (n % 30 === 0) log(`frame ${f} (${n + 1}/${list.length}) ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  }
  await send('/done', 'ok', 'text/plain');
}
main().catch((e) => send('/error', String(e?.stack || e), 'text/plain'));
