/**
 * 契约层回归测试。
 *
 * 目的：锁定与 Fairy-DSH 上游 `fairy-contracts` 的逐项一致性。
 * 任何一条断言失败都意味着两侧契约已经分叉，必须先判断是上游变更还是移植错误。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_LOG_PREFIX,
  FAIRY_LOG_SCHEMA_VERSION,
  FAIRY_VISUAL_ACTIVITY,
  FAIRY_VISUAL_LIFECYCLE,
  FAIRY_VISUAL_POWER_MODES,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
  FAIRY_VISUAL_THEMES,
  FAIRY_VOICE_CONTROL_ATTRIBUTE,
  createFairyDiagnostics,
  normalizeFairyError,
} from '../src/contracts/index.ts';
import type { FairyDiagnosticsSink } from '../src/contracts/index.ts';

const EXPECTED_LIFECYCLE = [
  'idle',
  'preparing',
  'running',
  'interrupted',
  'completed',
  'failed',
  'disposed',
];

interface FakeSink {
  lines: string[];
  sink: FairyDiagnosticsSink;
}

function createFakeSink(): FakeSink {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      info: (...args) => lines.push(String(args[0])),
      warn: (...args) => lines.push(String(args[0])),
      error: (...args) => lines.push(String(args[0])),
    },
  };
}

function parseLine(line: string): Record<string, unknown> {
  assert.ok(line.startsWith(`${FAIRY_LOG_PREFIX} `), `日志必须以前缀开头，实际为: ${line}`);
  return JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as Record<string, unknown>;
}

test('命名空间与 schema 版本与上游一致', () => {
  assert.equal(FAIRY_VISUAL_SETTINGS_NAMESPACE, 'fairy-visual');
  assert.equal(FAIRY_IDENTITY_SETTINGS_NAMESPACE, 'fairy-identity');
  assert.equal(FAIRY_VISUAL_SETTINGS_VERSION, 2);
});

test('词汇表字面量与顺序与上游一致', () => {
  assert.deepEqual([...FAIRY_VISUAL_THEMES], ['dark', 'light']);
  assert.deepEqual([...FAIRY_VISUAL_POWER_MODES], ['normal', 'low-power']);
  assert.deepEqual([...FAIRY_VISUAL_ACTIVITY], ['normal', 'thinking', 'comforting']);
  assert.deepEqual([...FAIRY_VISUAL_LIFECYCLE], EXPECTED_LIFECYCLE);
});

test('日志前缀与日志 schema 版本与上游一致', () => {
  assert.equal(FAIRY_LOG_PREFIX, 'DSH_FAIRY_LOG');
  assert.equal(FAIRY_LOG_SCHEMA_VERSION, 1);
});

test('上游 DOM 控制属性保留原字面量', () => {
  assert.equal(FAIRY_VOICE_CONTROL_ATTRIBUTE, 'data-dsh-fairy-voice-control');
});

test('normalizeFairyError 规范化字段并截断超长消息', () => {
  assert.equal(normalizeFairyError(null), undefined);
  assert.equal(normalizeFairyError(undefined), undefined);

  const named = normalizeFairyError(Object.assign(new Error('boom'), { code: 'EFAIL' }));
  assert.deepEqual(named, { name: 'Error', code: 'EFAIL', message: 'boom' });

  const plain = normalizeFairyError('just a string');
  assert.equal(plain?.name, 'Error');
  assert.equal(plain?.message, 'just a string');
  assert.equal(plain?.code, undefined);

  const long = normalizeFairyError('x'.repeat(400));
  assert.equal(long?.message.length, 321);
  assert.ok(long?.message.endsWith('…'));
});

test('诊断输出为结构化单行并带 schema 与模块名', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', {
    sink,
    wallClock: () => '2026-01-02T03:04:05.000Z',
  });

  const record = diagnostics.info('unit.info', { ok: true });
  assert.equal(lines.length, 1);
  const parsed = parseLine(lines[0]);
  assert.deepEqual(parsed, record);
  assert.equal(parsed.schema, 1);
  assert.equal(parsed.timestamp, '2026-01-02T03:04:05.000Z');
  assert.equal(parsed.level, 'info');
  assert.equal(parsed.module, 'fairy-test');
  assert.equal(parsed.operation, 'unit.info');
  assert.equal(parsed.event, 'event');
  assert.deepEqual(parsed.context, { ok: true });
});

test('敏感键被脱敏且不下沉到嵌套层级', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink });

  diagnostics.warn('unit.redact', {
    token: 'abcdef',
    nested: { authorization: 'Bearer x', api_key: 'k', safe: 'keep' },
  });

  const parsed = parseLine(lines[0]);
  assert.deepEqual(parsed.context, {
    token: '[redacted]',
    nested: { authorization: '[redacted]', api_key: '[redacted]', safe: 'keep' },
  });
});

test('超长字符串被截断、嵌套深度被限制', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink });

  diagnostics.info('unit.truncate', {
    long: 'y'.repeat(500),
    deep: { a: { b: { c: 'too deep' } } },
  });

  const context = parseLine(lines[0]).context as Record<string, unknown>;
  const long = context.long as string;
  assert.equal(long.length, 321);
  assert.ok(long.endsWith('…'));
  // 上游语义：depth >= 2 时整个子树替换为 '[truncated]'，
  // 因此 { a: { b: { c } } } 在第 2 层被整体截断，而不是只截最内层。
  assert.deepEqual(context.deep, { a: '[truncated]' });
});

test('相同错误在去重窗口内只记录一次', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink, dedupeWindowMs: 60_000 });
  const failure = new Error('same failure');

  const first = diagnostics.error('unit.dedupe', failure);
  const second = diagnostics.error('unit.dedupe', failure);

  assert.ok(first);
  assert.equal(second, null);
  assert.equal(lines.length, 1);
});

test('不同操作即使错误相同也各自记录', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink });
  const failure = new Error('same failure');

  diagnostics.error('unit.opA', failure);
  diagnostics.error('unit.opB', failure);

  assert.equal(lines.length, 2);
});

test('guard 失败时记录并原样抛出', () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink });
  const failure = new Error('guard failure');

  assert.throws(() => diagnostics.guard('unit.guard', () => { throw failure; }), failure);

  const parsed = parseLine(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.equal(parsed.event, 'failure');
  assert.deepEqual(parsed.error, { name: 'Error', message: 'guard failure' });
});

test('guard 成功时返回原值', () => {
  const { sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink, monotonicClock: () => 0 });
  assert.equal(diagnostics.guard('unit.ok', () => 42), 42);
});

test('metric 低于阈值不记录、达到阈值记录耗时', () => {
  const { lines, sink } = createFakeSink();
  let clock = 0;
  const diagnostics = createFairyDiagnostics('fairy-test', {
    sink,
    monotonicClock: () => clock,
  });

  const startedAt = diagnostics.start();
  clock = 50;
  assert.equal(diagnostics.metric('unit.metric', startedAt, {}, { thresholdMs: 100 }), null);
  assert.equal(lines.length, 0);

  clock = 150;
  const record = diagnostics.metric('unit.metric', startedAt, {}, { thresholdMs: 100 });
  assert.ok(record);
  assert.equal(record?.duration_ms, 150);
  assert.equal(record?.event, 'metric');
});

test('guardAsync 失败时记录并拒绝，成功时返回原值', async () => {
  const { lines, sink } = createFakeSink();
  const diagnostics = createFairyDiagnostics('fairy-test', { sink });
  const failure = new Error('async failure');

  await assert.rejects(async () => {
    await diagnostics.guardAsync('unit.async', async () => {
      throw failure;
    });
  }, failure);

  assert.equal(parseLine(lines[0]).event, 'failure');

  const value = await diagnostics.guardAsync('unit.async', async () => 'ok');
  assert.equal(value, 'ok');
});
