// Build web/dist: the studio (index.html, app + worker inlined), the salon setup page, and every
// file they need as the page's own files: fonts, MediaPipe (library, wasm, models), icons, manifest
// and a service worker. Nothing is loaded from another host at run time.
//
//   node tools/build.mjs            standalone site, with a Content-Security-Policy that forbids
//                                   connections to any other origin
//   ARTIFACT=1 node tools/build.mjs same files without the CSP <meta> (for hosts that wrap the page
//                                   and add their own policy)
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const ARTIFACT = process.env.ARTIFACT === '1';
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const files = []; // everything written to dist, for the service worker
function emit(rel, data) {
  const out = path.join(dist, rel);
  mkdirSync(path.dirname(out), { recursive: true });
  if (typeof data === 'string' && existsSync(data) && path.isAbsolute(data)) copyFileSync(data, out); else writeFileSync(out, data);
  files.push(rel);
}

const common = { bundle: true, minify: true, write: false, target: 'es2022', legalComments: 'eof', logLevel: 'warning' };

const workerOut = await build({ ...common, entryPoints: [path.join(root, 'src/worker.js')], format: 'iife', platform: 'browser' });
const workerSource = workerOut.outputFiles[0].text;
const workerPlugin = {
  name: 'worker-source',
  setup(b) {
    b.onResolve({ filter: /^virtual:worker-source$/ }, () => ({ path: 'worker-source', namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: `export default ${JSON.stringify(workerSource)};`, loader: 'js' }));
  },
};

// ---- fonts (OFL-1.1, from Fontsource packages; latin subsets)
const FONTS = [
  ['Bricolage Grotesque', '200 800', nm('@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2'), 'bricolage-grotesque.woff2'],
  ['Figtree', '300 900', nm('@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2'), 'figtree.woff2'],
  ['IBM Plex Mono', '400', nm('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'), 'ibm-plex-mono-400.woff2'],
  ['IBM Plex Mono', '500', nm('@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2'), 'ibm-plex-mono-500.woff2'],
];
const fontCss = FONTS.map(([family, weight, src, name]) => {
  emit(`fonts/${name}`, src);
  return `@font-face { font-family: "${family}"; font-style: normal; font-weight: ${weight}; font-display: swap; src: url("fonts/${name}") format("woff2"); }`;
}).join('\n');

