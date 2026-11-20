// lighttrail · devices — the motion vocabulary. Each device draws one "insider object" of video making
// (selection box, waveform, keyframes, timeline, odometer…) as a pure function of its inputs.
// Devices register their screen boxes so QA can prove nothing ever covers the face.
import { W, H, C, F, TAU, rgba, clamp, lerp, seg, E, hash, txt, decode, font, dot, ring, rrect, line,
  rectProgress, polyProgress, glowStroke, glowDot } from './core.js';

// ───────────── QA registry ─────────────
export const QA = { on: false, boxes: [] };
export function reg(x, y, w, h, tag = '', behind = false) { if (QA.on && w > 0 && h > 0) QA.boxes.push({ x, y, w, h, tag, behind }); }

// ───────────── labels ─────────────
// Mono label that decodes in; optional filled tag.
export function label(c, str, x, y, p, o = {}) {
  const { size = 40, color = C.bone, tag = null, align = 'left', spacing = 1.5, weight = 600, alpha = 1, seed = 7, frame = 0 } = o;
  if (p <= 0 || alpha <= 0) return 0;
  const s = decode(str, clamp(p), seed, frame);
  c.save(); c.font = font(size, F.mono, weight); c.letterSpacing = `${spacing}px`;
  const w = c.measureText(str).width; c.restore();
  const x0 = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
  if (tag) {
    const a = E.outCubic(seg(p, 0, 0.35)) * alpha;
    c.save(); c.globalAlpha *= a; c.fillStyle = tag; c.fillRect(x0 - 10, y - size * 1.05, w + 20, size * 1.5); c.restore();
  }
  txt(c, s, x0, y, { size, family: F.mono, weight, color, spacing, alpha });
  reg(x0 - 10, y - size * 1.1, w + 20, size * 1.6, 'label:' + str);
  return w;
}

// ───────────── selection box (editor marquee with 8 handles) ─────────────
// dim (0..1): everything outside the box fades — colour drained, sunk toward the void — so the selection
// reads as the subject; it follows the frame's draw-on. keep(c): drawn again over the fade (e.g. the person's
// cut-out, so a shoulder leaving the box stays lit), under the frame lines.
export function selectBox(c, b, o = {}) {
  const { p = 1, handles = 1, color = C.signal, lw = 2.5, tag = null, tagP = 1, tagSide = 'top', dims = null, dimsP = 1, frame = 0, dim = 0, keep = null } = o;
  if (p <= 0) return;
  if (dim > 0) { const k = dim * E.pro(clamp(p)); dimOutside(c, b, k); if (keep && k > 0) keep(c, k); }
  c.save(); c.strokeStyle = color; c.lineWidth = lw; rectProgress(c, b.x, b.y, b.w, b.h, E.pro(clamp(p)));
  const hs = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
  hs.forEach(([hx, hy], k) => {
    const q = E.outBack(clamp((handles - k * 0.04) / 0.6), 2.4); if (q <= 0) return;
    const s = 15 * q, px = b.x + hx * b.w, py = b.y + hy * b.h;
    c.fillStyle = C.bone; c.fillRect(px - s / 2, py - s / 2, s, s); c.strokeStyle = color; c.lineWidth = 2; c.strokeRect(px - s / 2, py - s / 2, s, s);
  });
  c.restore();
  if (tag && tagSide === 'top') label(c, tag, b.x + 2, b.y - 18, tagP, { size: 40, color: C.void, tag: color, frame });
  if (tag && tagSide === 'left') label(c, tag, b.x - 26, b.y + 72, tagP, { size: 40, color: C.void, tag: color, align: 'right', frame });
  if (dims) label(c, dims, b.x + b.w / 2, b.y + b.h + 44, dimsP, { size: 28, color: C.bone, tag: C.void, align: 'center', frame });
  // the frame itself is four thin lines: register them as such (they may pass near a head, never across it)
  for (const [x, y, w, h] of [[b.x, b.y - 2, b.w, 4], [b.x, b.y + b.h - 2, b.w, 4], [b.x - 2, b.y, 4, b.h], [b.x + b.w - 2, b.y, 4, b.h]]) reg(x - 8, y - 8, w + 16, h + 16, 'select-edge');
}

