/**
 * 适配层单测。
 *
 * 用假的 `ExtensionAPI` 桩驱动：适配层不依赖 Pi 进程，只依赖 `pi.on()` 这一个契约，
 * 因此全部行为都能在进程外验证。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAIRY_LOG_PREFIX, createFairyDiagnostics } from '../src/contracts/index.ts';
import type { FairyLogRecord } from '../src/contracts/index.ts';
import type { FairySignal } from '../src/adapters/index.ts';
import {
  FAIRY_EVENT_BINDINGS,
  FAIRY_IDENTITY_SCHEMA,
  FAIRY_VISUAL_SCHEMA,
  attachFairySession,
  bindFairySignals,
  createFairySessionScope,
  createFairySettingsRegistry,
  createMemorySettingsStore,
  describePlatform,
  detectPlatform,
  findFairyBinding,
  normalizePlatform,
  resolveFairyDataDir,
  resolveFairySettings,
} from '../src/adapters/index.ts';

function createTestDiagnostics(moduleName = 'fairy-pi-test') {
  const records: FairyLogRecord[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      const line = String(args[0]);
      if (!line.startsWith(`${FAIRY_LOG_PREFIX} `)) return;
      records.push(JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as FairyLogRecord);
    };
  const sink = {
    info: collect(),
    log: collect(),
    warn: collect(),
    error: collect(),
  };
  return { diagnostics: createFairyDiagnostics(moduleName, { sink }), records };
}

type StubHandler = (event: unknown, ctx: ExtensionContext) => unknown;

function createFakeContext(sessionId = 'session-test'): ExtensionContext {
  return {
    mode: 'tui',
    hasUI: true,
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;
}

function createFakePi() {
  const handlers = new Map<string, StubHandler[]>();
  const live: StubHandler[] = [];
  const api = {
    on(event: string, handler: StubHandler) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      live.push(handler);
      return () => {
        const index = live.indexOf(handler);
        if (index >= 0) live.splice(index, 1);
        const current = handlers.get(event);
        const at = current ? current.indexOf(handler) : -1;
        if (at >= 0) current!.splice(at, 1);
      };
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    subscriptions: () => live.length,
    subscribedEvents: () => [...handlers.keys()],
    async dispatch(event: string, payload: Record<string, unknown> = {}, ctx = createFakeContext()) {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        await handler({ type: event, ...payload }, ctx);
      }
    },
  };
}

test('平台归一化只区分 windows / posix / unknown', () => {
  assert.equal(normalizePlatform('win32'), 'windows');
  assert.equal(normalizePlatform('darwin'), 'posix');
  assert.equal(normalizePlatform('linux'), 'posix');
  assert.equal(normalizePlatform('aix'), 'unknown');
  assert.equal(normalizePlatform(undefined), 'unknown');
});

test('Fairy 数据目录按作用域解析，环境变量优先', () => {
  assert.equal(
    resolveFairyDataDir({ homeDir: 'H', cwd: 'C', env: {} }).replace(/\\/g, '/'),
    'H/.fairy-pi',
  );
  assert.equal(
    resolveFairyDataDir({ scope: 'project', homeDir: 'H', cwd: 'C', env: {} }).replace(/\\/g, '/'),
    'C/.fairy-pi',
  );
  assert.equal(
    resolveFairyDataDir({ scope: 'project', cwd: 'C', env: { FAIRY_PI_DATA_DIR: '  D:\\fairy  ' } })
      .replace(/\\/g, '/'),
    'D:/fairy',
  );
  assert.equal(
    resolveFairyDataDir({ homeDir: 'H', env: { FAIRY_PI_DATA_DIR: '   ' } }).replace(/\\/g, '/'),
    'H/.fairy-pi',
  );
});

test('detectPlatform 描述当前进程且不写全局目录', () => {
  const info = detectPlatform({ homeDir: 'H', env: {} });
  assert.equal(info.isWindows, process.platform === 'win32');
  assert.equal(describePlatform(info), `${info.platform} data=${info.dataDir}`);
  assert.ok(info.dataDir.endsWith('.fairy-pi'));
});

test('事件映射表的信号唯一，生命周期只用上游会发出的三个字面量', () => {
  const signals = FAIRY_EVENT_BINDINGS.map((binding) => binding.signal);
  assert.equal(new Set(signals).size, signals.length);
  for (const binding of FAIRY_EVENT_BINDINGS) {
    assert.ok(binding.piEvent.length > 0, `${binding.signal} 缺少 pi 事件名`);
    if (binding.lifecycle) {
      assert.ok(
        (['idle', 'running', 'completed'] as const).includes(
          binding.lifecycle as 'idle' | 'running' | 'completed',
        ),
        `${binding.signal} 使用了上游不会发出的生命周期字面量`,
      );
    }
  }
  assert.deepEqual(
    FAIRY_EVENT_BINDINGS.filter((binding) => binding.lifecycle).map((binding) => binding.lifecycle),
    ['running', 'completed', 'running', 'idle'],
  );
  assert.equal(findFairyBinding('session:start')?.piEvent, 'session_start');
  assert.equal(findFairyBinding('agent:settled')?.dshSource, '-');
});

test('bindFairySignals 只订阅请求的信号并带上会话上下文', async () => {
  const { diagnostics } = createTestDiagnostics();
  const { api, dispatch, subscribedEvents, subscriptions } = createFakePi();
  const seen: Array<{ signal: string; lifecycle?: string; sessionId?: string; mode: string }> = [];
  const detach = bindFairySignals(
    api,
    (payload) => {
      seen.push({
        signal: payload.signal,
        ...(payload.lifecycle ? { lifecycle: payload.lifecycle } : {}),
        sessionId: payload.session.id,
        mode: payload.session.mode,
      });
    },
    { signals: ['agent:start', 'turn:end'], diagnostics },
  );

  assert.deepEqual(subscribedEvents().sort(), ['agent_start', 'turn_end']);
  await dispatch('agent_start', {}, createFakeContext('s-1'));
  await dispatch('turn_end', {}, createFakeContext('s-1'));
  await dispatch('session_start', { reason: 'startup' });

  assert.deepEqual(seen, [
    { signal: 'agent:start', lifecycle: 'running', sessionId: 's-1', mode: 'tui' },
    { signal: 'turn:end', lifecycle: 'idle', sessionId: 's-1', mode: 'tui' },
  ]);

  detach();
  assert.equal(subscriptions(), 0);
  await dispatch('agent_start');
  assert.equal(seen.length, 2);
});

test('未映射的信号被记警告，处理器抛错不冒泡', async () => {
  const { diagnostics, records } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();
  const detach = bindFairySignals(
    api,
    (payload) => {
      if (payload.signal === 'session:start') throw new Error('handler-exploded');
    },
    { signals: ['session:start', 'agent:start', 'turn:sleep' as unknown as FairySignal], diagnostics },
  );

  await dispatch('session_start', { reason: 'startup' });
  await dispatch('agent_start');

  const warnings = records.filter((record) => record.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.equal((warnings[0]?.context as { reason?: string }).reason, 'unknown-signal');
  assert.equal((warnings[0]?.context as { signal?: string }).signal, 'turn:sleep');

  const errors = records.filter((record) => record.level === 'error');
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.error?.message, 'handler-exploded');

  detach();
});

test('会话作用域逆序拆除且幂等', () => {
  const { diagnostics } = createTestDiagnostics();
  const scope = createFairySessionScope({ diagnostics, label: 'demo' });
  const order: string[] = [];
  scope.register('a', () => order.push('a'));
  scope.register('b', () => order.push('b'));
  const release = scope.register('c', () => order.push('c'));

  release();
  assert.deepEqual(order, ['c']);
  assert.equal(scope.active, true);

  scope.dispose('quit');
  assert.deepEqual(order, ['c', 'b', 'a']);
  assert.equal(scope.active, false);

  scope.dispose('again');
  assert.deepEqual(order, ['c', 'b', 'a']);
});

test('作用域已拆除后再注册会立即拆除并记警告', () => {
  const { diagnostics, records } = createTestDiagnostics();
  const scope = createFairySessionScope({ diagnostics, label: 'demo' });
  scope.dispose('quit');

  let disposed = false;
  const release = scope.register('late', () => {
    disposed = true;
  });

  assert.equal(disposed, true);
  assert.equal(typeof release, 'function');
  release();
  assert.equal(disposed, true);
  assert.ok(
    records.some(
      (record) =>
        record.level === 'warn' && (record.context as { reason?: string }).reason === 'scope-inactive',
    ),
  );
});

test('作用域的错误边界吞掉异常并记录', async () => {
  const { diagnostics, records } = createTestDiagnostics();
  const scope = createFairySessionScope({ diagnostics, label: 'demo' });

  const thrown = await scope.run('boom', () => {
    throw new Error('scope-exploded');
  });
  assert.equal(thrown, undefined);

  const value = await scope.run('ok', async () => 42);
  assert.equal(value, 42);

  const failures = records.filter((record) => record.level === 'error');
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.operation, 'boom');
});

test('attachFairySession 把资源绑定到 session_start / session_shutdown', async () => {
  const { diagnostics, records } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();
  const started: string[] = [];
  const ended: string[] = [];

  const detach = attachFairySession(api, {
    diagnostics,
    label: 'demo',
    onStart: (scope, _ctx, event) => {
      started.push(event.reason);
      scope.register('resource', () => ended.push(`stop:${event.reason}`));
    },
  });

  await dispatch('session_start', { reason: 'startup' });
  assert.deepEqual(started, ['startup']);
  assert.deepEqual(ended, []);

  await dispatch('session_start', { reason: 'reload' });
  assert.deepEqual(started, ['startup', 'reload']);
  assert.deepEqual(ended, ['stop:startup']);

  await dispatch('session_shutdown', { reason: 'quit' });
  assert.deepEqual(ended, ['stop:startup', 'stop:reload']);

  const info = records.filter((record) => record.operation === 'dispose');
  assert.equal(info.length, 2);
  assert.deepEqual(info.map((record) => (record.context as { reason?: string }).reason), [
    'session-restart',
    'quit',
  ]);

  detach();
  assert.equal(typeof detach, 'function');
  await dispatch('session_shutdown', { reason: 'quit' });
  assert.deepEqual(ended, ['stop:startup', 'stop:reload']);
});

test('attachFairySession 的 onStart 抛错不会破坏会话', async () => {
  const { diagnostics, records } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();

  attachFairySession(api, {
    diagnostics,
    label: 'demo',
    onStart: () => {
      throw new Error('startup-exploded');
    },
  });

  await dispatch('session_start', { reason: 'startup' });
  assert.ok(records.some((record) => record.error?.message === 'startup-exploded'));
});

test('设置解析补齐默认值并约束取值范围', () => {
  const empty = resolveFairySettings(FAIRY_VISUAL_SCHEMA, undefined);
  assert.deepEqual(empty.value, {
    version: 2,
    enabled: false,
    theme: 'dark',
    mascotVisible: true,
    mascotScale: 1,
    mascotAnimationSpeed: 1,
    powerMode: 'normal',
    composerDockHeight: 132,
  });
  assert.deepEqual(empty.issues, []);

  const clamped = resolveFairySettings(FAIRY_VISUAL_SCHEMA, {
    mascotScale: 1.5,
    composerDockHeight: 500,
    theme: 'neon',
    enabled: 'yes',
    mascotAnimationSpeed: 1.2,
  });
  assert.equal(clamped.value.mascotScale, 1);
  assert.equal(clamped.value.composerDockHeight, 420);
  assert.equal(clamped.value.theme, 'dark');
  assert.equal(clamped.value.enabled, false);
  assert.equal(clamped.value.mascotAnimationSpeed, 1);
  assert.ok(clamped.issues.includes('mascotScale:above-max'));
  assert.ok(clamped.issues.includes('composerDockHeight:above-max'));
  assert.ok(clamped.issues.includes('theme:not-in-enum'));
  assert.ok(clamped.issues.includes('enabled:not-a-boolean'));
  assert.ok(clamped.issues.includes('mascotAnimationSpeed:not-in-enum'));

  const below = resolveFairySettings(FAIRY_VISUAL_SCHEMA, { mascotScale: 0.4 });
  assert.equal(below.value.mascotScale, 0.55);
  assert.ok(below.issues.includes('mascotScale:below-min'));

  const stepped = resolveFairySettings(FAIRY_VISUAL_SCHEMA, { mascotScale: 0.567 });
  assert.equal(stepped.value.mascotScale, 0.57);
  assert.ok(stepped.issues.includes('mascotScale:rounded-to-step'));
});

test('设置解析丢弃未声明字段并报告版本不一致', () => {
  const result = resolveFairySettings(FAIRY_VISUAL_SCHEMA, { version: 1, future: true });
  assert.equal(result.value.version, 1);
  assert.equal('future' in result.value, false);
  assert.ok(result.issues.includes('unknown:future'));
  assert.ok(result.issues.includes('version:1!=2'));
});

test('身份设置补齐默认值并剔除非字符串家庭成员', () => {
  const defaults = resolveFairySettings(FAIRY_IDENTITY_SCHEMA, undefined);
  assert.deepEqual(defaults.value, {
    mode: 'ling',
    customName: '',
    secondAssistant: '',
    household: [],
  });
  assert.deepEqual(defaults.issues, []);

  const filtered = resolveFairySettings(FAIRY_IDENTITY_SCHEMA, {
    mode: 'witness',
    household: ['甲', 7, '乙'],
  });
  assert.equal(filtered.value.mode, 'ling');
  assert.deepEqual(filtered.value.household, ['甲', '乙']);
  assert.ok(filtered.issues.includes('mode:not-in-enum'));
  assert.ok(filtered.issues.includes('household:dropped-non-string-items'));
});

test('设置注册表提供默认值、纠正写入并对未知命名空间抛错', () => {
  const { diagnostics, records } = createTestDiagnostics();
  const store = createMemorySettingsStore();
  const registry = createFairySettingsRegistry({ store, diagnostics });

  assert.deepEqual(registry.namespaces(), ['fairy-visual', 'fairy-identity']);
  assert.equal(registry.schema('fairy-visual').fields.version?.kind, 'number');
  assert.equal(registry.get<{ theme: string }>('fairy-visual').theme, 'dark');

  const written = registry.set('fairy-visual', {
    mascotScale: 1.5,
    household: ['a'],
  });
  assert.equal(written.mascotScale, 1);
  assert.equal(written.composerDockHeight, 132);
  assert.deepEqual(store.read('fairy-visual'), written);
  assert.equal(registry.get<{ mascotScale: number }>('fairy-visual').mascotScale, 1);

  assert.throws(
    () => registry.get('fairy-unknown'),
    /未注册的设置命名空间: fairy-unknown/,
  );
  assert.ok(records.some((record) => record.operation === 'settings-write'));
});
