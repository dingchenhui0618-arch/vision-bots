// lighttrail · core — math, easing, palette, text and shape primitives.
// Every visual in a lighttrail film is a pure function of time; nothing is keyframed by hand.

// Canvas size, 1920×1080 unless a film declares otherwise (a 3:4 cover, a vertical cut…): the film calls
// setSize() first thing in createFilm, before it creates any canvas. Exports are live bindings, so every
// module — and the runner, which builds its canvases after createFilm — sees the new size.
export let W = 1920, H = 1080, CX = W / 2, CY = H / 2;
export function setSize(w, h) { W = w; H = h; CX = w / 2; CY = h / 2; }
export const TAU = Math.PI * 2, DEG = Math.PI / 180;

// ───────────── palette (光轨) ─────────────
export const C = {
  void: '#0A0A0D', bone: '#F1EDE4', signal: '#FF5A1F', cobalt: '#3448FF',
  ash: '#8B8983', graphite: '#26262C', hot: '#FF9A5C', ink: '#14141A',
};
const RGB = {};
export function rgb(name) {
  if (!RGB[name]) { const v = C[name] || name; RGB[name] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); }
  return RGB[name];
}
export const rgba = (name, a = 1) => { const [r, g, b] = rgb(name); return `rgba(${r},${g},${b},${a})`; };

// ───────────── math ─────────────
export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const seg = (t, a, b) => clamp((t - a) / (b - a));           // 0→1 progress of t through [a, b]
export const win = (t, a, b, fi = 0.12, fo = 0.12) => seg(t, a, a + fi) * (1 - seg(t, b - fo, b));
export const hash = (a, b = 0, c = 0) => { const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453; return s - Math.floor(s); };
export const pulse = (x, atk = 0.03, dec = 0.15) => (x < 0 ? 0 : x < atk ? x / atk : Math.exp(-(x - atk) / dec));

export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 26; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
    return by(t);
  };
}
export const E = {
  inQuad: (t) => t * t, outQuad: (t) => 1 - (1 - t) * (1 - t),
  inCubic: (t) => t * t * t, outCubic: (t) => 1 - (1 - t) ** 3,
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outQuart: (t) => 1 - (1 - t) ** 4,
  inExpo: (t) => (t <= 0 ? 0 : 2 ** (10 * t - 10)),
  outExpo: (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  outBack: (t, s = 1.70158) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2,
  inBack: (t, s = 1.70158) => (s + 1) * t ** 3 - s * t * t,
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1),
  pro: cubicBezier(0.7, 0, 0.2, 1),      // signature curve: hard launch, long settle
  soft: cubicBezier(0.4, 0, 0.2, 1),
  burst: cubicBezier(0.3, 0.75, 0.2, 1),
};

export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const h = (a, b, c) => hash(xi + a, yi + b, zi + c);
  const x00 = lerp(h(0, 0, 0), h(1, 0, 0), u), x10 = lerp(h(0, 1, 0), h(1, 1, 0), u);
  const x01 = lerp(h(0, 0, 1), h(1, 0, 1), u), x11 = lerp(h(0, 1, 1), h(1, 1, 1), u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

// ───────────── fonts ─────────────
export const F = { sans: 'LTSans', mono: 'LTMono', disp: 'LTDisplay', serif: 'LTSerif', zhSerif: '"Songti SC", serif' };
export async function loadFonts(base = '/fonts') {
  const faces = [
    new FontFace(F.sans, `url(${base}/NotoSansSC.ttf)`, { weight: '100 900' }),
    new FontFace(F.mono, `url(${base}/JetBrainsMono-VF.ttf)`, { weight: '100 800' }),
    new FontFace(F.disp, `url(${base}/Archivo-VF.ttf)`, { weight: '100 900', stretch: '62% 125%' }),
    new FontFace(F.serif, `url(${base}/InstrumentSerif-Italic.ttf)`, { style: 'italic' }),
  ];
  for (const f of faces) { await f.load(); document.fonts.add(f); }
  // warm the glyph caches so the first rendered frame is not missing characters
  const c = document.createElement('canvas').getContext('2d');
  for (const fam of [F.sans, F.mono, F.disp]) { c.font = `900 40px ${fam}`; c.fillText('光轨永字ABC0123', 0, 40); }
}
export const font = (size, family = F.sans, weight = 500, style = '') => `${style} ${weight} ${size}px ${family}`.trim();

// ───────────── text ─────────────
const SCRAMBLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#%&*+=/<>';
// Decode effect: characters resolve left→right out of random glyphs as p goes 0→1.
export function decode(str, p, seed = 1, frame = 0) {
  if (p >= 1) return str;
  let out = ''; const n = str.length;
  for (let i = 0; i < n; i++) {
    const ch = str[i], q = (p - (i / n) * 0.62) / 0.38;
    if (q <= 0) out += ' ';
    else if (q >= 1 || ch === ' ') out += ch;
    else out += /[一-鿿]/.test(ch) ? '▒' : SCRAMBLE[Math.floor(hash(i, seed, frame) * SCRAMBLE.length)];
  }
  return out;
}
export function txt(c, str, x, y, o = {}) {
  const { size = 16, family = F.mono, weight = 500, color = C.bone, align = 'left', base = 'alphabetic', spacing = 0, alpha = 1, style = '' } = o;
  if (alpha <= 0 || !str) return 0;
  c.save(); c.globalAlpha *= alpha; c.font = font(size, family, weight, style); c.fillStyle = color;
  c.textAlign = align; c.textBaseline = base; c.letterSpacing = `${spacing}px`;
  c.fillText(str, x, y); const w = c.measureText(str).width; c.restore();
  return w;
}
export function measure(c, str, size, family = F.sans, weight = 500, spacing = 0) {
  c.save(); c.font = font(size, family, weight); c.letterSpacing = `${spacing}px`; const w = c.measureText(str).width; c.restore(); return w;
}

// ───────────── shapes ─────────────
export function fillBg(c, col) { c.fillStyle = col; c.fillRect(-40, -40, W + 80, H + 80); }
export function dot(c, x, y, r, col) { if (r <= 0) return; c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, TAU); c.fill(); }
export function ring(c, x, y, r, col, lw = 2, a0 = -Math.PI / 2, a1 = a0 + TAU) {
  if (r <= 0) return; c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.arc(x, y, r, a0, a1); c.stroke();
}
export function rrect(c, x, y, w, h, r) { c.beginPath(); c.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2))); }
export function pill(c, x, y, w, h, col) { rrect(c, x - w / 2, y - h / 2, w, h, Math.min(w, h) / 2); c.fillStyle = col; c.fill(); }
export function zoomAbout(c, x, y, s) { c.translate(x, y); c.scale(s, s); c.translate(-x, -y); }
export function line(c, x0, y0, x1, y1, col, lw = 2) { c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }

// Clockwise perimeter draw-on of a rectangle, from the top-left corner.
export function rectProgress(c, x, y, w, h, p) {
  if (p <= 0) return;
  let L = 2 * (w + h) * Math.min(p, 1);
  c.beginPath(); c.moveTo(x, y);
  const legs = [[x + w, y, w], [x + w, y + h, h], [x, y + h, w], [x, y, h]];
  let px = x, py = y;
  for (const [nx, ny, len] of legs) {
    if (L >= len) { c.lineTo(nx, ny); L -= len; px = nx; py = ny; }
    else { const f = L / len; c.lineTo(px + (nx - px) * f, py + (ny - py) * f); break; }
  }
  c.stroke();
}
export function cornerTicks(c, x, y, w, h, len, col, lw = 2) {
  c.strokeStyle = col; c.lineWidth = lw; c.beginPath();
  c.moveTo(x, y + len); c.lineTo(x, y); c.lineTo(x + len, y);
  c.moveTo(x + w - len, y); c.lineTo(x + w, y); c.lineTo(x + w, y + len);
  c.moveTo(x + w, y + h - len); c.lineTo(x + w, y + h); c.lineTo(x + w - len, y + h);
  c.moveTo(x + len, y + h); c.lineTo(x, y + h); c.lineTo(x, y + h - len);
  c.stroke();
}
// Draw a polyline progressively (0→1 of its length). Returns the head point.
export function polyProgress(c, pts, p) {
  if (p <= 0 || pts.length < 2) return pts[0];
  const lens = []; let tot = 0;
  for (let i = 1; i < pts.length; i++) { const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); lens.push(l); tot += l; }
  let rem = tot * Math.min(p, 1); c.beginPath(); c.moveTo(pts[0][0], pts[0][1]);
  let head = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (rem >= lens[i - 1]) { c.lineTo(pts[i][0], pts[i][1]); rem -= lens[i - 1]; head = pts[i]; }
    else { const f = rem / lens[i - 1]; head = [lerp(pts[i - 1][0], pts[i][0], f), lerp(pts[i - 1][1], pts[i][1], f)]; c.lineTo(head[0], head[1]); break; }
  }
  c.stroke(); return head;
}
// Glowing stroke: draws the current path several times with growing width / falling alpha.
export function glowStroke(c, drawPath, col = 'signal', width = 3, glow = 1) {
  c.save(); c.lineCap = 'round'; c.lineJoin = 'round';
  c.globalCompositeOperation = 'lighter';
  for (const [w, a] of [[width * 7, 0.07], [width * 3.5, 0.16]]) { c.strokeStyle = rgba(col, a * glow); c.lineWidth = w; drawPath(); c.stroke(); }
  c.globalCompositeOperation = 'source-over';
  c.strokeStyle = rgba(col, 1); c.lineWidth = width; drawPath(); c.stroke();
  c.restore();
}
export function glowDot(c, x, y, r, col = 'signal', glow = 1) {
  c.save(); c.globalCompositeOperation = 'lighter';
  const g = c.createRadialGradient(x, y, 0, x, y, r * 6);
  g.addColorStop(0, rgba(col, 0.55 * glow)); g.addColorStop(1, rgba(col, 0));
  c.fillStyle = g; c.fillRect(x - r * 6, y - r * 6, r * 12, r * 12); c.restore();
  dot(c, x, y, r, C[col] || col); dot(c, x, y, r * 0.42, '#FFF4EA');
}