export function dimOutside(c, b, k, { sat = 0.88, dark = 0.5 } = {}) {
  if (k <= 0) return;
  c.save();
  c.beginPath(); c.rect(-40, -40, W + 80, H + 80); c.rect(b.x, b.y, b.w, b.h); c.clip('evenodd');
  c.globalCompositeOperation = 'saturation'; c.globalAlpha = sat * k; c.fillStyle = '#808080'; c.fillRect(-40, -40, W + 80, H + 80);
  c.globalCompositeOperation = 'source-over'; c.globalAlpha = dark * k; c.fillStyle = C.void; c.fillRect(-40, -40, W + 80, H + 80);
  c.restore();
}

// ───────────── real waveform (from peaks of the actual voice track) ─────────────
// peaks: {rate, peak[]}; draws audio time [tA, tB] across width; bars up to `tNow` are lit.
export function waveform(c, peaks, o) {
  const { x, y, w, h, tA, tB, tNow = tB, p = 1, color = 'signal', dim = 0.22, bar = 5, gap = 3, gain = 1.45 } = o;
  if (p <= 0) return;
  const n = Math.floor(w / (bar + gap));
  const visible = Math.floor(n * clamp(p));
  let head = null;
  for (let i = 0; i < visible; i++) {
    const ta = lerp(tA, tB, i / n), tb = lerp(tA, tB, (i + 1) / n);
    const ia = Math.floor(ta * peaks.rate), ib = Math.max(ia + 1, Math.floor(tb * peaks.rate));
    let m = 0; for (let k = ia; k < ib && k < peaks.peak.length; k++) m = Math.max(m, peaks.peak[k]);
    const a = clamp(m * gain) * h / 2 + 1.5;
    const xx = x + i * (bar + gap);
    const lit = ta <= tNow;
    c.fillStyle = lit ? rgba(color, 1) : rgba('bone', dim);
    c.beginPath(); c.roundRect(xx, y - a, bar, a * 2, bar / 2); c.fill();
    if (lit) head = [xx + bar / 2, y];
  }
  if (head && tNow < tB) glowDot(c, head[0], head[1], 5, color, 0.9);
  reg(x, y - h / 2, w, h, 'waveform');
}

// Radial waveform ring (burst beat).
export function waveRing(c, peaks, o) {
  const { cx, cy, r, tA, tB, rot = 0, p = 1, color = 'signal', n = 180, gain = 1.4 } = o;
  for (let i = 0; i < n * p; i++) {
    const ta = lerp(tA, tB, i / n); const k = Math.floor(ta * peaks.rate);
    const m = clamp((peaks.peak[k] || 0) * gain); const a = rot + (i / n) * TAU;
    const r0 = r - 6 - m * 70, r1 = r + 6 + m * 120;
    c.strokeStyle = rgba(i % 9 === 0 ? 'bone' : color, 0.95); c.lineWidth = 3;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); c.stroke();
  }
}

// ───────────── kinetic type ─────────────
// Slam: arrives scaled up and blurred, lands hard on `at`, holds, exits.
export function slam(c, str, o) {
  const { x, y, size = 160, family = F.sans, weight = 900, color = C.bone, t, at, dur = 0.22, out = null, outDur = 0.18,
    align = 'left', from = 1.18, spacing = 0, accent = null, accentColor = C.signal, stagger = 0, tag = 'slam', behind = false, squash = 0 } = o;
  if (t < at - 0.001) return null;
  const k = E.outExpo(seg(t, at, at + dur));
  const ko = out != null ? E.inCubic(seg(t, out, out + outDur)) : 0;
  if (ko >= 1) return null;
  c.save(); c.font = font(size, family, weight); c.letterSpacing = `${spacing}px`; c.textBaseline = 'alphabetic';
  const wTot = c.measureText(str).width;
  const x0 = align === 'center' ? x - wTot / 2 : align === 'right' ? x - wTot : x;
  const s = lerp(from, 1, k) * (1 - 0.06 * ko);
  const cx = x0 + wTot / 2, cy = y - size * 0.38;
  c.translate(cx, cy); c.scale(s * (1 + squash * Math.sin(Math.PI * k) * 0.1), s * (1 - squash * Math.sin(Math.PI * k) * 0.1)); c.translate(-cx, -cy);
  c.globalAlpha *= clamp(k * 1.6) * (1 - ko);
  if (!stagger && !accent) { c.fillStyle = color; c.fillText(str, x0, y + (1 - k) * size * 0.12); }
  else {
    let xx = x0; const chars = [...str];
    chars.forEach((ch, i) => {
      const kk = stagger ? E.outExpo(seg(t, at + i * stagger, at + i * stagger + dur)) : 1;
      const cw = c.measureText(ch).width;
      c.globalAlpha = clamp(kk * 1.6) * (1 - ko);
      c.fillStyle = accent && accent.includes(i) ? accentColor : color;
      c.fillText(ch, xx, y + (1 - kk) * size * 0.35);
      xx += cw + spacing;
    });
  }
  c.restore();
  reg(x0, y - size * 0.86, wTot, size * 1.02, tag, behind);
  return { x: x0, y: y - size * 0.86, w: wTot, h: size * 1.02 };
}

