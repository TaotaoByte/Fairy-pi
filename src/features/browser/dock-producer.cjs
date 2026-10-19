#!/usr/bin/env node
/**
 * 浏览器坞生产者：通用 MCP 代理（上游 `dsh-browser-dock/proxy.cjs` 的 Pi 化重写）。
 *
 * 上游的生产者是「spawn playwright MCP + 逐动作截图 + 检测人机验证 + 原子写 state.json」，
 * 但它把 playwright 的安装路径写死在 DSH profile 目录里，并且内联了一份 DSH 契约的拷贝。
 * 本文件保留同一套**文件契约与语义**，但改成与具体 MCP 无关：
 *
 *   - 目标 MCP 命令由命令行给出：`node dock-producer.cjs npx @playwright/mcp@latest`；
 *   - 标准输入/输出**逐行原样转发**，代理对协议是不可见的（不解析、不改写响应内容）；
 *   - 只观察 `tools/call` 请求与对应响应，用来发布状态；**任何工具结果里的图片内容**
 *     都会落成 `frame-<revision>.jpg`（上游是专门调 playwright 的截图工具，这里不需要
 *     知道对面是谁）；
 *   - 人机验证判定沿用上游的正则与语义（工具名或参数命中即 `takeoverAvailable`）；
 *   - `command.json` 每 5 秒复查一次（上游的 rescan 兜底，目录监听不可靠时仍能生效），
 *     支持 `bind` / `close` / `takeover`；`close` 会让代理退出并清场。
 *
 * 与上游的刻意差异（都在 README 里写明）：
 *   1. 运行目录来自 `FAIRY_PI_DATA_DIR`（默认 `~/.fairy-pi`），不再用 DSH_HOME；
 *   2. 不依赖 `dsh-fairy-contracts`，诊断日志自己写一行 JSON（同样的 `DSH_FAIRY_LOG` 前缀与
 *      字段，便于与其它模块一起 triage）；
 *   3. `url` / `title` 改为**尽力而为**：从工具结果的文本里找 JSON 或 `http(s)` 特征，
 *      取不到就留空——上游会额外发一次 evaluate 去问浏览器，这里不替用户发起额外调用。
 *
 * 这是被 Pi 启动的 MCP 服务器（`pi.registerMcpServer` → stdio），不是扩展代码：
 * 因此必须是自包含 CJS、零依赖，且任何诊断都写 stderr，绝不污染 stdout 的 JSON-RPC。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const LOG_PREFIX = 'DSH_FAIRY_LOG';
const MODULE = 'fairy-pi-browser-producer';

function log(level, operation, context) {
  try {
    process.stderr.write(
      `${LOG_PREFIX} ${JSON.stringify({
        schema: 1,
        timestamp: new Date().toISOString(),
        level,
        module: MODULE,
        operation,
        event: level === 'error' ? 'failure' : 'event',
        context: context || {},
      })}\n`,
    );
  } catch {
    // 日志失败不能影响代理本身。
  }
}

const dataDir = process.env.FAIRY_PI_DATA_DIR || path.join(os.homedir(), '.fairy-pi');
const runtimeDir = path.join(dataDir, 'browser-dock');
const stateFile = path.join(runtimeDir, 'state.json');
const commandFile = path.join(runtimeDir, 'command.json');
const commandRescanMs = Number(process.env.FAIRY_PI_DOCK_RESCAN_MS) || 5_000;
const maxFrameBytes = 8 * 1024 * 1024;

const targetArgs = process.argv.slice(2);
if (targetArgs.length === 0) {
  log('error', 'args.missing', { hint: 'node dock-producer.cjs <目标 MCP 命令> [参数...]' });
  process.exit(2);
}

/** 上游同一份正则与语义：命中即认为需要人工接管。 */
const humanPattern =
  /(?:captcha|验证码|人机验证|verify (?:that )?you are human|sign[ -]?in|log[ -]?in|登录|two[ -]?factor|2fa|authentication code)/i;

let revision = 0;
let frameRevision = 0;
let state = inactiveState();
let commandNonce = null;
let closed = false;
let pendingTools = new Map();

function inactiveState() {
  return {
    active: false,
    status: 'idle',
    url: '',
    title: '',
    tabs: [],
    currentTab: -1,
    frameRevision: 0,
    takeoverAvailable: false,
    takeoverConsumed: false,
    ownerSessionId: null,
    error: null,
    updatedAt: Date.now(),
    revision: 0,
  };
}

function atomicWrite(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
  // Windows 上目标可能正被消费者读取（宿主命令、外部脚本），rename 会瞬时失败 → 退避重试。
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(temporary, file);
      return;
    } catch (error) {
      if (attempt >= 8 || !transient.has(error?.code)) throw error;
      Atomics.wait(sleeper, 0, 0, 8 * attempt);
    }
  }
}

function publish(patch) {
  revision += 1;
  state = { ...state, ...patch, revision, updatedAt: Date.now() };
  try {
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    atomicWrite(stateFile, JSON.stringify(state));
  } catch (error) {
    log('error', 'state.write', { message: error?.message });
  }
}

function frameFile(rev) {
  return path.join(runtimeDir, `frame-${rev}.jpg`);
}

function removeFrameFiles() {
  try {
    for (const name of fs.readdirSync(runtimeDir)) {
      if (/^frame-\d+\.jpg$/.test(name)) {
        try {
          fs.unlinkSync(path.join(runtimeDir, name));
        } catch {
          // 单个帧删不掉不影响收场。
        }
      }
    }
  } catch {
    // 目录不存在等同无需清理。
  }
}

