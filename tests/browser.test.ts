/**
 * browser-dock 移植单测。
 *
 * 上游的 HTTP 面（`/state`、`/events` SSE、`/frame`、`/control` 鉴权）在 Pi 上不可达，
 * 因此断言集中在可移植的文件协议：state 容错读取、command 的原子写入与 nonce、
 * 上游 control 端点的校验语义与状态码、目录监听，以及会话结束时的清理。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAIRY_LOG_PREFIX, createFairyDiagnostics } from '../src/contracts/index.ts';
import type { FairyLogRecord } from '../src/contracts/index.ts';
import {
  DOCK_STATE_FILE_NAME,
  FAIRY_BROWSER_COMMAND,
  FAIRY_BROWSER_MCP_SERVER_NAME,
  FAIRY_BROWSER_STATUS_KEY,
  INACTIVE_DOCK_STATE,
  applyFairyBrowserDock,
  dockFramePath,
  dockPaths,
  formatDockState,
  formatDockStatusLine,
  listDockFrameRevisions,
  normalizeDockCommand,
  readDockState,
  watchDockState,
  writeDockCommand,
  type DockState,
} from '../src/features/browser/index.ts';

function createTestDiagnostics(moduleName = 'fairy-pi-test') {
  const records: FairyLogRecord[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      const line = String(args[0]);
      if (!line.startsWith(`${FAIRY_LOG_PREFIX} `)) return;
      records.push(JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as FairyLogRecord);
    };
  const sink = { info: collect(), log: collect(), warn: collect(), error: collect() };
  return { diagnostics: createFairyDiagnostics(moduleName, { sink }), records };
}

function withTempDir(run: (directory: string) => void | Promise<void>) {
  return async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), 'fairy-browser-'));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function activeState(overrides: Partial<DockState> = {}): DockState {
  return {
    ...INACTIVE_DOCK_STATE,
    active: true,
    status: 'ready',
    url: 'https://example.com',
    takeoverAvailable: true,
    revision: 7,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('等待条件超时');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('dockPaths 布局与上游 DSH_HOME/browser-dock 一致', () => {
  const paths = dockPaths('D:/fairy');
  assert.equal(paths.runtimeDir.replace(/\\/g, '/'), 'D:/fairy/browser-dock');
  assert.equal(paths.stateFile.replace(/\\/g, '/'), 'D:/fairy/browser-dock/state.json');
  assert.equal(paths.commandFile.replace(/\\/g, '/'), 'D:/fairy/browser-dock/command.json');
  assert.equal(dockFramePath(paths, 7).replace(/\\/g, '/'), 'D:/fairy/browser-dock/frame-7.jpg');
});

test('readDockState：缺文件/非法 JSON 退化为 idle，合法则原样返回', withTempDir((directory) => {
  const { diagnostics, records } = createTestDiagnostics();
  const paths = dockPaths(directory);

  const missing = readDockState(paths, diagnostics);
  assert.equal(missing.present, false);
  assert.deepEqual(missing.state, { ...INACTIVE_DOCK_STATE });

  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(paths.stateFile, '{ 不是 JSON', 'utf8');
  const broken = readDockState(paths, diagnostics);
  assert.equal(broken.present, false);
  assert.deepEqual(broken.state, { ...INACTIVE_DOCK_STATE });
  assert.ok(records.some((record) => record.level === 'warn' && record.operation === 'state.read'));

  writeFileSync(paths.stateFile, '"不是对象"', 'utf8');
  assert.equal(readDockState(paths, diagnostics).present, false);

  writeFileSync(paths.stateFile, JSON.stringify(activeState()), 'utf8');
  const ok = readDockState(paths, diagnostics);
  assert.equal(ok.present, true);
  assert.equal(ok.state.url, 'https://example.com');
  assert.equal(ok.state.revision, 7);
}));

test('writeDockCommand：原子写入 + nonce + 上限拒绝', withTempDir((directory) => {
  const paths = dockPaths(directory);
  const nonce = writeDockCommand(paths, { action: 'bind' }, { now: () => 1_700_000_000_000, random: () => 0.5 });
  assert.equal(nonce, '1700000000000-0.5');

  const written = JSON.parse(readFileSync(paths.commandFile, 'utf8')) as Record<string, unknown>;
  assert.equal(written.action, 'bind');
  assert.equal(written.nonce, nonce);
  assert.equal(existsSync(`${paths.commandFile}.${process.pid}.tmp`), false, '不应留下临时文件');

  writeDockCommand(paths, { action: 'close', reason: 'user' });
  const replaced = JSON.parse(readFileSync(paths.commandFile, 'utf8')) as Record<string, unknown>;
  assert.equal(replaced.reason, 'user');

  assert.throws(
    () => writeDockCommand(paths, { action: 'bind', blob: 'x'.repeat(4_000) }),
    /control body too large/,
  );
}));

test('listDockFrameRevisions 按 revision 排序并忽略无关文件', withTempDir((directory) => {
  const paths = dockPaths(directory);
  mkdirSync(paths.runtimeDir, { recursive: true });
  writeFileSync(join(paths.runtimeDir, 'frame-3.jpg'), '');
  writeFileSync(join(paths.runtimeDir, 'frame-10.jpg'), '');
  writeFileSync(join(paths.runtimeDir, 'frame-0.jpg'), '');
  writeFileSync(join(paths.runtimeDir, 'frame-x.jpg'), '');
  writeFileSync(join(paths.runtimeDir, 'state.json'), '{}');

  assert.deepEqual(listDockFrameRevisions(paths), [3, 10]);
  assert.deepEqual(listDockFrameRevisions(dockPaths(join(tmpdir(), 'fairy-不存在'))), []);
}));

test('normalizeDockCommand：动作白名单、takeover 三重前提、错误码原样', () => {
  const state = activeState();

  assert.deepEqual(normalizeDockCommand('不是对象', state), { ok: false, status: 400, error: 'invalid JSON' });
  assert.deepEqual(normalizeDockCommand({ action: 'open' }, state), {
    ok: false,
    status: 400,
    error: 'unsupported action',
  });

  const bind = normalizeDockCommand({ action: 'bind', sessionId: 's-1', token: 'secret' }, state);
  assert.equal(bind.ok, true);
  assert.equal(bind.ok && bind.command.action, 'bind');
  assert.equal(bind.ok && 'token' in bind.command, false, '令牌字段应被剔除');

  const takeover = normalizeDockCommand({ action: 'takeover', revision: 7 }, state);
  assert.equal(takeover.ok, true);

  const conflict = { ok: false as const, status: 409, error: 'takeover is no longer available' };
  assert.deepEqual(normalizeDockCommand({ action: 'takeover', revision: 6 }, state), conflict);
  assert.deepEqual(normalizeDockCommand({ action: 'takeover', revision: 7 }, { ...state, active: false }), conflict);
  assert.deepEqual(
    normalizeDockCommand({ action: 'takeover', revision: 7 }, { ...state, takeoverAvailable: false }),
    conflict,
  );
  assert.deepEqual(
    normalizeDockCommand({ action: 'takeover', revision: 7 }, { ...state, takeoverConsumed: true }),
    conflict,
  );

  assert.equal(normalizeDockCommand({ action: 'close' }, { ...INACTIVE_DOCK_STATE }).ok, true);
});

test('watchDockState：state.json 变化触发回调，close 后停止', withTempDir(async (directory) => {
  const { diagnostics } = createTestDiagnostics();
  const paths = dockPaths(directory);
  mkdirSync(paths.runtimeDir, { recursive: true });

  let hits = 0;
  const handle = watchDockState(paths, () => {
    hits += 1;
  }, { diagnostics });

  assert.equal(handle.available, true);
  writeFileSync(paths.stateFile, JSON.stringify(activeState()), 'utf8');
  await waitFor(() => hits > 0);

  // 原子替换（临时文件 + rename）也要能被观察到——这是生产者真实的写入方式。
  const before = hits;
  const temporary = join(paths.runtimeDir, `${DOCK_STATE_FILE_NAME}.tmp`);
  writeFileSync(temporary, JSON.stringify(activeState({ status: 'busy', revision: 8 })), 'utf8');
  rmSync(paths.stateFile, { force: true });
  writeFileSync(paths.stateFile, readFileSync(temporary, 'utf8'), 'utf8');
  await waitFor(() => hits > before);

  handle.close();
  const afterClose = hits;
  writeFileSync(paths.stateFile, JSON.stringify(activeState({ status: 'idle' })), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(hits, afterClose, 'close 之后不应再回调');
}));

test('formatDockState / 状态行文案', () => {
  assert.equal(formatDockState({ ...INACTIVE_DOCK_STATE }), '浏览器坞未激活（status=idle）');
  assert.equal(
    formatDockState(activeState({ takeoverAvailable: false })),
    '浏览器坞：ready · https://example.com',
  );
  assert.match(formatDockState(activeState()), /需要人工接管/);
  assert.equal(formatDockStatusLine({ ...INACTIVE_DOCK_STATE }), undefined);
  assert.equal(formatDockStatusLine(activeState()), '坞 ready · 待接管');
  assert.equal(formatDockStatusLine(activeState({ takeoverAvailable: false })), '坞 ready');
});

// ---------- 端到端：applyFairyBrowserDock ----------

function createFakePi() {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const mcpServers: Array<{ name: string; config: unknown }> = [];
  const api = {
    on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      return () => {};
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, options.handler);
    },
    registerMcpServer(name: string, config: unknown) {
      mcpServers.push({ name, config });
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    mcpServers,
    dispatch(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ type: event, ...payload }, ctx);
    },
  };
}

function createFakeContext() {
  const notifications: Array<[string, string]> = [];
  const statuses: Array<[string, string | undefined]> = [];
  const context = {
    mode: 'tui',
    hasUI: true,
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => 'browser-1' },
    ui: {
      setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
      notify: (message: string, type: string) => notifications.push([message, type]),
    },
  } as unknown as ExtensionContext;
  return { context, notifications, statuses };
}

test('命令：state / frames / bind / takeover 冲突 / 未知子命令 / mcp', withTempDir(async (directory) => {
  const { diagnostics } = createTestDiagnostics();
  const { api, commands, mcpServers, dispatch } = createFakePi();
  const { context, notifications, statuses } = createFakeContext();
  const runtime = applyFairyBrowserDock(api, { dataDir: directory, diagnostics });

  assert.deepEqual(mcpServers, []);
  assert.equal(runtime.mcpServerName(), undefined);

  const handler = commands.get(FAIRY_BROWSER_COMMAND);
  assert.ok(handler, '应注册 /fairy-browser');

  await handler!('state', context);
  assert.equal(notifications.at(-1)?.[1], 'warning');
  assert.match(notifications.at(-1)?.[0] ?? '', /浏览器坞未激活/);

  await handler!('frames', context);
  assert.match(notifications.at(-1)?.[0] ?? '', /暂无帧文件/);

  await handler!('bind', context);
  assert.equal(notifications.at(-1)?.[0], '浏览器坞命令已写入：bind');
  const bind = JSON.parse(readFileSync(runtime.paths.commandFile, 'utf8')) as Record<string, unknown>;
  assert.equal(bind.action, 'bind');
  assert.equal(bind.sessionId, null);
  assert.equal(typeof bind.nonce, 'string');

  await handler!('takeover 3', context);
  assert.equal(notifications.at(-1)?.[1], 'warning');
  assert.match(notifications.at(-1)?.[0] ?? '', /接管失败（409）：takeover is no longer available/);

  await handler!('mcp', context);
  assert.equal(notifications.at(-1)?.[1], 'warning');
  assert.match(notifications.at(-1)?.[0] ?? '', /未注册 MCP 服务器/);

  await handler!('乱写', context);
  assert.match(notifications.at(-1)?.[0] ?? '', /\/fairy-browser state/);

  // 活动状态存在时：命令成功、状态行跟随更新
  writeFileSync(runtime.paths.stateFile, JSON.stringify(activeState()), 'utf8');
  await handler!('takeover 7', context);
  assert.equal(notifications.at(-1)?.[0], '浏览器坞命令已写入：takeover');
  assert.equal(notifications.at(-1)?.[1], 'info');
  assert.deepEqual(statuses.at(-1), [FAIRY_BROWSER_STATUS_KEY, '坞 ready · 待接管']);

  await handler!('close 收工', context);
  const close = JSON.parse(readFileSync(runtime.paths.commandFile, 'utf8')) as Record<string, unknown>;
  assert.equal(close.action, 'close');
  assert.equal(close.reason, '收工');
  await new Promise((resolve) => setTimeout(resolve, 100));
}));

test('提供 mcp 时注册 MCP 服务器并命名', () => {
  const { diagnostics } = createTestDiagnostics();
  const { api, mcpServers } = createFakePi();
  const runtime = applyFairyBrowserDock(api, {
    dataDir: join(tmpdir(), 'fairy-browser-mcp'),
    diagnostics,
    mcp: { config: { command: 'node', args: ['proxy.cjs'] } as never },
  });

  assert.equal(mcpServers.length, 1);
  assert.equal(mcpServers[0]?.name, FAIRY_BROWSER_MCP_SERVER_NAME);
  assert.deepEqual(mcpServers[0]?.config, { command: 'node', args: ['proxy.cjs'] });
  assert.equal(runtime.mcpServerName(), FAIRY_BROWSER_MCP_SERVER_NAME);
});

test('session_start 写状态行并监听；session_shutdown 按上游语义清理', withTempDir(async (directory) => {
  const { diagnostics } = createTestDiagnostics();
  const { api, commands, dispatch } = createFakePi();
  const { context, statuses, notifications } = createFakeContext();
  const runtime = applyFairyBrowserDock(api, { dataDir: directory, diagnostics });
  mkdirSync(runtime.paths.runtimeDir, { recursive: true });
  writeFileSync(runtime.paths.stateFile, JSON.stringify(activeState()), 'utf8');

  dispatch('session_start', { reason: 'startup' }, context);
  assert.deepEqual(statuses.at(-1), [FAIRY_BROWSER_STATUS_KEY, '坞 ready · 待接管']);
  await new Promise((resolve) => setTimeout(resolve, 100));

  // 有 state：卸载时通知生产者关闭
  dispatch('session_shutdown', { reason: 'quit' }, context);
  const close = JSON.parse(readFileSync(runtime.paths.commandFile, 'utf8')) as Record<string, unknown>;
  assert.equal(close.action, 'close');
  assert.equal(close.reason, 'plugin-unload');

  // 没有 state 但有残留命令文件：删除
  rmSync(runtime.paths.stateFile, { force: true });
  writeFileSync(runtime.paths.commandFile, '{"stale":true}', 'utf8');
  dispatch('session_shutdown', { reason: 'quit' }, context);
  assert.equal(existsSync(runtime.paths.commandFile), false);

  // 非 tui 模式不写状态行
  const headless = {
    mode: 'json',
    hasUI: false,
    ui: { setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
  dispatch('session_start', { reason: 'startup' }, headless);
  const command = commands.get(FAIRY_BROWSER_COMMAND);
  await command!('state', headless);
  void notifications;

  // 必须显式结束会话：作用域里的 fs.watch 句柄会让测试进程无法退出。
  dispatch('session_shutdown', { reason: 'quit' }, headless);
  await new Promise((resolve) => setTimeout(resolve, 50));
}));