// Echo stack: a word repeated as outlines above and below (burst typography).
export function echoStack(c, str, o) {
  const { x, y, size = 260, family = F.sans, weight = 900, t, at, n = 3, gapK = 1.02, color = C.bone } = o;
  const spread = E.outExpo(seg(t, at, at + 0.26));
  c.save(); c.font = font(size, family, weight); c.textAlign = 'center'; c.textBaseline = 'alphabetic';
  for (let k = -n; k <= n; k++) {
    const yy = y + k * size * gapK * spread;
    if (k === 0) { c.fillStyle = color; c.fillText(str, x, y); continue; }
    c.strokeStyle = rgba('bone', clamp(0.85 - Math.abs(k) * 0.22) * spread); c.lineWidth = 2; c.strokeText(str, x, yy);
  }
  c.restore();
}

// ───────────── strike-through & REC ─────────────
export function strike(c, x0, y, x1, p, color = C.signal, lw = 6) {
  if (p <= 0) return; c.save(); c.strokeStyle = color; c.lineWidth = lw; c.lineCap = 'round';
  c.beginPath(); c.moveTo(x0, y); c.lineTo(lerp(x0, x1, E.pro(clamp(p))), y); c.stroke(); c.restore();
}
export function recIndicator(c, o) {
  const { x, y, t, p = 1, struck = 0, tc = '00:00:00:00', frame = 0 } = o;
  if (p <= 0) return;
  const blink = Math.floor(t * 2) % 2 === 0 ? 1 : 0.35;
  c.save(); c.globalAlpha *= E.outCubic(clamp(p));
  dot(c, x + 18, y - 15, 17, rgba('signal', blink));
  txt(c, 'REC', x + 50, y, { size: 44, family: F.mono, weight: 800, color: C.bone, spacing: 2 });
  txt(c, decode(tc, clamp(p * 1.5), 3, frame), x + 172, y, { size: 44, family: F.mono, weight: 500, color: C.bone, spacing: 1 });
  c.restore();
  strike(c, x - 10, y - 16, x + 470, struck, C.signal, 8);
  reg(x - 12, y - 52, 500, 66, 'rec');
}

// ───────────── editor timeline strip ─────────────
// tracks: [{name, color, clips:[[a,b],...] (0..1)}]; playhead 0..1; keyframes: [[track, pos],...]
export function timelineStrip(c, o) {
  const { x, y, w, rowH = 30, tracks, p = 1, playhead = null, keyframes = [], kfP = 1, kfDim = 0, lit = null, litP = 0, labelW = 120, frame = 0 } = o;
  if (p <= 0) return;
  const h = tracks.length * (rowH + 8) + 10;
  c.save(); c.globalAlpha *= E.outCubic(clamp(p * 2));
  c.fillStyle = rgba('ink', 0.92); rrect(c, x, y, w, h, 10); c.fill();
  c.strokeStyle = rgba('bone', 0.12); c.lineWidth = 1; rrect(c, x, y, w, h, 10); c.stroke();
  const tx = x + labelW, tw = w - labelW - 16;
  tracks.forEach((tr, i) => {
    const ty = y + 10 + i * (rowH + 8);
    txt(c, tr.name, x + 14, ty + rowH * 0.72, { size: Math.min(24, rowH * 0.62), family: F.mono, weight: 600, color: C.ash, spacing: 1 });
    tr.clips.forEach(([a, b], k) => {
      const q = E.outExpo(clamp((p - 0.15 - k * 0.012) / 0.5)); if (q <= 0) return;
      const cx0 = tx + a * tw, cw = (b - a) * tw * q;
      const isLit = lit === i;
      c.fillStyle = isLit ? (litP > 0 ? rgba('signal', lerp(0.35, 1, litP)) : rgba(tr.color || 'graphite', 0.9)) : rgba(tr.color || 'graphite', 0.9);
      rrect(c, cx0, ty + 3, Math.max(2, cw - 3), rowH - 6, 4); c.fill();
    });
  });
  keyframes.forEach(([ti, pos], k) => {
    const q = clamp(kfP * 1.2 - k * 0.02); if (q <= 0) return;
    const kx = tx + pos * tw, ky = y + 10 + ti * (rowH + 8) + rowH / 2, s = 8 * E.outBack(q, 2);
    c.save(); c.translate(kx, ky); c.rotate(Math.PI / 4); c.globalAlpha *= 1 - kfDim;
    c.fillStyle = C.bone; c.fillRect(-s / 2, -s / 2, s, s); c.restore();
  });
  if (playhead != null) {
    const px = tx + clamp(playhead) * tw;
    c.strokeStyle = C.signal; c.lineWidth = 2; c.beginPath(); c.moveTo(px, y - 8); c.lineTo(px, y + h + 4); c.stroke();
    c.fillStyle = C.signal; c.beginPath(); c.moveTo(px - 8, y - 14); c.lineTo(px + 8, y - 14); c.lineTo(px, y - 4); c.fill();
  }
  c.restore();
  reg(x, y - 16, w, h + 20, 'timeline');
  return h;
}