function cleanup() {
  if (closed) return;
  closed = true;
  removeFrameFiles();
  for (const file of [stateFile, commandFile]) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      if (error?.code !== 'ENOENT') log('error', 'cleanup', { file: path.basename(file) });
    }
  }
}

/** 从任意工具结果里提取可读的 url / title（尽力而为，取不到留空）。 */
function sniffLocation(value) {
  const found = { url: '', title: '' };
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 4) return;
    if (typeof node === 'string') {
      if (!found.url) {
        const match = /https?:\/\/[^\s"')]+/.exec(node);
        if (match) found.url = match[0];
      }
      if (node.trim().startsWith('{')) {
        try {
          walk(JSON.parse(node), depth + 1);
        } catch {
          // 不是 JSON 就算了。
        }
      }
      return;
    }
    if (typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    if (typeof node.url === 'string' && !found.url) found.url = node.url;
    if (typeof node.title === 'string' && !found.title) found.title = node.title;
    const children = Array.isArray(node) ? node : Object.values(node);
    for (const child of children) walk(child, depth + 1);
  };
  walk(value, 0);
  return found;
}

function captureImage(content) {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (!block || block.type !== 'image' || typeof block.data !== 'string') continue;
    let bytes;
    try {
      bytes = Buffer.from(block.data, 'base64');
    } catch {
      continue;
    }
    if (bytes.length === 0 || bytes.length > maxFrameBytes) continue;
    frameRevision += 1;
    try {
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(frameFile(frameRevision), bytes, { mode: 0o600 });
    } catch (error) {
      log('warn', 'frame.write', { message: error?.message });
      continue;
    }
    return true;
  }
  return false;
}

function applyCommand(command) {
  if (!command || typeof command !== 'object') return;
  if (typeof command.nonce === 'string') {
    if (command.nonce === commandNonce) return;
    commandNonce = command.nonce;
  }

  if (command.action === 'close') {
    log('info', 'command.close', { reason: command.reason || 'requested' });
    child?.kill();
    cleanup();
    process.exit(0);
  }
  if (command.action === 'bind') {
    publish({
      active: true,
      status: state.status === 'idle' ? 'ready' : state.status,
      ownerSessionId: typeof command.sessionId === 'string' ? command.sessionId : state.ownerSessionId,
    });
    log('info', 'command.bind', { ownerSessionId: state.ownerSessionId });
    return;
  }
  if (command.action === 'takeover') {
    if (!state.takeoverAvailable || state.takeoverConsumed) {
      log('warn', 'command.takeover', { result: 'unavailable' });
      return;
    }
    publish({ takeoverConsumed: true, status: 'ready' });
    log('info', 'command.takeover', { revision: command.revision });
  }
}

function readCommand() {
  try {
    applyCommand(JSON.parse(fs.readFileSync(commandFile, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      log('warn', 'command.read', { message: error?.message });
    }
  }
}

try {
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
} catch (error) {
  log('error', 'runtime.mkdir', { message: error?.message });
  process.exit(1);
}

const child = spawn(targetArgs[0], targetArgs.slice(1), {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

publish({ active: true, status: 'starting', error: null });
log('info', 'proxy.start', { target: targetArgs[0], runtimeDir });

// 上游只在监听不可靠时靠 5 秒复查兜底；这里直接以复查为主，简单且跨平台一致。
const rescan = setInterval(readCommand, commandRescanMs);
rescan.unref?.();

child.on('error', (error) => {
  publish({ active: false, status: 'error', error: String(error?.message || error) });
  log('error', 'target.spawn', { message: error?.message });
  cleanup();
  process.exit(1);
});

child.on('exit', (code, signal) => {
  publish({ active: false, status: 'closed', error: null });
  log('info', 'target.exit', { code, signal });
  cleanup();
  process.exit(0);
});

// 请求侧：只观察，不改写。
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    child.stdin.write(`${line}\n`);
    return;
  }

  if (message && message.method === 'tools/call' && message.id !== undefined) {
    const toolName = String(message.params?.name ?? 'unknown');
    pendingTools.set(message.id, toolName);
    const serialized = JSON.stringify(message.params?.arguments ?? {});
    if (humanPattern.test(toolName) || humanPattern.test(serialized)) {
      publish({ takeoverAvailable: true, takeoverConsumed: false, status: 'needs-human' });
      log('info', 'human.required', { tool: toolName });
    } else {
      publish({ status: 'working', error: null });
    }
  }

  child.stdin.write(`${line}\n`);
});

// 响应侧：原样转发，顺带观察状态、抓帧。
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  process.stdout.write(`${line}\n`);

  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || message.id === undefined || !pendingTools.has(message.id)) return;

  const toolName = pendingTools.get(message.id);
  pendingTools.delete(message.id);
  if (pendingTools.size > 64) pendingTools = new Map([...pendingTools].slice(-32));

  const result = message.result;
  const content = result?.content;
  const captured = captureImage(content);
  const location = sniffLocation(result);
  const failed = result?.isError === true || (message.error !== undefined);

  publish({
    status: failed ? 'error' : 'ready',
    error: failed ? String(result?.isError ? 'tool-error' : message.error?.message || 'tool-error') : null,
    lastTool: toolName,
    ...(captured ? { frameRevision } : {}),
    ...(location.url ? { url: location.url } : {}),
    ...(location.title ? { title: location.title } : {}),
  });
  log('info', 'tool.done', { tool: toolName, frameRevision, failed });
});

process.stdin.on('end', () => {
  try {
    child.stdin.end();
  } catch {
    // 目标已经退出时无论。
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'signal', { signal });
    try {
      child.kill();
    } catch {
      // 同上。
    }
    cleanup();
    process.exit(0);
  });
}
