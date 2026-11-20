// lighttrail · media — frame sequences (footage, mattes, thumbnails) as decoded ImageBitmaps.
// The render loop asks for exactly the frames it needs (`need`), and warms the next ones (`prefetch`),
// so drawing stays synchronous and deterministic.

export class Media {
  constructor({ maxEntries = 48 } = {}) { this.seqs = {}; this.cache = new Map(); this.inflight = new Map(); this.max = maxEntries; }
  register(name, { url, count, pad = 6, prefix = 'f_', ext = 'jpg' }) { this.seqs[name] = { url, count, pad, prefix, ext }; }
  _url(name, i) {
    const s = this.seqs[name]; if (!s) throw new Error(`unknown sequence ${name}`);
    const k = Math.max(0, Math.min(s.count - 1, i | 0));
    return [`${s.url}/${s.prefix}${String(k).padStart(s.pad, '0')}.${s.ext}`, k];
  }
  key(name, i) { return `${name}:${this._url(name, i)[1]}`; }
  async get(name, i) {
    const [url, k] = this._url(name, i); const key = `${name}:${k}`;
    if (this.cache.has(key)) { const v = this.cache.get(key); this.cache.delete(key); this.cache.set(key, v); return v; }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`);
      const bmp = await createImageBitmap(await r.blob());
      this.cache.set(key, bmp); this.inflight.delete(key);
      while (this.cache.size > this.max) { const [k0, v0] = this.cache.entries().next().value; this.cache.delete(k0); v0.close?.(); }
      return bmp;
    })();
    this.inflight.set(key, p); return p;
  }
  frame(name, i) { return this.cache.get(this.key(name, i)) || null; }   // synchronous; must have been `need`ed
  async need(list) { await Promise.all(list.map(([n, i]) => this.get(n, i))); }
  prefetch(list) { for (const [n, i] of list) this.get(n, i).catch(() => {}); }
}

export async function loadJSON(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }
export async function loadImage(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return createImageBitmap(await r.blob()); }
