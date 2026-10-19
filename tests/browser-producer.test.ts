/**
 * 浏览器坞生产者的集成测试。
 *
 * 真的 spawn 两个进程（代理 + 假的 MCP 服务器）并用 JSON-RPC 驱动，验证：
 * 逐行原样转发、状态发布、任意工具结果里的图片落成帧文件、人机验证判定、
 * 以及 `command.json` 的 takeover / close 语义与收场清理。
 *
 * 之所以用真进程而不是桩：代理的价值就在「对协议透明」，只有真起管道才能证明它。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const PRODUCER = fileURLToPath(new URL('../src/features/browser/dock-producer.cjs', import.meta.url));
const FAKE_MCP = fileURLToPath(new URL('./fixtures/fake-mcp.cjs', import.meta.url));

interface ProducerHarness {
  child: ReturnType<typeof spawn>;
  stdoutLines: string[];
  responses: Map<unknown, Record<string, unknown>>;
  write(value: unknown): void;
  waitForResponse(id: number): Promise<Record<string, unknown>>;
  state(): Record<string, unknown>;
  paths: { runtimeDir: string; stateFile: string; commandFile: string };
  stop(): Promise<void>;
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function startProducer(directory: string): Promise<ProducerHarness> {
  const runtimeDir = join(directory, 'browser-dock');
  const stateFile = join(runtimeDir, 'state.json');
  const commandFile = join(runtimeDir, 'command.json');

  const child = spawn(process.execPath, [PRODUCER, process.execPath, FAKE_MCP], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      FAIRY_PI_DATA_DIR: directory,
      // 上游是 5 秒兜底复查；测试压到 60ms，语义不变。
      FAIRY_PI_DOCK_RESCAN_MS: '60',
    },
  });

  const stdoutLines: string[] = [];
  const responses = new Map<unknown, Record<string, unknown>>();
  const waiters = new Map<unknown, () => void>();

  let buffer = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      stdoutLines.push(line);
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.id !== undefined && (parsed.result !== undefined || parsed.error !== undefined)) {
          responses.set(parsed.id, parsed);
          waiters.get(parsed.id)?.();
        }
      } catch {
        // 非 JSON 行不会出现在本协议里，忽略。
      }
      index = buffer.indexOf('\n');
    }
  });

  const harness: ProducerHarness = {
    child,
    stdoutLines,
    responses,
    paths: { runtimeDir, stateFile, commandFile },
    write(value: unknown) {
      child.stdin?.write(`${JSON.stringify(value)}\n`);
    },
    async waitForResponse(id: number) {
      if (!responses.has(id)) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`未收到响应 id=${id}`)), 8_000);
          waiters.set(id, () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return responses.get(id)!;
    },
    state() {
      return JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    },
    async stop() {
      // 已经退出的进程不会再发 exit 事件；无条件再等一次会永久挂住。
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };

  await waitFor(() => existsSync(stateFile), '代理写出初始状态');
  return harness;
}

test('生产者：转发透明、状态发布、抓帧、人机验证、命令与收场', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-producer-'));
  const harness = await startProducer(directory);
  try {
    // 初始状态：活但未就绪
    const initial = harness.state();
    assert.equal(initial.active, true);
    assert.equal(initial.status, 'starting');
    assert.equal(initial.revision, 1);

    // 1) 透明转发：请求 id 原样回来
    harness.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    const initialized = await harness.waitForResponse(1);
    const serverInfo = (initialized.result as { serverInfo?: { name?: string } }).serverInfo;
    assert.equal(serverInfo?.name, 'fake-mcp');

    // 2) 图片结果 → 帧文件 + url/title 尽力而为
    harness.write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'shot', arguments: {} } });
    await harness.waitForResponse(2);
    await waitFor(() => harness.state().frameRevision === 1, '帧计数更新');

    const afterShot = harness.state();
    assert.equal(afterShot.status, 'ready');
    assert.equal(afterShot.lastTool, 'shot');
    assert.equal(afterShot.url, 'https://example.com/page');
    assert.equal(afterShot.title, '示例页');
    assert.equal(afterShot.error, null);
    const frame = join(harness.paths.runtimeDir, 'frame-1.jpg');
    assert.equal(existsSync(frame), true);
    assert.equal(readFileSync(frame).toString('utf8'), 'JPEGDATA');

    // 3) 工具名命中人机验证 → 请求接管
    harness.write({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'need-login', arguments: {} } });
    await harness.waitForResponse(3);
    await waitFor(() => harness.state().takeoverAvailable === true, '标记需要接管');
    assert.equal(harness.state().takeoverConsumed, false);

    // 4) 参数命中同一正则也算
    harness.write({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'echo-args', arguments: { note: '请输入验证码' } },
    });
    await harness.waitForResponse(4);
    assert.equal(harness.state().takeoverAvailable, true);

    // 5) 失败结果 → status error
    harness.write({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom', arguments: {} } });
    await harness.waitForResponse(5);
    await waitFor(() => harness.state().status === 'error', '错误状态');
    assert.equal(harness.state().error, 'tool-error');

    // 6) takeover 命令：消费掉接管标记
    writeFileSync(
      harness.paths.commandFile,
      JSON.stringify({ action: 'takeover', revision: harness.state().revision, nonce: 'n-1' }),
      'utf8',
    );
    await waitFor(() => harness.state().takeoverConsumed === true, 'takeover 生效');

    // 7) close 命令：进程退出并清场（state/command/帧都不留）
    const exited = new Promise<number | null>((resolve) => harness.child.once('exit', resolve));
    writeFileSync(harness.paths.commandFile, JSON.stringify({ action: 'close', reason: 'test', nonce: 'n-2' }), 'utf8');
    assert.equal(await exited, 0);
    assert.equal(existsSync(harness.paths.stateFile), false);
    assert.equal(existsSync(harness.paths.commandFile), false);
    assert.equal(existsSync(frame), false);

    // 8) 转发是逐行的：所有响应都能在代理 stdout 里找到
    assert.equal(harness.stdoutLines.length >= 5, true);
    for (const id of [1, 2, 3, 4, 5]) {
      assert.ok(
        harness.stdoutLines.some((line) => line.includes(`"id":${id}`)),
        `id=${id} 的响应应被原样转发`,
      );
    }
  } finally {
    await harness.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('生产者：没有目标命令时立刻以退出码 2 失败', async () => {
  const child = spawn(process.execPath, [PRODUCER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FAIRY_PI_DATA_DIR: mkdtempSync(join(tmpdir(), 'fairy-producer-')) },
  });
  const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
  assert.equal(code, 2);
});

test('生产者：不写 stdout 的日志（只写 stderr）', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-producer-'));
  const harness = await startProducer(directory);
  try {
    harness.write({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ping', arguments: {} } });
    await harness.waitForResponse(1);
    await waitFor(() => harness.state().lastTool === 'ping', '状态更新');

    for (const line of harness.stdoutLines) {
      assert.equal(line.includes('DSH_FAIRY_LOG'), false, 'stdout 必须是纯 JSON-RPC');
      assert.doesNotThrow(() => JSON.parse(line), `stdout 行必须是 JSON：${line}`);
    }
  } finally {
    await harness.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('生产者：目标进程退出后收场并清理', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-producer-'));
  const harness = await startProducer(directory);
  try {
    harness.write({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shot', arguments: {} } });
    await harness.waitForResponse(1);
    await waitFor(() => harness.state().frameRevision === 1, '帧文件已写');

    // 让目标 MCP 自己退出：代理必须收场并清掉状态、命令与帧。
    // （不用 SIGTERM：Windows 上信号无法被捕获，那条路径只在 POSIX 成立。）
    const exited = new Promise<number | null>((resolve) => harness.child.once('exit', resolve));
    harness.write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bye', arguments: {} } });

    assert.equal(await exited, 0);
    assert.equal(existsSync(harness.paths.stateFile), false);
    assert.equal(existsSync(harness.paths.commandFile), false);
    assert.equal(existsSync(join(harness.paths.runtimeDir, 'frame-1.jpg')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
