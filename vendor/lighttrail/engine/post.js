// lighttrail · post — sub-frame accumulation in linear light (true motion blur), 3-level bloom,
// chromatic aberration, glitch slicing, flash/invert, cluster film grain and vignette.
// Adapted from the Opus 5.5 showreel renderer.
import { W, H } from './core.js';

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const NOISE = `
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash13(vec3 p3){ p3 = fract(p3 * 0.1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
float grainNoise(vec2 p, float z){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  float a = hash13(vec3(i, z)), b = hash13(vec3(i + vec2(1.0, 0.0), z));
  float c = hash13(vec3(i + vec2(0.0, 1.0), z)), d = hash13(vec3(i + 1.0, z));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) - 0.5;
}`;

const ACCUM = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform float uWeight;
void main(){ vec3 c = texture(uSrc, vUv).rgb; o = vec4(pow(c, vec3(2.2)) * uWeight, uWeight); }`;
const BRIGHT = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uThresh;
void main(){
  vec3 c = vec3(0.0);
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb; c += texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb; c += texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  c *= 0.25; float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // saturated light (the signal colour) blooms more than neutral white text
  float sat = max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b));
  o = vec4(c * (smoothstep(uThresh, 1.0, l) + 0.55 * smoothstep(0.18, 0.6, sat) * smoothstep(0.08, 0.3, l)), 1.0);
}`;
const DOWN = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uTexel;
void main(){
  vec3 c = texture(uSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb
         + texture(uSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture(uSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  o = vec4(c * 0.25, 1.0);
}`;
const BLUR = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o; uniform sampler2D uSrc; uniform vec2 uDir;
void main(){
  vec3 c = texture(uSrc, vUv).rgb * 0.2270270270;
  c += texture(uSrc, vUv + uDir * 1.3846153846).rgb * 0.3162162162; c += texture(uSrc, vUv - uDir * 1.3846153846).rgb * 0.3162162162;
  c += texture(uSrc, vUv + uDir * 3.2307692308).rgb * 0.0702702703; c += texture(uSrc, vUv - uDir * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;
const FINAL = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uAccum, uB1, uB2, uB3; uniform vec2 uRes;
uniform float uBloom, uFlash, uCA, uGlitch, uSeed, uInvert, uGrain, uVig, uFrame, uFade;
${NOISE}
void main(){
  vec2 uv = vUv;
  if (uGlitch > 0.0){
    float band = floor(uv.y * 18.0 + hash12(vec2(uSeed, 1.0)) * 9.0);
    if (hash12(vec2(band, uSeed)) > 1.0 - 0.45 * uGlitch) uv.x += (hash12(vec2(band * 1.7, uSeed + 3.0)) - 0.5) * 0.16 * uGlitch;
    float fine = floor(uv.y * 160.0);
    if (hash12(vec2(fine, uSeed * 2.1)) > 0.93) uv.x += (hash12(vec2(fine, uSeed)) - 0.5) * 0.04 * uGlitch;
    vec2 blk = floor(uv * vec2(24.0, 14.0));
    if (hash12(blk + uSeed) > 1.0 - 0.06 * uGlitch) uv = (blk + 0.5 + (hash12(blk * 3.1 + uSeed) - 0.5) * 3.0) / vec2(24.0, 14.0);
  }
  vec2 dir = uv - 0.5; float ca = uCA / uRes.x; vec2 sh = vec2(uGlitch * 0.012, 0.0);
  vec3 col;
  col.r = texture(uAccum, uv + dir * ca * 2.0 + sh).r;
  col.g = texture(uAccum, uv).g;
  col.b = texture(uAccum, uv - dir * ca * 2.0 - sh).b;
  vec3 bloom = texture(uB1, uv).rgb * 0.55 + texture(uB2, uv).rgb * 0.8 + texture(uB3, uv).rgb * 1.1;
  col += bloom * uBloom;
  vec3 k = max(col - 0.84, 0.0); col = min(col, 0.84) + (1.0 - exp(-k / 0.16)) * 0.16;   // soft highlight shoulder
  float vig = 1.0 - uVig * pow(length(dir * vec2(1.0, 0.8)) * 1.3, 2.4); col *= vig;
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
  if (uInvert > 0.5) col = 1.0 - col;
  col *= 1.0 - clamp(uFade, 0.0, 1.0);
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  float g = (grainNoise(gl_FragCoord.xy / 1.6, uFrame * 7.13) + grainNoise(gl_FragCoord.yx / 1.1 + 17.0, uFrame * 3.71) * 0.5) * 2.2;
  col += g * uGrain * (1.0 - 0.55 * l);
  o = vec4(col, 1.0);
}`;

function program(gl, fs) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos'); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const loc = {}; return { p, u: (n) => (n in loc ? loc[n] : (loc[n] = gl.getUniformLocation(p, n))) };
}
function tex(gl, w, h, float) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return t;
}
function fbo(gl, w, h) {
  const t = tex(gl, w, h, true), fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  return { fb, tex: t, w, h };
}

export class Post {
  constructor(canvas) {
    const gl = (this.gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true, alpha: false }));
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('EXT_color_buffer_float unavailable');
    gl.getExtension('OES_texture_float_linear');
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.pA = program(gl, ACCUM); this.pB = program(gl, BRIGHT); this.pD = program(gl, DOWN); this.pBl = program(gl, BLUR); this.pF = program(gl, FINAL);
    this.src = tex(gl, W, H, false); this.acc = fbo(gl, W, H);
    this.l1 = [fbo(gl, W / 2, H / 2), fbo(gl, W / 2, H / 2)];
    this.l2 = [fbo(gl, W / 4, H / 4), fbo(gl, W / 4, H / 4)];
    this.l3 = [fbo(gl, W / 8, H / 8), fbo(gl, W / 8, H / 8)];
  }
  _pass(prog, target, texs, uni = {}) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : W, target ? target.h : H); gl.useProgram(prog.p);
    texs.forEach(([n, t], i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u(n), i); });
    for (const [k, v] of Object.entries(uni)) Array.isArray(v) ? gl.uniform2f(prog.u(k), v[0], v[1]) : gl.uniform1f(prog.u(k), v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  begin() { const gl = this.gl; gl.bindFramebuffer(gl.FRAMEBUFFER, this.acc.fb); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  add(canvas, weight) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    this._pass(this.pA, this.acc, [['uSrc', this.src]], { uWeight: weight });
    gl.disable(gl.BLEND);
  }
  _blur(pair, n) { for (let i = 0; i < n; i++) { this._pass(this.pBl, pair[1], [['uSrc', pair[0].tex]], { uDir: [1 / pair[0].w, 0] }); this._pass(this.pBl, pair[0], [['uSrc', pair[1].tex]], { uDir: [0, 1 / pair[0].h] }); } }
  finish(pp, frame) {
    this._pass(this.pB, this.l1[0], [['uSrc', this.acc.tex]], { uTexel: [1 / W, 1 / H], uThresh: pp.thresh ?? 0.86 });
    this._blur(this.l1, 1);
    this._pass(this.pD, this.l2[0], [['uSrc', this.l1[0].tex]], { uTexel: [1 / this.l1[0].w, 1 / this.l1[0].h] }); this._blur(this.l2, 2);
    this._pass(this.pD, this.l3[0], [['uSrc', this.l2[0].tex]], { uTexel: [1 / this.l2[0].w, 1 / this.l2[0].h] }); this._blur(this.l3, 3);
    this._pass(this.pF, null, [['uAccum', this.acc.tex], ['uB1', this.l1[0].tex], ['uB2', this.l2[0].tex], ['uB3', this.l3[0].tex]], {
      uRes: [W, H], uBloom: pp.bloom ?? 0.3, uFlash: pp.flash ?? 0, uCA: pp.ca ?? 1.2, uGlitch: pp.glitch ?? 0,
      uSeed: pp.seed ?? (frame * 1.618) % 97, uInvert: pp.invert ?? 0, uGrain: pp.grain ?? 0.03, uVig: pp.vig ?? 0.2, uFrame: frame, uFade: pp.fade ?? 0,
    });
  }
  pixels() {
    const gl = this.gl, px = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px; // bottom-up rows; the encoder flips
  }
}
