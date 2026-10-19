// Package the desktop shell into a double-clickable Windows build.
//
// Rebuilds the mascot bundle first so the packaged app never ships a stale
// vendor/  output, then hands the app directory to @electron/packager.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const outDir = path.resolve(appDir, '..', 'out');

execFileSync(process.execPath, [path.join(here, 'build-mascot.mjs')], { stdio: 'inherit' });

const mod = await import('@electron/packager');
const packager = mod.packager || mod.default;
if (!packager) {
  console.error('找不到 @electron/packager，请先运行 npm install。');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(appDir, 'package.json'), 'utf8'));

const outputs = await packager({
  dir: appDir,
  out: outDir,
  name: 'Fairy-pi',
  appVersion: manifest.version,
  platform: 'win32',
  arch: 'x64',
  asar: true,
  prune: true,
  overwrite: true,
  ignore: [
    /^\/scripts($|\/)/,
    /^\/vendor($|\/)/, // only the generated copies under src/renderer/vendor ship
    /^\/package-lock\.json$/,
  ],
  win32metadata: {
    CompanyName: 'Fairy-pi contributors',
    FileDescription: 'Fairy-pi desktop — pi 的图形界面',
    ProductName: 'Fairy-pi',
  },
});

for (const output of outputs) {
  console.log(`packaged ${output}`);
  console.log(`双击启动：${path.join(output, 'Fairy-pi.exe')}`);
}