// ---- pages
const sha256b64 = (text) => createHash('sha256').update(text).digest('base64');
function page(templateFile, source, outFile) {
  const template = readFileSync(path.join(root, 'src', templateFile), 'utf8');
  for (const mark of ['<!--APP-->', '<!--HEAD-->', '/*FONTS*/']) if (!template.includes(mark)) throw new Error(`${templateFile} is missing ${mark}`);
  const body = `\n${source.replace(/<\/script/gi, '<\\/script')}`;
  // The policy names the one inline script by hash, allows this origin's own files, and nothing else:
  // the browser itself then refuses any request to another host (connect-src 'self').
  const csp = [
    "default-src 'self'", `script-src 'self' 'sha256-${sha256b64(body)}' 'wasm-unsafe-eval'`, "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:", "media-src 'self' blob: mediastream:", "font-src 'self'", "connect-src 'self'", "worker-src 'self' blob:",
    "object-src 'none'", "base-uri 'self'", "form-action 'none'",
  ].join('; ');
  const head = [
    ARTIFACT ? '' : `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="theme-color" content="#962658">',
    '<link rel="manifest" href="manifest.webmanifest">',
    '<link rel="icon" href="icons/icon-192.png" type="image/png">',
    '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">',
  ].filter(Boolean).join('\n');
  const html = template.replace('<!--HEAD-->', () => head).replace('/*FONTS*/', () => fontCss).replace('<!--APP-->', () => `<script type="module">${body}</script>`);
  emit(outFile, html);
  return html;
}

const appOut = await build({ ...common, entryPoints: [path.join(root, 'src/app.js')], format: 'esm', platform: 'browser', plugins: [workerPlugin] });
const html = page('index.template.html', appOut.outputFiles[0].text, 'index.html');
const setupOut = await build({ ...common, entryPoints: [path.join(root, 'src/setup.js')], format: 'esm', platform: 'browser' });
page('setup.template.html', setupOut.outputFiles[0].text, 'setup.html');

// ---- pinned ML assets (SHA-256 checked against assets.lock)
const lock = readFileSync(path.join(root, 'assets.lock'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
for (const line of lock) {
  const [dest, sha] = line.split(/\s+/);
  const src = path.join(root, 'assets', dest);
  if (!existsSync(src)) throw new Error(`missing asset ${dest}: run bash tools/fetch-assets.sh`);
  const got = createHash('sha256').update(readFileSync(src)).digest('hex');
  if (got !== sha) throw new Error(`SHA-256 mismatch for ${dest}: ${got}`);
  // Models ship as JSON {sha256, base64}: some hosts serve standard web media types only.
  // The page verifies the SHA-256 after decoding and passes the bytes to MediaPipe.
  if (dest.endsWith('.bin')) emit(dest.replace(/\.bin$/, '.json'), JSON.stringify({ sha256: sha, bytes: readFileSync(src).length, base64: readFileSync(src).toString('base64') }));
  else emit(dest, src);
}

// ---- MediaPipe Tasks Vision library and wasm loader (Apache-2.0), from the pinned npm package.
// The wasm loader must be the one that ships with the pinned wasm binary.
const mpPkg = JSON.parse(readFileSync(nm('@mediapipe/tasks-vision/package.json'), 'utf8'));
const wasmLine = lock.find((l) => l.startsWith('mediapipe/vision_wasm_internal.wasm'));
if (!wasmLine.includes(`@mediapipe/tasks-vision@${mpPkg.version}`)) throw new Error(`assets.lock pins a different tasks-vision than node_modules (${mpPkg.version})`);
emit('mediapipe/vision_bundle.js', readFileSync(nm('@mediapipe/tasks-vision/vision_bundle.mjs'), 'utf8').replace(/\n\/\/# sourceMappingURL=.*$/m, ''));
emit('mediapipe/vision_wasm_internal.js', nm('@mediapipe/tasks-vision/wasm/vision_wasm_internal.js'));

// ---- salon settings (replaceable without a rebuild), icons, manifest, licences
emit('salon.config.json', path.join(root, 'salon/salon.config.json'));
for (const f of ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png']) emit(`icons/${f}`, path.join(root, 'src/icons', f));
emit('manifest.webmanifest', JSON.stringify({
  name: 'Braid Try-On Studio', short_name: 'Braid Try-On', description: 'Try protective styles on a 3D bust, your photo or a live mirror. Everything stays on your device.',
  start_url: './index.html', scope: './', display: 'standalone', background_color: '#f2f0f3', theme_color: '#962658',
  icons: [
    { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));
const pkgVersion = (name) => JSON.parse(readFileSync(nm(name, 'package.json'), 'utf8')).version;
emit('THIRD-PARTY-LICENSES.txt', [
  'Braid Try-On Studio bundles these open-source components. Full licence texts: see each project.',
  '',
  `three.js ${pkgVersion('three')} — MIT — https://github.com/mrdoob/three.js`,
  `MediaPipe Tasks Vision ${mpPkg.version} (library, wasm) and the Face Landmarker and Hair Segmenter models — Apache-2.0 — https://github.com/google-ai-edge/mediapipe`,
  `uqr ${pkgVersion('uqr')} (QR codes) — MIT — https://github.com/unjs/uqr`,
  'Bricolage Grotesque, Figtree, IBM Plex Mono (fonts, via Fontsource) — SIL Open Font License 1.1',
  'MediaPipe canonical face model — Apache-2.0',
  '1€ filter — Casiez, Roussel & Vogel, CHI 2012 (algorithm)',
  '',
].join('\n'));

// ---- service worker: precache everything above, versioned by content
const version = createHash('sha256');
for (const f of [...files].sort()) version.update(f).update(readFileSync(path.join(dist, f)));
const swSource = readFileSync(path.join(root, 'src/sw.js'), 'utf8');
if (swSource.split('__VERSION__').length !== 2 || swSource.split('__FILES__').length !== 2) throw new Error('src/sw.js must contain each placeholder exactly once');
const sw = swSource
  .replace('__VERSION__', version.digest('hex').slice(0, 12))
  .replace('__FILES__', JSON.stringify(['./', ...files.filter((f) => f !== 'THIRD-PARTY-LICENSES.txt').map((f) => `./${f}`)]));
writeFileSync(path.join(dist, 'sw.js'), sw);

console.log(`dist/index.html ${(html.length / 1024).toFixed(0)} KB (worker ${(workerSource.length / 1024).toFixed(0)} KB), ${files.length + 1} files, ${lock.length} assets verified${ARTIFACT ? ', artifact build (no CSP meta)' : ''}`);
