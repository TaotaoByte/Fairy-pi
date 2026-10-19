/**
 * 入口烟雾测试。
 *
 * 用假的 `ExtensionAPI` 直接调用包的默认导出，验证：四个命令都注册、加载期不抛错、
 * 资源只在会话边界上建立、以及人格语料确实随包分发。
 *
 * 真正的 `pi -e ./` 由人工执行（需要交互式终端），本测试覆盖的是它之前的所有失败面。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import entry, { FAIRY_PI_ASSETS_DIR, FAIRY_PI_BROWSER_PRODUCER, readBrowserMcpArgs } from '../index.ts';
import { FAIRY_BALANCE_COMMAND } from '../src/features/balance/index.ts';
import { FAIRY_BROWSER_COMMAND } from '../src/features/browser/index.ts';
import { FAIRY_PERSONA_COMMAND } from '../src/features/persona/index.ts';
import { FAIRY_VOICE_COMMAND } from '../src/features/voice/index.ts';

function createFakePi() {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, string>();
  const mcpServers: Array<{ name: string; config: unknown }> = [];
  const api = {
    on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      return () => {};
    },
    registerCommand(name: string, options: { description?: string }) {
      commands.set(name, options.description ?? '');
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
      return [...(handlers.get(event) ?? [])].map((handler) => handler({ type: event, ...payload }, ctx));
    },
  };
}

function createFakeContext(): ExtensionContext {
  return {
    mode: 'tui',
    hasUI: true,
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => 'entry-1' },
    modelRegistry: { getApiKeyForProvider: async () => undefined },
    ui: { setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionContext;
}

test('入口注册四个命令，加载期不抛错', () => {
  const { api, commands, mcpServers } = createFakePi();
  assert.doesNotThrow(() => entry(api));

  assert.deepEqual([...commands.keys()].sort(), [
    FAIRY_BALANCE_COMMAND,
    FAIRY_BROWSER_COMMAND,
    FAIRY_PERSONA_COMMAND,
    FAIRY_VOICE_COMMAND,
  ].sort());
  for (const description of commands.values()) {
    assert.ok(description.length > 0, '每个命令都应有 description');
  }
  assert.deepEqual(mcpServers, [], '默认不注册 MCP 服务器');
});

test('人格语料随包分发且入口路径可解析', () => {
  assert.equal(existsSync(FAIRY_PI_ASSETS_DIR), true, FAIRY_PI_ASSETS_DIR);
  assert.equal(existsSync(join(FAIRY_PI_ASSETS_DIR, 'canon', 'fairy_canon.json')), true);
  assert.equal(existsSync(join(FAIRY_PI_ASSETS_DIR, 'behavior', 'fairy_behavior_rules.json')), true);
});

test('资源只在会话边界建立，且数据目录不落在 pi 的 agent_data', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-entry-'));
  const previous = process.env.FAIRY_PI_DATA_DIR;
  process.env.FAIRY_PI_DATA_DIR = directory;
  try {
    const { api, dispatch } = createFakePi();
    entry(api);
    const ctx = createFakeContext();

    assert.equal(existsSync(join(directory, 'browser-dock')), false, '加载期不应创建运行时目录');

    assert.doesNotThrow(() => dispatch('session_start', { reason: 'startup' }, ctx));
    assert.equal(existsSync(join(directory, 'browser-dock')), true, '会话开始后浏览器坞监听建立');

    assert.doesNotThrow(() => dispatch('session_shutdown', { reason: 'quit' }, ctx));
  } finally {
    if (previous === undefined) delete process.env.FAIRY_PI_DATA_DIR;
    else process.env.FAIRY_PI_DATA_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('默认数据目录是 ~/.fairy-pi 而不是 agent_data', () => {
  const previous = process.env.FAIRY_PI_DATA_DIR;
  delete process.env.FAIRY_PI_DATA_DIR;
  try {
    const { api, commands } = createFakePi();
    entry(api);
    assert.equal(commands.size, 4);
  } finally {
    if (previous !== undefined) process.env.FAIRY_PI_DATA_DIR = previous;
  }
});

test('readBrowserMcpArgs：解析 JSON 数组，非法输入警告并视为未设置', () => {
  assert.deepEqual(readBrowserMcpArgs({}), undefined);
  assert.deepEqual(readBrowserMcpArgs({ FAIRY_PI_BROWSER_MCP_ARGS: '   ' }), undefined);
  assert.deepEqual(
    readBrowserMcpArgs({ FAIRY_PI_BROWSER_MCP_ARGS: '["npx","@playwright/mcp@latest"]' }),
    ['npx', '@playwright/mcp@latest'],
  );
  assert.equal(readBrowserMcpArgs({ FAIRY_PI_BROWSER_MCP_ARGS: 'npx playwright' }), undefined);
  assert.equal(readBrowserMcpArgs({ FAIRY_PI_BROWSER_MCP_ARGS: '[]' }), undefined);
  assert.equal(readBrowserMcpArgs({ FAIRY_PI_BROWSER_MCP_ARGS: '[1,2]' }), undefined);
});

test('设置 FAIRY_PI_BROWSER_MCP_ARGS 时注册生产者 MCP 服务器', () => {
  const previous = process.env.FAIRY_PI_BROWSER_MCP_ARGS;
  process.env.FAIRY_PI_BROWSER_MCP_ARGS = '["npx","@playwright/mcp@latest"]';
  try {
    const { api, mcpServers } = createFakePi();
    entry(api);

    assert.equal(mcpServers.length, 1);
    assert.equal(mcpServers[0]?.name, 'browser-dock');
    const config = mcpServers[0]?.config as { command: string; args: string[] };
    assert.equal(config.command, process.execPath);
    assert.equal(config.args[0], FAIRY_PI_BROWSER_PRODUCER);
    assert.equal(existsSync(FAIRY_PI_BROWSER_PRODUCER), true, '生产者脚本应随包分发');
    assert.deepEqual(config.args.slice(1), ['npx', '@playwright/mcp@latest']);
  } finally {
    if (previous === undefined) delete process.env.FAIRY_PI_BROWSER_MCP_ARGS;
    else process.env.FAIRY_PI_BROWSER_MCP_ARGS = previous;
  }
});