// ───────────── barcode (mean colour of every frame) ─────────────
export function barcode(c, data, o) {
  const { x, y, w, h, p = 1, scan = null, useMean = true, curve = 0 } = o;
  const n = data.frames, cols = useMean ? data.mean : data.peak;
  const vis = Math.floor(n * clamp(p));
  const bw = w / n;
  for (let i = 0; i < vis; i++) {
    const [r, g, b] = cols[i];
    c.fillStyle = `rgb(${r},${g},${b})`;
    const yy = y + Math.sin((i / n) * Math.PI) * curve;
    c.fillRect(x + i * bw, yy, Math.max(bw, 1.2), h);
  }
  if (scan != null && scan > 0 && scan < 1) {
    const sx = x + w * scan;
    c.save(); c.globalCompositeOperation = 'lighter';
    const g = c.createLinearGradient(sx - 60, 0, sx + 6, 0); g.addColorStop(0, rgba('signal', 0)); g.addColorStop(1, rgba('signal', 0.55));
    c.fillStyle = g; c.fillRect(sx - 60, y - 10, 66, h + 20); c.restore();
    line(c, sx, y - 18, sx, y + h + 18, C.signal, 2);
  }
  reg(x, y, w, h, 'barcode');
}

// ───────────── point cloud (from an image's luminance) ─────────────
export function pointCloud(c, pts, o) {
  const { cx, cy, scale = 1, yaw = 0, pitch = 0, p = 1, explode = 0, dotR = 1.6, depth = 260 } = o;
  const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const D = 1400;
  c.save(); c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i]; if (hash(i, 3) > p) continue;
    let X = q.x * scale, Y = q.y * scale, Z = q.z * depth;
    if (explode) { const r = 1 + explode * (1.5 + hash(i, 9) * 4); X *= r; Y *= r; Z += explode * (hash(i, 11) - 0.5) * 2400; }
    const x1 = X * cyw + Z * syw, z1 = -X * syw + Z * cyw;
    const y2 = Y * cp - z1 * sp, z2 = Y * sp + z1 * cp;
    const s = D / (D + z2); const sx = cx + x1 * s, sy = cy + y2 * s;
    if (sx < -20 || sx > W + 20 || sy < -20 || sy > H + 20) continue;
    c.fillStyle = q.hot ? rgba('signal', 0.95) : `rgba(241,237,228,${0.25 + q.l * 0.7})`;
    const r = dotR * s * (q.hot ? 1.5 : 1);
    c.fillRect(sx - r, sy - r, r * 2, r * 2);
  }
  c.restore();
}
// Build points from an ImageBitmap region (call once at init).
export function cloudFromImage(img, { sx, sy, sw, sh, step = 7, mask = null }) {
  const cv = new OffscreenCanvas(sw, sh), g = cv.getContext('2d');
  g.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const d = g.getImageData(0, 0, sw, sh).data;
  let md = null;
  if (mask) { const mc = new OffscreenCanvas(sw, sh), mg = mc.getContext('2d'); mg.drawImage(mask, sx / 2, sy / 2, sw / 2, sh / 2, 0, 0, sw, sh); md = mg.getImageData(0, 0, sw, sh).data; }
  const pts = [];
  for (let y = 0; y < sh; y += step) for (let x = 0; x < sw; x += step) {
    const k = (y * sw + x) * 4; const l = (0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]) / 255;
    if (md && md[k + 3] < 128) continue;
    pts.push({ x: x - sw / 2, y: y - sh / 2, z: (l - 0.5) * -1, l, hot: hash(x, y) < 0.025 });
  }
  return pts;
}

