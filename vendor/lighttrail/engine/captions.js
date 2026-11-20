// lighttrail · captions — one natural clause per card on a single opaque rounded plate.
// The whole clause is present from the first frame; a 56 px feathered mask sweeps unread → read
// in step with the real syllable timings, and the wipe front carries a thin signal-orange light:
// the caption is lit by the same light trail as the rest of the film.
import { W, H, C, F, rgba, font, clamp, E, seg } from './core.js';

export const CAPTION_STYLE = {
  size: 46, weight: 500, family: F.sans, plate: C.void, unread: '#9A978F', read: C.bone, edge: 'signal',
  padX: 40, padTop: 16, padBottom: 18, radius: 8, bottom: 60, maxWidth: 1500, feather: 56,
  enter: 0.16, rise: 8, exit: 0.12,
};

const work = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1600, 120) : null;
const wctx = work ? work.getContext('2d') : null;

// Layout: per-character x extents measured with the real font (letter-spacing aware).
function layout(c, cap, st) {
  if (cap._lay) return cap._lay;
  c.save(); c.font = font(st.size, st.family, st.weight);
  const text = cap.text; const widths = []; let x = 0;
  for (const ch of text) { const w = c.measureText(ch).width; widths.push([x, x + w]); x += w; }
  c.restore();
  // map display characters to timed characters (display text has no punctuation; spaces untimed)
  const timed = cap.chars.filter((k) => !/\s/.test(k.ch));
  const map = []; let j = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { map.push(null); continue; }
    while (j < timed.length && timed[j].ch !== ch && !(/[0-9.]/.test(ch) && /[0-9.]/.test(timed[j].ch))) j++;
    map.push(j < timed.length ? timed[j] : null); if (j < timed.length) j++;
  }
  // hand-edited text whose characters no longer match the timing: sweep evenly across the card
  const matched = map.filter(Boolean).length, needed = [...text].filter((ch) => !/\s/.test(ch)).length;
  if (needed && matched < needed * 0.6) {
    const span = Math.max(0.2, cap.f1 - cap.f0 - 0.15); let k = 0;
    for (let i = 0; i < map.length; i++) { if (/\s/.test(text[i])) { map[i] = null; continue; } map[i] = { ch: text[i], f0: cap.f0 + span * (k / needed), f1: cap.f0 + span * ((k + 1) / needed) }; k++; }
  }
  cap._lay = { width: x, widths, map };
  return cap._lay;
}

// x of the reading front at time t (holds during pauses, never moves back)
function front(lay, t) {
  let xf = 0;
  for (let i = 0; i < lay.map.length; i++) {
    const k = lay.map[i]; const [x0, x1] = lay.widths[i];
    if (!k) { if (xf >= x0 - 0.5) xf = x1; continue; }
    if (t >= k.f1) xf = x1;
    else if (t >= k.f0) { xf = x0 + (x1 - x0) * clamp((t - k.f0) / Math.max(0.04, k.f1 - k.f0)); break; }
    else break;
  }
  return xf;
}

export function drawCaption(c, cap, t, st = CAPTION_STYLE, { y = null, alpha = 1 } = {}) {
  if (!cap || t < cap.f0 || t > cap.f1 + st.exit) return;
  const lay = layout(c, cap, st);
  const a = alpha * E.outCubic(seg(t, cap.f0, cap.f0 + st.enter)) * (1 - seg(t, cap.f1, cap.f1 + st.exit));
  if (a <= 0.001) return;
  const rise = (1 - E.outCubic(seg(t, cap.f0, cap.f0 + st.enter))) * st.rise;
  const tw = Math.min(lay.width, st.maxWidth);
  const pw = tw + st.padX * 2, ph = st.size * 1.18 + st.padTop + st.padBottom;
  const px = (W - pw) / 2, py = (y ?? H - st.bottom - ph) + rise;
  const tx = px + st.padX, base = py + st.padTop + st.size * 0.94;
  c.save(); c.globalAlpha *= a;
  c.fillStyle = st.plate; c.beginPath(); c.roundRect(px, py, pw, ph, st.radius); c.fill();
  // unread layer
  c.font = font(st.size, st.family, st.weight); c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  c.fillStyle = st.unread; c.fillText(cap.text, tx, base);
  const xf = front(lay, t);
  if (xf > 0 && wctx) {
    const wW = Math.ceil(lay.width) + 8, wH = Math.ceil(st.size * 1.6);
    if (work.width < wW) work.width = wW; if (work.height < wH) work.height = wH;
    // read layer: text in read colour, masked by a feathered ramp ending at the front
    wctx.setTransform(1, 0, 0, 1, 0, 0); wctx.clearRect(0, 0, work.width, work.height);
    wctx.globalCompositeOperation = 'source-over';
    wctx.font = font(st.size, st.family, st.weight); wctx.textBaseline = 'alphabetic'; wctx.textAlign = 'left';
    wctx.fillStyle = st.read; wctx.fillText(cap.text, 0, st.size * 1.12);
    wctx.globalCompositeOperation = 'destination-in';
    const half = st.feather / 2;
    const g = wctx.createLinearGradient(xf - half, 0, xf + half, 0);
    g.addColorStop(0, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    wctx.fillStyle = g; wctx.fillRect(0, 0, work.width, work.height);
    c.drawImage(work, 0, 0, wW, wH, tx, base - st.size * 1.12, wW, wH);
    // the light at the wipe front (only while the clause is being spoken)
    const speaking = t < (lay.map.filter(Boolean).slice(-1)[0]?.f1 ?? cap.f1) + 0.05 && xf < lay.width - 1;
    if (speaking) {
      wctx.globalCompositeOperation = 'source-over'; wctx.clearRect(0, 0, work.width, work.height);
      wctx.fillStyle = rgba(st.edge, 1); wctx.fillText(cap.text, 0, st.size * 1.12);
      wctx.globalCompositeOperation = 'destination-in';
      const g2 = wctx.createLinearGradient(xf - 22, 0, xf + 10, 0);
      g2.addColorStop(0, 'rgba(0,0,0,0)'); g2.addColorStop(0.7, 'rgba(0,0,0,0.95)'); g2.addColorStop(1, 'rgba(0,0,0,0)');
      wctx.fillStyle = g2; wctx.fillRect(0, 0, work.width, work.height);
      c.globalCompositeOperation = 'lighter';
      c.drawImage(work, 0, 0, wW, wH, tx, base - st.size * 1.12, wW, wH);
      c.globalCompositeOperation = 'source-over';
    }
  }
  c.restore();
  return { x: px, y: py, w: pw, h: ph };
}

export function activeCaption(caps, t) {
  for (let i = caps.length - 1; i >= 0; i--) { const k = caps[i]; if (t >= k.f0 && t <= k.f1 + CAPTION_STYLE.exit) return k; }
  return null;
}
