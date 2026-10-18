/**
 * balance-meter 移植单测。
 *
 * 覆盖三层：纯估算（与上游同数字）、日账（含跨日/换版/落盘失败去重）、
 * 以及端到端的 `applyFairyBalance`（假 `ExtensionAPI` + 假 `fetch`，含密钥不外泄）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAIRY_LOG_PREFIX, createFairyDiagnostics } from '../src/contracts/index.ts';
import type { FairyLogRecord } from '../src/contracts/index.ts';
import {
  DAILY_FILE_NAME,
  FAIRY_BALANCE_COMMAND,
  buildFairyBalanceReport,
  createBalanceClient,
  createDailyLedger,
  createFileDailyStore,
  estimateUsageUsd,
  formatFairyBalanceStatus,
  formatFairyBalanceSummary,
  pricingBandForDate,
  readAssistantUsage,
  toFairyTokenUsage,
  applyFairyBalance,
} from '../src/features/balance/index.ts';
import type { FairyDailyStore } from '../src/features/balance/index.ts';

const WEEKDAY_PEAK = '2024-01-01T02:00:00.000Z'; // 周一 02:00 UTC
const WEEKDAY_OFF_PEAK = '2024-01-01T10:00:00.000Z';
const SATURDAY_PEAK_HOUR = '2024-01-06T02:00:00.000Z';

function createTestDiagnostics(moduleName = 'fairy-pi-test') {
  const records: FairyLogRecord[] = [];
  const lines: string[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      const line = String(args[0]);
      lines.push(line);
      if (!line.startsWith(`${FAIRY_LOG_PREFIX} `)) return;
      records.push(JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as FairyLogRecord);
    };
  const sink = { info: collect(), log: collect(), warn: collect(), error: collect() };
  return {
    diagnostics: createFairyDiagnostics(moduleName, { sink }),
    records,
    lines,
    text: () => lines.join('\n'),
  };
}

function createMemoryStore(initial?: unknown, onSave?: (record: unknown) => void): FairyDailyStore {
  let data: unknown = initial;
  return {
    load: () => data,
    save: (record) => {
      onSave?.(record);
      data = record;
    },
  };
}

test('峰谷档位按 UTC 工作日的两个窗口判定', () => {
  assert.equal(pricingBandForDate(WEEKDAY_PEAK), 'peak');
  assert.equal(pricingBandForDate(WEEKDAY_OFF_PEAK), 'offPeak');
  assert.equal(pricingBandForDate(SATURDAY_PEAK_HOUR), 'offPeak');
  assert.equal(pricingBandForDate('2024-01-01T00:59:00.000Z'), 'offPeak');
  assert.equal(pricingBandForDate('2024-01-01T01:00:00.000Z'), 'peak');
  assert.equal(pricingBandForDate('2024-01-01T03:59:00.000Z'), 'peak');
  assert.equal(pricingBandForDate('2024-01-01T04:00:00.000Z'), 'offPeak');
  assert.equal(pricingBandForDate('2024-01-01T05:59:00.000Z'), 'offPeak');
  assert.equal(pricingBandForDate('2024-01-01T06:00:00.000Z'), 'peak');
  assert.equal(pricingBandForDate('2024-01-01T09:59:00.000Z'), 'peak');
  assert.equal(pricingBandForDate('2024-01-01T10:00:00.000Z'), 'offPeak');
  assert.equal(pricingBandForDate(new Date('invalid')), 'offPeak');
});

test('估算公式与上游一致（非峰值 0.007/0.22/0.66，峰值 0.014/0.44/1.32）', () => {
  assert.equal(
    estimateUsageUsd({ cacheReadTokens: 1_000_000 }, WEEKDAY_OFF_PEAK),
    0.007,
  );
  assert.equal(estimateUsageUsd({ inputTokens: 1_000_000 }, WEEKDAY_OFF_PEAK), 0.22);
  assert.equal(estimateUsageUsd({ outputTokens: 1_000_000 }, WEEKDAY_OFF_PEAK), 0.66);
  assert.equal(estimateUsageUsd({ inputTokens: 1_000_000 }, WEEKDAY_PEAK), 0.44);
  assert.equal(
    estimateUsageUsd({ outputTokens: 1_000_000 }, WEEKDAY_PEAK),
    1.32,
  );
  // cacheWrite 计入 cacheMiss 档（与上游 inputTokens 同价）。
  assert.equal(estimateUsageUsd({ cacheWriteTokens: 1_000_000 }, WEEKDAY_OFF_PEAK), 0.22);
  assert.equal(estimateUsageUsd(undefined, WEEKDAY_OFF_PEAK), 0);
});

test('Pi 用量映射到上游形状，非法值归零', () => {
  assert.deepEqual(toFairyTokenUsage({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }), {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
  });
  assert.deepEqual(toFairyTokenUsage(undefined), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.deepEqual(toFairyTokenUsage({ input: -5, output: Number.NaN, cacheRead: 3.9 }), {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 3,
    cacheWriteTokens: 0,
  });
});

test('message_end 只从助手消息里取用量', () => {
  assert.equal(readAssistantUsage({ role: 'user', usage: { input: 1 } }), undefined);
  assert.equal(readAssistantUsage({ role: 'assistant' }), undefined);
  assert.equal(readAssistantUsage(null), undefined);

  const parsed = readAssistantUsage({
    role: 'assistant',
    usage: { input: 100, output: 50, cacheRead: 900, cacheWrite: 10, cost: { total: 0.0032 } },
  });
  assert.deepEqual(parsed?.fairy, {
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 900,
    cacheWriteTokens: 10,
  });
  assert.equal(parsed?.providerCostUsd, 0.0032);

  const withoutCost = readAssistantUsage({ role: 'assistant', usage: { input: 1 } });
  assert.equal(withoutCost?.providerCostUsd, undefined);
});

test('日账累加、快照与跨日归零', () => {
  const { diagnostics } = createTestDiagnostics();
  const saves: unknown[] = [];
  let clock = new Date('2024-01-01T10:00:00.000Z');

  const ledger = createDailyLedger({
    store: createMemoryStore(undefined, (record) => saves.push(record)),
    diagnostics,
    now: () => clock,
  });

  ledger.load();
  ledger.record(
    { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    clock,
  );
  const first = ledger.snapshot();
  assert.equal(first.todayTokens, 1_000_000);
  assert.equal(first.todayCostCny, 0.22 * 7.2);
  assert.equal(first.estimateComplete, true);

  ledger.record(
    { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    clock,
    0.001,
  );
  const second = ledger.snapshot();
  assert.equal(second.todayTokens, 2_000_000);
  assert.equal(Number(second.todayCostCny.toFixed(6)), Number((0.22 * 7.2 + 0.66 * 7.2).toFixed(6)));
  assert.equal(second.record.providerCostUsd, 0.001);
  assert.equal(saves.length, 2);

  clock = new Date('2024-01-02T10:00:00.000Z');
  ledger.rollDay(clock);
  const third = ledger.snapshot();
  assert.equal(third.todayTokens, 0);
  assert.equal(third.todayCostCny, 0);
  assert.equal(third.record.date, '2024-01-02');
  assert.equal(third.record.providerCostUsd, undefined);
  assert.equal(saves.length, 3);

  ledger.rollDay(clock);
  assert.equal(saves.length, 3, '同一日重复 rollDay 不应再落盘');
});

test('日账载入：跨日不继承，换单价版本则重算并标记不完整', () => {
  const { diagnostics } = createTestDiagnostics();

  const sameDay = createDailyLedger({
    store: createMemoryStore({
      date: '2024-01-01',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 0.2,
      estimateComplete: true,
      pricingVersion: 'deepseek-v4-flash-2026-08-26',
    }),
    diagnostics,
    now: () => new Date('2024-01-01T10:00:00.000Z'),
  });
  sameDay.load();
  assert.equal(sameDay.snapshot().todayCostCny, 0.2 * 7.2);

  const crossDay = createDailyLedger({
    store: createMemoryStore({
      date: '2023-12-31',
      inputTokens: 999,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 5,
      estimateComplete: true,
      pricingVersion: 'deepseek-v4-flash-2026-08-26',
    }),
    diagnostics,
    now: () => new Date('2024-01-01T10:00:00.000Z'),
  });
  crossDay.load();
  assert.equal(crossDay.snapshot().todayTokens, 0);

  const restated = createDailyLedger({
    store: createMemoryStore({
      date: '2024-01-01',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: 99,
      estimateComplete: true,
      pricingVersion: 'deepseek-v4-flash-OLD',
    }),
    diagnostics,
    now: () => new Date('2024-01-01T10:00:00.000Z'),
  });
  restated.load();
  const snapshot = restated.snapshot();
  assert.equal(snapshot.todayCostCny, 0.22 * 7.2);
  assert.equal(snapshot.estimateComplete, false);
});

test('日账落盘失败按错误签名去重上报', () => {
  const { diagnostics, records } = createTestDiagnostics();
  let attempt = 0;
  const ledger = createDailyLedger({
    store: {
      load: () => undefined,
      save: () => {
        attempt += 1;
        const error = new Error('disk-full') as Error & { code?: string };
        error.code = 'ENOSPC';
        throw error;
      },
    },
    diagnostics,
    now: () => new Date('2024-01-01T10:00:00.000Z'),
  });

  const usage = { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  ledger.record(usage);
  ledger.record(usage);
  ledger.record(usage);

  assert.equal(attempt, 3);
  const failures = records.filter((record) => record.level === 'error');
  assert.equal(failures.length, 1, '相同错误签名只应上报一次');
  assert.equal(failures[0]?.error?.name, 'Error');
});

test('日账文件实现：往返读取，缺文件返回 undefined', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-daily-'));
  try {
    const store = createFileDailyStore(directory);
    assert.equal(store.load(), undefined);

    const record = {
      date: '2024-01-01',
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      estimatedCostUsd: 0.5,
      estimateComplete: true,
      pricingVersion: 'deepseek-v4-flash-2026-08-26',
    };
    store.save(record);
    assert.deepEqual(store.load(), record);
    assert.equal(readFileSync(join(directory, DAILY_FILE_NAME), 'utf8'), JSON.stringify(record));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('余额客户端：命中 TTL 缓存、合并同刻请求、失败退化为不可用', async () => {
  const { diagnostics } = createTestDiagnostics();
  let calls = 0;
  let clock = 0;
  const payload = { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] };

  const client = createBalanceClient({
    resolveApiKey: () => 'sk-unit-test',
    diagnostics,
    fetchImpl: (async () => {
      calls += 1;
      return { ok: true, json: async () => payload } as unknown as Response;
    }) as unknown as typeof fetch,
    now: () => clock,
  });

  const [first, second] = await Promise.all([client.getBalance(), client.getBalance()]);
  assert.deepEqual(first, payload);
  assert.deepEqual(second, payload);
  assert.equal(calls, 1, '同刻请求应合并为一次 fetch');

  clock = 59_000;
  await client.getBalance();
  assert.equal(calls, 1, 'TTL 内应命中缓存');

  clock = 61_000;
  await client.getBalance();
  assert.equal(calls, 2, 'TTL 外应重新拉取');
  client.dispose();
});

test('余额客户端：无密钥、非 2xx 都退化为不可用，且不泄漏密钥', async () => {
  const { diagnostics, text } = createTestDiagnostics();
  const secret = 'sk-must-not-appear';

  const noKey = createBalanceClient({
    resolveApiKey: () => undefined,
    diagnostics,
    fetchImpl: (async () => {
      throw new Error('不该被调用');
    }) as unknown as typeof fetch,
  });
  assert.deepEqual(await noKey.getBalance(), { is_available: false });

  const notOk = createBalanceClient({
    resolveApiKey: async () => secret,
    diagnostics,
    fetchImpl: (async () => ({ ok: false, status: 401 }) as unknown as Response) as unknown as typeof fetch,
  });
  assert.deepEqual(await notOk.getBalance(), { is_available: false });

  assert.equal(text().includes(secret), false, '日志不得包含密钥');
});

test('余额客户端：超时告警、被动 dispose 不告警、metric 带 aborted', async () => {
  const { diagnostics, records } = createTestDiagnostics();

  const hangingFetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        const error = new Error('aborted') as Error & { name: string };
        error.name = 'AbortError';
        reject(error);
      };
      // 信号可能在本桩被调用前就已 abort（dispose 早于 await 链恢复），必须立刻失败。
      if (init.signal?.aborted) {
        fail();
        return;
      }
      init.signal?.addEventListener('abort', fail);
    })) as unknown as typeof fetch;

  const timeoutClient = createBalanceClient({
    resolveApiKey: () => 'sk-x',
    diagnostics,
    fetchImpl: hangingFetch,
    timeoutMs: 5,
  });
  assert.deepEqual(await timeoutClient.getBalance(), { is_available: false });
  const timeoutWarnings = records.filter(
    (record) => record.level === 'warn' && record.operation === 'balance.fetch',
  );
  assert.equal(timeoutWarnings.length, 1);
  assert.equal((timeoutWarnings[0]?.context as { reason?: string }).reason, 'timeout');

  const disposed = createBalanceClient({
    resolveApiKey: () => 'sk-x',
    diagnostics,
    fetchImpl: hangingFetch,
    timeoutMs: 60_000,
  });
  const pending = disposed.getBalance();
  disposed.dispose();
  disposed.dispose();
  assert.deepEqual(await pending, { is_available: false });

  const metrics = records.filter((record) => record.event === 'metric');
  assert.equal(metrics.length, 2);
  assert.equal((metrics[0]?.context as { aborted?: boolean }).aborted, true);
  assert.equal(
    records.filter((record) => record.level === 'warn').length,
    1,
    '非超时的 abort 不应告警',
  );
});

test('报告与展示格式', () => {
  const { diagnostics } = createTestDiagnostics();
  const ledger = createDailyLedger({
    store: createMemoryStore(),
    diagnostics,
    now: () => new Date(WEEKDAY_OFF_PEAK),
  });
  ledger.load();
  ledger.record({ inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

  const report = buildFairyBalanceReport({
    balance: { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] },
    snapshot: ledger.snapshot(),
    at: new Date(WEEKDAY_OFF_PEAK),
  });

  assert.equal(report.todayTokens, 1_000_000);
  assert.equal(report.todayCost, 0.22 * 7.2);
  assert.equal(report.pricing.model, 'deepseek-v4-flash');
  assert.equal(report.pricing.verifiedDate, '2026-08-26');
  assert.equal(report.pricing.band, 'offPeak');
  assert.equal(report.pricing.usdToCnyEstimate, 7.2);
  assert.equal(report.pricing.estimateComplete, true);
  assert.equal(report.providerCostUsd, 0);

  const summary = formatFairyBalanceSummary(report);
  assert.match(summary, /Fairy 余额：110\.00 CNY/);
  assert.match(summary, /今日用量：1000000 tok/);
  assert.match(summary, /deepseek-v4-flash 2026-08-26，当前档位 offPeak/);

  assert.equal(formatFairyBalanceStatus(ledger.snapshot()), 'Fairy 今日 ¥1.5840 · 1000000 tok');

  const unavailable = formatFairyBalanceSummary(
    buildFairyBalanceReport({ balance: { is_available: false }, snapshot: ledger.snapshot() }),
  );
  assert.match(unavailable, /不可用（未配置密钥或请求失败）/);
  assert.doesNotMatch(unavailable, /Pi 记账/, '本次用量没有 provider 费用时不应出现该行');
});

// ---------- 端到端：applyFairyBalance ----------

interface FakePi {
  api: ExtensionAPI;
  commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  dispatch: (event: string, payload: Record<string, unknown>, ctx?: ExtensionContext) => Promise<void>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      return () => {};
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) {
      commands.set(name, options);
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    async dispatch(event, payload, ctx) {
      for (const handler of [...(handlers.get(event) ?? [])]) {
        await handler({ type: event, ...payload }, ctx!);
      }
    },
  };
}

function createFakeContext(sessionId = 's-1', mode: ExtensionContext['mode'] = 'tui') {
  const statuses: Array<[string, string | undefined]> = [];
  const notifications: Array<[string, string]> = [];
  const context = {
    mode,
    hasUI: mode === 'tui',
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { getApiKeyForProvider: async () => 'sk-unit-test' },
    ui: {
      setStatus: (key: string, value: string | undefined) => {
        statuses.push([key, value]);
      },
      notify: (message: string, type: string) => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  return { context, statuses, notifications };
}

test('applyFairyBalance：累加用量、更新状态行、命令输出摘要', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-balance-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, commands, dispatch } = createFakePi();
    const clock = new Date(WEEKDAY_OFF_PEAK);

    applyFairyBalance(api, {
      dataDir: directory,
      diagnostics,
      now: () => clock,
      fetchImpl: (async () => ({
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }] }),
      })) as unknown as typeof fetch,
    });

    const { context, statuses, notifications } = createFakeContext();
    await dispatch('session_start', { reason: 'startup' }, context);

    await dispatch(
      'message_end',
      { message: { role: 'assistant', usage: { input: 1_000_000, output: 0, cost: { total: 0.5 } } } },
      context,
    );
    await dispatch('message_end', { message: { role: 'user' } }, context);

    assert.deepEqual(statuses, [['fairy-balance', 'Fairy 今日 ¥1.5840 · 1000000 tok']]);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, DAILY_FILE_NAME), 'utf8')),
      {
        date: '2024-01-01',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.22,
        estimateComplete: true,
        pricingVersion: 'deepseek-v4-flash-2026-08-26',
        providerCostUsd: 0.5,
      },
    );

    const command = commands.get(FAIRY_BALANCE_COMMAND);
    assert.ok(command, '`/fairy-balance` 应已注册');
    await command!.handler('', context);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.[1], 'info');
    assert.match(notifications[0]?.[0] ?? '', /Fairy 余额：110\.00 CNY/);
    assert.match(notifications[0]?.[0] ?? '', /Pi 记账：\$0\.500000/);

    const { context: headless, statuses: headlessStatuses } = createFakeContext('s-2', 'json');
    await dispatch('session_start', { reason: 'startup' }, headless);
    await dispatch(
      'message_end',
      { message: { role: 'assistant', usage: { input: 1, output: 0 } } },
      headless,
    );
    assert.deepEqual(headlessStatuses, [], '非 tui 模式不应改状态行');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