// ───────────── odometer ─────────────
export function odometer(c, value, o) {
  const { x, y, size = 120, digits = 3, color = C.bone, family = F.mono, weight = 800, sep = null } = o;
  const dh = size * 1.0, dw = size * 0.64;
  c.save(); c.beginPath(); c.rect(x - 6, y - size * 0.86, digits * dw + (sep ? sep.length * dw * 0.5 : 0) + 12, size * 1.04); c.clip();
  c.font = font(size, family, weight); c.fillStyle = color; c.textBaseline = 'alphabetic';
  let xx = x;
  for (let k = 0; k < digits; k++) {
    const place = 10 ** (digits - 1 - k);
    let d = Math.floor(value / place) % 10 + (place === 1 ? value % 1 : Math.max(0, (value % place) - (place - 1)));
    const di = Math.floor(d), fr = d - di;
    c.fillText(String(di % 10), xx, y - fr * dh); c.fillText(String((di + 1) % 10), xx, y + (1 - fr) * dh);
    xx += dw;
    if (sep && sep[k]) { c.fillText(sep[k], xx - dw * 0.18, y); xx += dw * 0.5; }
  }
  c.restore();
  reg(x, y - size * 0.86, xx - x, size * 1.04, 'odometer');
}

// ───────────── iteration rings ─────────────
export function rings(c, o) {
  const { cx, cy, r0 = 70, gap = 34, n = 4, draw = [1, 1, 1, 1], labels = ['v1', 'v2', 'v3', 'v4'], spin = 0, crack = [], fall = 0, color = 'signal' } = o;
  for (let i = 0; i < n; i++) {
    const p = clamp(draw[i] ?? 0); if (p <= 0) continue;
    const r = r0 + i * gap; const a0 = -Math.PI / 2 + spin * (i % 2 ? -1 : 1) * (1 + i * 0.3);
    const fy = fall * (60 + i * 90) * (1 + fall), fr = fall * (i % 2 ? -0.6 : 0.8);
    c.save(); c.translate(cx, cy + fy); c.rotate(fr); c.globalAlpha *= 1 - clamp(fall * 1.4 - 0.4);
    const broken = crack.includes(i);
    glowStroke(c, () => { c.beginPath(); c.arc(0, 0, r, a0, a0 + TAU * E.pro(p) * (broken ? 0.82 : 1)); }, broken ? 'bone' : color, 4, broken ? 0.3 : 1);
    if (p > 0.9) {
      const la = a0 + TAU * E.pro(p);
      txt(c, labels[i], Math.cos(la) * r + 10, Math.sin(la) * r - 8, { size: 30, family: F.mono, weight: 800, color: C.bone });
      if (broken) txt(c, '✕', Math.cos(la + 0.4) * r - 10, Math.sin(la + 0.4) * r + 10, { size: 30, family: F.mono, weight: 800, color: C.signal });
    }
    c.restore();
  }
  const R = r0 + (n - 1) * gap + 20; reg(cx - R, cy - R, R * 2, R * 2, 'rings');
}

