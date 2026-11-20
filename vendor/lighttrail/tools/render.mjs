#!/usr/bin/env node
// lighttrail · render — zero-dependency renderer driver.
// Serves the engine, fonts, film module, project data and media over a local HTTP server, opens the
// engine page in headless Chrome (GPU via ANGLE/Metal) and receives finished frames by POST.
//
//   node render.mjs --film <film.js> --project <dir> --media <dir> --mode frames --from 0 --to 299 --out master.mkv [--samples 8] [--size 1080x1920]
//   node render.mjs ... --mode stills --stills 0,120,264 --out-dir previews/
//   node render.mjs ... --mode cues --out cues.json
//   node render.mjs ... --mode info
//
// frames → ffmpeg rawvideo (RGBA, bottom-up) → vflip → FFV1 lossless (gbrp). Encode/mux is a separate step.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skill = path.resolve(here, '..');
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const v = argv[i + 1]; args[argv[i].slice(2)] = v && !v.startsWith('--') ? (i++, v) : true; }
const need = (k) => { if (!args[k]) { console.error(`missing --${k}`); process.exit(2); } return args[k]; };

const filmPath = path.resolve(need('film'));
// 字体体积大，允许外部指定（ds-media-studio 的 vendor 副本不带字体）
const FONT_DIR = args.fonts ? path.resolve(args.fonts) : path.join(skill, 'assets', 'fonts');
const roots = {
  '/engine/': path.join(skill, 'engine'),
  '/fonts/': FONT_DIR,
  '/film/': path.dirname(filmPath),
  '/project/': path.resolve(need('project')),
  '/media/': path.resolve(need('media')),
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.ttf': 'font/ttf',
  '.jpg': 'image/jpeg', '.png': 'image/png', '.wav': 'audio/wav', '.txt': 'text/plain' };
const mode = args.mode || 'frames';
const CHROME = args.chrome || process.env.LIGHTTRAIL_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const ANGLE = process.env.LIGHTTRAIL_ANGLE || (process.platform === 'win32' ? 'd3d11' : 'metal');

let ff = null, received = 0, expected = 0, finish, failed = false;
const done = new Promise((r) => (finish = r));
// Frame size for the encoder. A film drawn at another size (it calls setSize) needs --size WxH here;
// the page refuses to render frames when the two disagree.
const SIZE = String(args.size || '1920x1080');
if (mode === 'frames') {
  const out = path.resolve(need('out')); fs.mkdirSync(path.dirname(out), { recursive: true });
  expected = Number(need('to')) - Number(need('from')) + 1;
  ff = spawn(process.env.LIGHTTRAIL_FFMPEG || 'ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', SIZE, '-r', String(args.fps || 30), '-i', '-',
    '-vf', 'vflip,format=gbrp', '-c:v', 'ffv1', '-level', '3', '-g', '1', '-slices', '16', out], { stdio: ['pipe', 'inherit', 'inherit'] });
}
if (mode === 'stills') fs.mkdirSync(path.resolve(need('out-dir')), { recursive: true });
if (mode === 'qa') fs.writeFileSync(path.resolve(need('out')), '');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const reply = () => { res.writeHead(200); res.end('ok'); };
      switch (url.pathname) {
        case '/frame':
          received++;
          if (!ff.stdin.write(body)) ff.stdin.once('drain', reply); else reply();
          if (received % 60 === 0) process.stdout.write(`  ${received}/${expected} frames\n`);
          return;
        case '/still': {
          const f = url.searchParams.get('f');
          fs.writeFileSync(path.join(path.resolve(args['out-dir']), `frame_${String(f).padStart(5, '0')}.png`), body); reply(); return;
        }
        case '/cues': fs.writeFileSync(path.resolve(need('out')), body); reply(); finish(); return;
        case '/qa': fs.appendFileSync(path.resolve(need('out')), body); reply(); return;
        case '/info': console.log(body.toString()); reply(); finish(); return;
        case '/log': console.log('[page]', body.toString()); reply(); return;
        case '/error': console.error('[page error]', body.toString()); failed = true; reply(); finish(); return;
        case '/done': reply(); finish(); return;
        default: res.writeHead(404); res.end();
      }
    });
    return;
  }
  const root = Object.keys(roots).find((r) => url.pathname.startsWith(r));
  if (!root) { res.writeHead(404); return res.end(); }
  const p = path.join(roots[root], decodeURIComponent(url.pathname.slice(root.length)));
  if (!p.startsWith(roots[root]) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const params = new URLSearchParams({ film: `/film/${path.basename(filmPath)}`, mode, samples: String(args.samples || 8), size: SIZE });
for (const k of ['from', 'to', 'stills', 'shutter']) if (args[k]) params.set(k, String(args[k]));
for (const [k, v] of Object.entries(args)) if (k.startsWith('q-')) params.set(k.slice(2), String(v));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lighttrail-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', `--use-angle=${ANGLE}`, '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--force-device-scale-factor=1', '--window-size=1920,1080', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/engine/index.html?${params}`], { stdio: ['ignore', 'ignore', 'pipe'] });
chrome.stderr.on('data', (d) => { const s = d.toString(); if (/error/i.test(s) && !/GPU|gles|Fontconfig|dbus|SharedImage|CVDisplayLink|cv_display_link/i.test(s)) process.stderr.write('[chrome] ' + s); });

const t0 = Date.now();
await done;
const exited = new Promise((r) => chrome.once('exit', r));
chrome.kill('SIGTERM');
await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
if (ff) { ff.stdin.end(); await new Promise((r) => ff.on('close', r)); }
if (mode === 'frames' && received !== expected) { console.error(`expected ${expected} frames, got ${received}`); failed = true; }
server.close();
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp profile; OS cleans it */ }
console.log(`${mode} ${failed ? 'FAILED' : 'done'} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failed ? 1 : 0);
