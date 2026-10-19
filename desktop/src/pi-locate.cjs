'use strict';

// Locating the managed pi install. Kept separate from main.cjs so the search
// order can be unit tested without booting Electron.

const fs = require('node:fs');
const path = require('node:path');

const IS_WINDOWS = process.platform === 'win32';
const PI_PACKAGE = '@earendil-works/pi-coding-agent';

/**
 * Candidate agent directories, most specific first.
 *
 * %LOCALAPPDATA% is not a reliable hint on its own: pi-agent may live under a
 * different drive's user profile (the installer honours the user's choice), so
 * fall back to the `pi` launcher on PATH and finally to a drive scan.
 */
function agentDirCandidates(env = process.env) {
  const candidates = [];
  const push = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };

  push(env.FAIRY_PI_AGENT_DIR);
  push(env.PI_AGENT_DIR);

  const local = env.LOCALAPPDATA || env.APPDATA;
  if (local) push(path.join(local, 'Programs', 'pi-agent', 'agent_data'));

  // `pi` on PATH lives at <agent_data>\bin\pi.*, so its parent is the answer.
  const suffixes = IS_WINDOWS ? ['pi.cmd', 'pi.ps1', 'pi.exe', 'pi.bat', 'pi'] : ['pi'];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir || !/agent_data[\\/]bin[\\/]?$/i.test(dir)) continue;
    for (const name of suffixes) {
      if (fs.existsSync(path.join(dir, name))) push(path.dirname(dir));
    }
  }

  const profile = env.USERPROFILE ? path.basename(env.USERPROFILE) : null;
  if (profile) {
    // `${letter}:\\` keeps the drive root: path.join("F:", "Users") would yield
    // the drive-relative "F:Users" and never resolve.
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
      push(path.join(`${letter}:\\`, 'Users', profile, 'AppData', 'Local', 'Programs', 'pi-agent', 'agent_data'));
    }
  }
  return candidates;
}

function resolveAgentDir(env = process.env) {
  for (const candidate of agentDirCandidates(env)) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Mirrors the resolution in pi's own bin/pi-launcher.js: read the managed
 * `current-version` file, then take the CLI path from that release's manifest.
 */
function resolvePi(env = process.env) {
  const override = env.FAIRY_PI_CLI;
  if (override) {
    if (!fs.existsSync(override)) return { error: `FAIRY_PI_CLI 指向的文件不存在：${override}` };
    return { cli: override, installRoot: undefined };
  }

  const agentDir = resolveAgentDir(env);
  if (!agentDir) {
    return {
      error: '找不到 pi 的安装目录。可以设置 FAIRY_PI_AGENT_DIR 指向 <...>\\pi-agent\\agent_data。',
      tried: agentDirCandidates(env),
    };
  }

  const installRoot = path.join(agentDir, 'install');
  let version;
  try {
    version = fs.readFileSync(path.join(installRoot, 'current-version'), 'utf8').trim();
  } catch {
    return { error: `读不到 pi 版本文件：${path.join(installRoot, 'current-version')}` };
  }
  if (!version || !/^[0-9A-Za-z._+-]+$/.test(version)) {
    return { error: `pi 版本文件内容无效：${version}` };
  }

  const packageDir = path.join(installRoot, 'releases', version, 'node_modules', ...PI_PACKAGE.split('/'));
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  } catch {
    return { error: `读不到 pi 包清单：${packageDir}` };
  }
  const binEntry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin && manifest.bin.pi;
  if (!binEntry) return { error: `${PI_PACKAGE} 没有声明 pi 可执行入口` };

  const cli = path.resolve(packageDir, binEntry);
  if (!fs.existsSync(cli)) return { error: `pi 可执行入口不存在：${cli}` };
  return { cli, installRoot, version, agentDir };
}

/**
 * pi is an ESM Node program. Prefer a real Node on PATH so the child gets the
 * interpreter pi was built for; otherwise run the Electron binary as Node.
 */
function resolveNode(env = process.env) {
  if (env.FAIRY_PI_NODE) return { exe: env.FAIRY_PI_NODE, env: {} };
  const exeName = IS_WINDOWS ? 'node.exe' : 'node';
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (fs.statSync(candidate).isFile()) return { exe: candidate, env: {} };
    } catch {
      /* keep looking */
    }
  }
  return { exe: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

module.exports = { IS_WINDOWS, PI_PACKAGE, agentDirCandidates, resolveAgentDir, resolvePi, resolveNode };