// ───────────── code view ─────────────
const KW = /\b(const|let|function|return|for|of|if|else|import|export|await|async|new)\b/g;
export function codeView(c, lines, o) {
  const { x, y, size = 24, lineH = 38, typed = Infinity, p = 1, gutter = true, hl = -1 } = o;
  if (p <= 0) return;
  c.save(); c.globalAlpha *= E.outCubic(clamp(p * 2)); c.font = font(size, F.mono, 500); c.textBaseline = 'alphabetic';
  let left = typed;
  lines.forEach((ln, i) => {
    const yy = y + i * lineH;
    if (gutter) txt(c, String(i + 1).padStart(2, ' '), x, yy, { size: size * 0.8, family: F.mono, color: C.ash, alpha: 0.6 });
    if (i === hl) { c.fillStyle = rgba('signal', 0.12); c.fillRect(x + 44, yy - size, 1100, lineH); }
    if (left <= 0) return;
    const shown = ln.slice(0, Math.max(0, Math.floor(left))); left -= ln.length;
    // tokenise: comments, strings, keywords, numbers
    let xx = x + 56; const parts = [];
    const re = /(\/\/.*$)|('[^']*'|"[^"]*")|(\b\d+(\.\d+)?\b)|([A-Za-z_]\w*(?=\())|(\b(?:const|let|function|return|for|of|if|else|import|export|await|async|new)\b)/g;
    let last = 0, m;
    while ((m = re.exec(shown))) { if (m.index > last) parts.push([shown.slice(last, m.index), C.bone]);
      parts.push([m[0], m[1] ? C.ash : m[2] ? '#9FE3C4' : m[3] ? C.hot : m[5] ? '#7C8BFF' : C.signal]); last = m.index + m[0].length; }
    if (last < shown.length) parts.push([shown.slice(last), C.bone]);
    for (const [s, col] of parts) { c.fillStyle = col; c.fillText(s, xx, yy); xx += c.measureText(s).width; }
    if (left > -1 && left <= 0 && shown.length < ln.length + 1) { c.fillStyle = C.signal; c.fillRect(xx + 2, yy - size * 0.8, 3, size); }
  });
  c.restore();
  reg(x, y - size, 1180, lines.length * lineH + 10, 'code');
}

// ───────────── toggle, file tree, comment box, slot reel ─────────────
export function toggle(c, o) {
  const { x, y, p = 1, state = 0, left = '数字人', right = '真人' } = o;
  if (p <= 0) return;
  c.save(); c.globalAlpha *= E.outCubic(clamp(p * 2));
  const w = 190, h = 92, s = E.pro(clamp(state));
  txt(c, left, x - 30, y + 20, { size: 60, family: F.sans, weight: 800, color: s < 0.5 ? C.bone : C.ash, align: 'right' });
  rrect(c, x, y - h / 2, w, h, h / 2); c.fillStyle = s > 0.5 ? C.signal : C.graphite; c.fill();
  dot(c, x + h / 2 + s * (w - h), y, h / 2 - 7, C.bone);
  txt(c, right, x + w + 30, y + 20, { size: 60, family: F.sans, weight: 800, color: s > 0.5 ? C.bone : C.ash });
  c.restore(); reg(x - 300, y - 56, w + 560, 112, 'toggle');
}
export function fileTree(c, items, o) {
  const { x, y, p = 1, size = 26, lineH = 44, frame = 0 } = o;
  if (p <= 0) return;
  items.forEach((it, i) => {
    const q = clamp((p - i * 0.09) / 0.4); if (q <= 0) return;
    const yy = y + i * lineH, ind = it.depth * 34;
    c.save(); c.globalAlpha *= E.outCubic(q);
    if (it.depth) line(c, x + 10 + (it.depth - 1) * 34, yy - size * 0.35, x + ind - 6, yy - size * 0.35, rgba('bone', 0.25), 1.5);
    txt(c, decode(it.name, q, 40 + i, frame), x + ind, yy, { size, family: F.mono, weight: it.dir ? 700 : 500, color: it.hot ? C.signal : C.bone });
    if (it.note) txt(c, it.note, x + 380, yy, { size: size * 0.82, family: F.sans, weight: 500, color: C.ash, alpha: q });
    c.restore();
  });
  reg(x, y - size, 980, items.length * lineH, 'filetree');
}
export function commentBox(c, o) {
  const { x, y, w = 760, p = 1, text = '', typed = 0, t = 0, pulse: pu = 0, placeholder = '说点什么…' } = o;
  if (p <= 0) return;
  const h = 96;
  c.save(); c.globalAlpha *= E.outCubic(clamp(p * 2)); const yy = y + (1 - E.outExpo(clamp(p))) * 40;
  c.fillStyle = rgba('ink', 0.94); rrect(c, x, yy, w, h, 48); c.fill();
  c.strokeStyle = rgba('signal', 0.5 + 0.5 * pu); c.lineWidth = 2 + pu * 2; rrect(c, x, yy, w, h, 48); c.stroke();
  const shown = [...text].slice(0, Math.floor(typed)).join('');
  const tw = txt(c, shown || '', x + 44, yy + 62, { size: 38, family: F.sans, weight: 600, color: C.bone });
  if (!shown) txt(c, placeholder, x + 44, yy + 62, { size: 38, family: F.sans, weight: 400, color: C.ash });
  if (Math.floor(t * 2.4) % 2 === 0) { c.fillStyle = C.signal; c.fillRect(x + 48 + tw, yy + 26, 4, 46); }
  dot(c, x + w - 50, yy + h / 2, 30, shown ? C.signal : C.graphite);
  c.strokeStyle = C.void; c.lineWidth = 4; c.beginPath(); c.moveTo(x + w - 62, yy + h / 2); c.lineTo(x + w - 38, yy + h / 2); c.moveTo(x + w - 48, yy + h / 2 - 10); c.lineTo(x + w - 38, yy + h / 2); c.lineTo(x + w - 48, yy + h / 2 + 10); c.stroke();
  c.restore(); reg(x, yy, w, h, 'comment');
  return { caretX: x + 48 + tw, caretY: yy + h / 2 };
}
export function slotReel(c, words, o) {
  const { x, y, size = 96, p = 0, stop = words.length - 1, color = C.bone } = o;
  const pos = E.outCubic(clamp(p)) * stop; const lh = size * 1.25;
  c.save(); c.beginPath(); c.rect(x - 20, y - lh * 1.5, 900, lh * 2.4); c.clip();
  c.font = font(size, F.sans, 900); c.textBaseline = 'middle';
  for (let i = 0; i < words.length; i++) {
    const d = i - pos; if (Math.abs(d) > 1.6) continue;
    c.globalAlpha = clamp(1 - Math.abs(d) * 0.75); c.fillStyle = Math.abs(d) < 0.3 ? color : C.ash;
    c.fillText(words[i], x, y + d * lh);
  }
  c.restore(); reg(x - 20, y - lh * 1.5, 900, lh * 2.4, 'slot');
}

