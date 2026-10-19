// Zip the packaged Windows build into a single file for GitHub Releases.
//
// `npm run package` writes out/Fairy-pi-win32-x64/ (a directory of ~200 MB once
// unpacked). Releases want one artifact, so this turns it into a zip. On
// Windows it uses PowerShell's Compress-Archive; elsewhere it uses `zip`.

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const outDir = path.resolve(appDir, '..', 'out');
const buildDir = path.join(outDir, 'Fairy-pi-win32-x64');
const zipPath = path.join(outDir, 'Fairy-pi-win32-x64.zip');

if (!existsSync(buildDir)) {
  console.error(`没有找到打包产物：${buildDir}\n请先运行 npm run package。`);
  process.exit(1);
}

if (existsSync(zipPath)) rmSync(zipPath);

if (process.platform === 'win32') {
  // execFileSync passes argv directly, so no shell quoting is involved.
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${buildDir}\\*' -DestinationPath '${zipPath}' -Force`],
    { stdio: 'inherit' },
  );
} else {
  execFileSync('zip', ['-qr', zipPath, 'Fairy-pi-win32-x64'], { cwd: outDir, stdio: 'inherit' });
}

const megabytes = statSync(zipPath).size / (1024 * 1024);
console.log(`已生成 ${zipPath}（${megabytes.toFixed(1)} MB）`);
