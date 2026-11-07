// Build web/dist: one self-contained index.html (app + worker inlined) plus the
// pinned ML assets as the page's own files. Run: node tools/build.mjs
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const common = { bundle: true, minify: true, write: false, target: 'es2022', legalComments: 'inline', logLevel: 'warning' };

const workerOut = await build({ ...common, entryPoints: [path.join(root, 'src/worker.js')], format: 'iife', platform: 'browser' });
const workerSource = workerOut.outputFiles[0].text;

const workerPlugin = {
  name: 'worker-source',
  setup(b) {
    b.onResolve({ filter: /^virtual:worker-source$/ }, () => ({ path: 'worker-source', namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({ contents: `export default ${JSON.stringify(workerSource)};`, loader: 'js' }));
  },
};

const appOut = await build({
  ...common,
  entryPoints: [path.join(root, 'src/app.js')],
  format: 'esm',
  platform: 'browser',
  external: ['three', 'three/addons/*'],
  plugins: [workerPlugin],
});
const appSource = appOut.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const template = readFileSync(path.join(root, 'src/index.template.html'), 'utf8');
if (!template.includes('<!--APP-->')) throw new Error('template is missing <!--APP-->');
const html = template.replace('<!--APP-->', () => `<script type="module">\n${appSource}</script>`);
writeFileSync(path.join(dist, 'index.html'), html);

const lock = readFileSync(path.join(root, 'assets.lock'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
for (const line of lock) {
  const [dest, sha] = line.split(/\s+/);
  const src = path.join(root, 'assets', dest);
  if (!existsSync(src)) throw new Error(`missing asset ${dest}: run bash tools/fetch-assets.sh`);
  const got = createHash('sha256').update(readFileSync(src)).digest('hex');
  if (got !== sha) throw new Error(`SHA-256 mismatch for ${dest}: ${got}`);
  // Models ship as JSON {sha256, base64}: the artifact host serves standard web media types only.
  // The page verifies the SHA-256 after decoding and passes the bytes to MediaPipe.
  const out = dest.endsWith('.bin') ? dest.replace(/\.bin$/, '.json') : dest;
  mkdirSync(path.dirname(path.join(dist, out)), { recursive: true });
  if (out.endsWith('.json')) {
    writeFileSync(path.join(dist, out), JSON.stringify({ sha256: sha, bytes: readFileSync(src).length, base64: readFileSync(src).toString('base64') }));
  } else {
    copyFileSync(src, path.join(dist, out));
  }
}
console.log(`dist/index.html ${(html.length / 1024).toFixed(1)} KB (worker ${(workerSource.length / 1024).toFixed(1)} KB), ${lock.length} assets verified`);
