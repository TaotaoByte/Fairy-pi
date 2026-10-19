// Headless checks for the desktop shell: syntax of every entry file plus a real
// evaluation of the mascot bundle outside a browser.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

console.log('syntax');
for (const file of ['src/main.cjs', 'src/preload.cjs', 'src/renderer/app.js']) {
  const full = path.join(root, file);
  try {
    new vm.Script(readFileSync(full, 'utf8'), { filename: full });
    check(file, true);
  } catch (error) {
    check(file, false, error.message);
  }
}

console.log('mascot bundle');
const bundlePath = path.join(root, 'src', 'renderer', 'vendor', 'fairy-mascot.bundle.js');
const sandbox = { window: {}, console };
sandbox.globalThis = sandbox;
try {
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(bundlePath, 'utf8'), sandbox, { filename: bundlePath });
} catch (error) {
  check('bundle evaluates', false, error.message);
}

const assets = sandbox.window.FairyMascotAssets;
check('window.FairyMascotAssets exists', Boolean(assets));
if (assets) {
  check('CSS is a non-trivial stylesheet', typeof assets.CSS === 'string' && assets.CSS.length > 5000, `length=${assets.CSS && assets.CSS.length}`);
  check('CSS targets the mascot root', assets.CSS.includes('[data-dsh-fairy-mascot-root="true"]'));
  check('SVG is markup', typeof assets.SVG === 'string' && assets.SVG.includes('<svg'));
  check('PULSE_SVG is markup', typeof assets.PULSE_SVG === 'string' && assets.PULSE_SVG.includes('<svg'));
  check('HALO_SVG is markup', typeof assets.HALO_SVG === 'string' && assets.HALO_SVG.includes('<svg'));
}

console.log('stylesheet file');
const cssFile = path.join(root, 'src', 'renderer', 'vendor', 'fairy-mascot.css');
const css = readFileSync(cssFile, 'utf8');
check('emitted css matches module export', assets ? css.includes(assets.CSS.slice(0, 400)) : false);
check('css defines the idle animation', css.includes('@keyframes'));

console.log('renderer wiring');
const html = readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
for (const asset of ['styles.css', 'vendor/fairy-mascot.css', 'vendor/fairy-mascot.bundle.js', 'app.js']) {
  check(`index.html links ${asset}`, html.includes(asset));
}
const app = readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');
check('renderer uses the mascot root attribute', app.includes('data-dsh-fairy-mascot-root'));
check('renderer speaks the rpc prompt command', app.includes("type: 'prompt'"));
check('renderer handles extension ui requests', app.includes('extension_ui_request'));

console.log('sidebar shell');
const styles = readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const PAGES = ['chat', 'balance', 'voice', 'persona', 'skills', 'browser', 'settings'];
for (const page of PAGES) {
  check(`index.html defines the ${page} page`, html.includes(`data-page="${page}"`));
  check(`renderer routes to the ${page} page`, app.includes(`id: '${page}'`) || app.includes(`${page}: () =>`));
}
for (const id of ['tabs', 'ws-tree', 'titlebar', 'titlebar-pill', 'session-title', 'balance-card', 'side-balance', 'side-band', 'model-menu', 'composer', 'input']) {
  check(`index.html declares #${id}`, html.includes(`id="${id}"`));
}
check('renderer has a page router', app.includes('function showPage(') && app.includes('dataset.page'));
check('renderer builds the workspace tree', app.includes('function renderWsTree(') && app.includes('switch_session'));
check('renderer restores a transcript', app.includes('function loadTranscript(') && app.includes('get_messages'));
check('renderer drives the frameless window', app.includes('controlWindow('));
const mainSource = readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');
const preloadSource = readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8');
check('main.cjs indexes sessions', mainSource.includes('function listSessions(') && mainSource.includes("ipcMain.handle('pi:sessions'"));
check('main.cjs controls the frameless window', mainSource.includes("ipcMain.handle('window:control'") && mainSource.includes('frame: false'));
check('preload exposes sessions and window control', preloadSource.includes('listSessions') && preloadSource.includes('controlWindow'));
check('renderer captures panel command output', app.includes('function captureCommand(') && app.includes('capture.messages.push'));
check('renderer offers a model switcher', app.includes('get_available_models') && app.includes("type: 'set_model'"));
check('renderer offers thinking levels', app.includes('get_available_thinking_levels') && app.includes('set_thinking_level'));
check('renderer persists desktop prefs', app.includes('localStorage') && app.includes('fairy-pi.desktop.prefs'));
check('renderer drives the vendored mascot speed knob', app.includes('--dsh-fairy-steady-rate'));
check('stylesheet carries both themes', styles.includes('[data-theme="light"]') && styles.includes('[data-theme="dark"]'));
check('stylesheet paints the DSH background grid', styles.includes('.hdd-glow-a') && styles.includes('.hdd-fx'));
check('stylesheet paints the sidebar board ridge', styles.includes('.sidebar-board') && styles.includes('.brand-eye'));

console.log('pi discovery');
const { existsSync } = require('node:fs');
const { agentDirCandidates, resolveAgentDir, resolvePi, resolveNode } = require(path.join(root, 'src', 'pi-locate.cjs'));
const fakeEnv = {
  PATH: 'C:\\tools',
  USERPROFILE: 'C:\\Users\\tester',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
};
const candidates = agentDirCandidates(fakeEnv);
check('env overrides come first', agentDirCandidates({ ...fakeEnv, PI_AGENT_DIR: 'X:\\p' })[0] === 'X:\\p');
check(
  'LOCALAPPDATA candidate is formed',
  candidates.includes(path.join('C:\\Users\\tester\\AppData\\Local', 'Programs', 'pi-agent', 'agent_data')),
);
check(
  'drive scan candidate is absolute',
  candidates.some((c) => c === path.join('D:\\', 'Users', 'tester', 'AppData', 'Local', 'Programs', 'pi-agent', 'agent_data')),
  candidates.find((c) => c.startsWith('D:')),
);
check('no drive-relative candidates leak in', candidates.every((c) => !/^[A-Za-z]:[^\\/]/.test(c)), candidates.find((c) => /^[A-Za-z]:[^\\/]/.test(c)));

// The PATH branch only fires when a launcher really exists, so exercise it
// against the machine running the check.
const launcherDir = (process.env.PATH || '')
  .split(path.delimiter)
  .find((dir) => /agent_data[\\/]bin[\\/]?$/i.test(dir) && ['pi.ps1', 'pi.cmd', 'pi.bat', 'pi.exe'].some((name) => existsSync(path.join(dir, name))));
if (launcherDir) {
  check('PATH candidate keeps agent_data', agentDirCandidates().includes(path.dirname(launcherDir)), path.dirname(launcherDir));
} else {
  console.log('  note PATH 上没有 pi 启动器，跳过 PATH 断言');
}

const resolved = resolvePi();
if (resolved.error) {
  console.log(`  note 本机未找到 pi（${resolved.error}），跳过实机断言`);
} else {
  check('resolvePi finds a CLI entry', resolved.cli.endsWith('cli.js'), resolved.cli);
  check('resolvePi reports a version', /^\d+\.\d+\.\d+/.test(resolved.version), resolved.version);
  check('resolveAgentDir agrees', resolveAgentDir() === resolved.agentDir, resolved.agentDir);
}
const node = resolveNode();
check('resolveNode picks an existing interpreter', Boolean(node.exe), node.exe);

console.log(failures === 0 ? '\nall desktop smoke checks passed' : `\n${failures} desktop smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