// ───────────── trail & motifs ─────────────
export function trail(c, pts, o) {
  const { p = 1, width = 3, color = 'signal', head = true, tailFade = 0 } = o;
  if (p <= 0) return null;
  let hp = null;
  glowStroke(c, () => { hp = polyProgressPath(c, pts, p, tailFade); }, color, width);
  if (head && hp && p < 1) glowDot(c, hp[0], hp[1], width * 2.2, color);
  return hp;
}
function polyProgressPath(c, pts, p, tailFade) {
  const lens = []; let tot = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); tot += l; }
  const end = tot * clamp(p), start = tot * clamp(tailFade);
  let acc = 0, started = false, head = pts[0];
  c.beginPath();
  for (let i = 1; i < pts.length; i++) {
    const a = acc, b = acc + lens[i - 1];
    if (b >= start && a <= end) {
      const f0 = clamp((start - a) / lens[i - 1]), f1 = clamp((end - a) / lens[i - 1]);
      const p0 = [lerp(pts[i - 1][0], pts[i][0], f0), lerp(pts[i - 1][1], pts[i][1], f0)];
      const p1 = [lerp(pts[i - 1][0], pts[i][0], f1), lerp(pts[i - 1][1], pts[i][1], f1)];
      if (!started) { c.moveTo(p0[0], p0[1]); started = true; }
      c.lineTo(p1[0], p1[1]); head = p1;
    }
    acc = b;
  }
  return head;
}
export function shockwave(c, cx, cy, p, col = C.bone, maxR = 1300) {
  if (p <= 0 || p >= 1) return;
  c.save(); c.strokeStyle = col; c.globalAlpha *= 1 - p; c.lineWidth = 3 + (1 - p) * 24;
  c.beginPath(); c.arc(cx, cy, 20 + maxR * E.outExpo(p), 0, TAU); c.stroke(); c.restore();
}
export function hudCorners(c, p, col = C.bone, m = 30) {
  if (p <= 0) return; const L = 22 * E.outExpo(clamp(p));
  c.save(); c.strokeStyle = col; c.globalAlpha *= 0.85; c.lineWidth = 2; c.beginPath();
  for (const [x, y, sx, sy] of [[m, m, 1, 1], [W - m, m, -1, 1], [W - m, H - m, -1, -1], [m, H - m, 1, -1]]) { c.moveTo(x, y + sy * L); c.lineTo(x, y); c.lineTo(x + sx * L, y); }
  c.stroke(); c.restore();
}
