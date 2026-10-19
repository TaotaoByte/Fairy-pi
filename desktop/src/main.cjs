'use strict';

// Fairy-pi desktop shell.
//
// The window is a plain Chromium renderer. The agent runs as a managed `pi`
// subprocess in RPC mode (`pi --mode rpc`), a JSONL protocol on stdin/stdout
// documented by the pi package in docs/rpc.md, docs/rpc-commands.md,
// docs/json.md and docs/rpc-extension-ui.md.
//
// Records from pi are forwarded to the renderer as `pi:record`; renderer
// commands are written back to the child's stdin untouched.

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { IS_WINDOWS, resolveAgentDir, resolvePi, resolveNode } = require('./pi-locate.cjs');

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

class PiBridge {
  constructor({ onRecord, onStatus, onStderr }) {
    this.onRecord = onRecord;
    this.onStatus = onStatus;
    this.onStderr = onStderr;
    this.child = null;
    this.buffer = '';
    this.cwd = process.env.FAIRY_PI_WORKDIR || os.homedir();
    this.extraArgs = [];
    this.status = { state: 'stopped' };
  }

  publish(status) {
    this.status = status;
    this.onStatus(status);
  }

  start() {
    this.stop();

    const pi = resolvePi();
    if (pi.error) {
      this.publish({ state: 'error', message: pi.error });
      return false;
    }
    const node = resolveNode();

    const args = [pi.cli, '--mode', 'rpc', ...this.extraArgs];
    const env = { ...process.env, ...node.env };
    if (pi.installRoot) env.PI_MANAGED_INSTALL_ROOT = pi.installRoot;

    let child;
    try {
      child = spawn(node.exe, args, {
        cwd: this.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.publish({ state: 'error', message: `无法启动 pi：${error && error.message ? error.message : error}` });
      return false;
    }

    this.child = child;
    this.buffer = '';
    this.publish({ state: 'starting', cwd: this.cwd, cli: pi.cli, version: pi.version, node: node.exe });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => this.onStderr(text));

    child.on('error', (error) => {
      this.publish({ state: 'error', message: `pi 进程错误：${error && error.message ? error.message : error}` });
    });
    child.on('exit', (code, signal) => {
      const expected = this.child !== child;
      this.child = null;
      if (!expected) this.publish({ state: 'stopped', code, signal });
    });
    return true;
  }

  /** Split the stdout stream on LF only; pi explicitly warns against line readers that split on U+2028/U+2029. */
  consume(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // stdout is protocol-only; ignore anything malformed
      }
      if (this.status.state === 'starting') this.publish({ ...this.status, state: 'ready' });
      this.onRecord(record);
    }
  }

  send(record) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      this.publish({ state: 'error', message: 'pi 未在运行，命令已丢弃。' });
      return false;
    }
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
    return true;
  }

  /** Close stdin first so pi disposes its runtime; escalate only if it does not exit. */
  stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.removeAllListeners('exit');
    try {
      child.stdin.end();
    } catch {
      /* already gone */
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 2500);
    child.once('exit', () => clearTimeout(timer));
  }

  restart({ cwd } = {}) {
    if (typeof cwd === 'string' && cwd.trim()) this.cwd = cwd.trim();
    const ok = this.start();
    if (ok) this.status = { state: 'starting', cwd: this.cwd };
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

app.setName('Fairy-pi');

let mainWindow = null;
let bridge = null;

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#0a0e1a',
    title: 'Fairy-pi',
    // The reference client draws its own chrome (window buttons + a URL strip),
    // so the OS frame is off and the renderer supplies the title bar.
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Renderer-side failures are otherwise invisible from the terminal.
  mainWindow.webContents.on('console-message', (...args) => {
    const legacy = typeof args[1] === 'number' || typeof args[1] === 'string';
    const level = legacy ? args[1] : args[0] && args[0].level;
    const message = legacy ? args[2] : args[0] && args[0].message;
    if (process.env.FAIRY_PI_DEBUG || level === 'error' || level === 3) {
      process.stderr.write(`[renderer:${level}] ${message}\n`);
    }
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    process.stderr.write(`[renderer gone] ${JSON.stringify(details)}\n`);
  });

  // Keep the app a single window; external links go to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------------------------------------------------------------------------
// Session index (for the workspace tree in the sidebar)
// ---------------------------------------------------------------------------

/**
 * pi keeps one directory per working directory under `<agent_data>/sessions`,
 * each holding `<timestamp>_<id>.jsonl` transcripts. There is no RPC command
 * that lists them, so the main process reads the headers directly; the
 * renderer only ever sees the small summary objects.
 */
function listSessions(limit = 80) {
  const agentDir = resolveAgentDir();
  if (!agentDir) return [];
  const root = path.join(agentDir, 'sessions');

  let groups = [];
  try {
    groups = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return [];
  }

  const sessions = [];
  for (const group of groups) {
    const dir = path.join(root, group.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
    } catch {
      continue;
    }
    // Only the newest few per working directory: older ones cannot be reached
    // faster than they can be read anyway, and the tree stays legible.
    files.sort().reverse().slice(0, 25);

    for (const name of files) {
      const file = path.join(dir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }

      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        /* unreadable session; still list it by filename */
      }

      let cwd = '';
      let id = '';
      let title = '';
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.type === 'session') {
          cwd = record.cwd || '';
          id = record.id || '';
        } else if (record.type === 'session_name' && record.name) {
          title = String(record.name);
        } else if (!title && record.type === 'message' && record.message && record.message.role === 'user') {
          const content = record.message.content;
          const text = typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('')
              : '';
          if (text.trim()) title = text.trim().replace(/\s+/g, ' ').slice(0, 48);
        }
      }

      sessions.push({
        path: file,
        id,
        cwd,
        title: title || id || name.replace(/\.jsonl$/, ''),
        mtime: stat.mtimeMs,
      });
    }
  }

  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

app.whenReady().then(() => {
  bridge = new PiBridge({
    onRecord: (record) => sendToRenderer('pi:record', record),
    onStatus: (status) => sendToRenderer('pi:status', status),
    onStderr: (text) => sendToRenderer('pi:stderr', text),
  });

  createWindow();

  ipcMain.handle('pi:bootstrap', () => {
    const pi = resolvePi();
    return {
      cwd: bridge ? bridge.cwd : null,
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      piVersion: pi.version || null,
      piPath: pi.cli || null,
      piError: pi.error || null,
      home: os.homedir(),
    };
  });

  ipcMain.handle('pi:send', (_event, record) => {
    if (!record || typeof record !== 'object') return false;
    return bridge ? bridge.send(record) : false;
  });

  ipcMain.handle('pi:restart', (_event, options) => {
    if (!bridge) return false;
    return bridge.restart(options || {});
  });

  ipcMain.handle('pi:pick-workdir', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 pi 的工作目录',
      defaultPath: bridge ? bridge.cwd : os.homedir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pi:reveal', (_event, target) => {
    if (typeof target === 'string' && target) shell.showItemInFolder(target);
  });

  ipcMain.handle('pi:sessions', () => listSessions());

  // Window buttons are drawn by the renderer because the window is frameless.
  ipcMain.handle('window:control', (_event, action) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (action === 'minimize') mainWindow.minimize();
    else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') mainWindow.close();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (bridge) bridge.stop();
  if (!IS_WINDOWS) app.quit();
});

app.on('before-quit', () => {
  if (bridge) bridge.stop();
});

// The renderer asks for the child to come up once it has installed its
// listeners, so no startup record can race ahead of the UI.
ipcMain.on('pi:start', () => {
  if (bridge && bridge.status.state !== 'ready') bridge.start();
});
