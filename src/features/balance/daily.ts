/**
 * 功能层：当日用量账本与落盘。
 *
 * 上游把日账写在 `DSH_HOME/balance-meter-daily.json`，并在内存里维护一份计数器：
 * 每次收到带 usage 的助手消息就累加并落盘，跨本地日期时归零。
 * Pi 侧保持全部数值语义不变，只把「文件」抽象成 `FairyDailyStore` 端口：
 * - `createFileDailyStore()` 是唯一的真实实现，目录由调用方给出（不写 pi 的 agent_data）；
 * - 测试用内存桩，不触碰磁盘。
 *
 * 落盘策略与上游一致：临时文件 + rename 原子替换 + 0600 权限，失败时删除临时文件并
 * 按错误签名去重上报（同一签名只在首次出现时记一条 error）。
 */

import { chmodSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically } from '../../atomic-file.ts';
import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';
import {
  PRICING_VERSION,
  USD_TO_CNY_ESTIMATE,
  estimateUsageUsd,
  tokenCount,
  type FairyTokenUsage,
} from './pricing.ts';

export const DAILY_FILE_NAME = 'balance-meter-daily.json';

export interface FairyDailyRecord {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
  estimateComplete: boolean;
  pricingVersion: string;
  /**
   * Pi 独有：Pi 自己按模型目录算出的当日累计费用（USD），来自 `Usage.cost.total`。
   * 上游没有这个字段（DSH 不提供逐次费用）。它是**额外的**对照量，不参与估算口径。
   */
  providerCostUsd?: number;
}

export interface FairyDailyStore {
  /** 返回已解析的原始内容；文件不存在返回 undefined；其它失败抛错。 */
  load(): unknown;
  save(record: FairyDailyRecord): void;
}

export function createFileDailyStore(directory: string): FairyDailyStore {
  const file = join(directory, DAILY_FILE_NAME);
  return {
    load() {
      try {
        const content = readFileSync(file, 'utf8');
        chmodSync(file, 0o600);
        return JSON.parse(content);
      } catch (error) {
        if ((error as { code?: string })?.code === 'ENOENT') return undefined;
        throw error;
      }
    },
    save(record) {
      const temporary = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
        // Windows 上目标可能正被读取（`/fairy-balance`、外部脚本），rename 会瞬时失败。
        replaceFileAtomically(temporary, file);
        chmodSync(file, 0o600);
      } catch (error) {
        try {
          unlinkSync(temporary);
        } catch (cleanupError) {
          if ((cleanupError as { code?: string })?.code !== 'ENOENT') {
            void cleanupError;
          }
        }
        throw error;
      }
    },
  };
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export interface FairyDailySnapshot {
  record: FairyDailyRecord;
  todayTokens: number;
  /** 人民币估算值（估算美元 × 固定汇率）。 */
  todayCostCny: number;
  estimateComplete: boolean;
}

export interface FairyDailyLedger {
  /** 从存储载入当日账目；失败上报且不抛出。 */
  load(): void;
  /** 本地日期变化时归零并落盘；未跨日则无操作。 */
  rollDay(at?: Date): void;
  /** 累加一次用量并落盘。 */
  record(usage: FairyTokenUsage, at?: Date, providerCostUsd?: number): void;
  snapshot(): FairyDailySnapshot;
}

export interface FairyDailyLedgerOptions {
  store: FairyDailyStore;
  diagnostics?: FairyDiagnostics;
  now?: () => Date;
}

export function createDailyLedger(options: FairyDailyLedgerOptions): FairyDailyLedger {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-balance');
  const now = options.now ?? (() => new Date());

  let todayKey = localDateKey(now());
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let estimatedCostUsd = 0;
  let providerCostUsd = 0;
  let estimateComplete = true;
  let persistenceError: string | null = null;

  const totals = (): FairyTokenUsage => ({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
  });

  const todayTokens = (): number =>
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const reportPersistenceError = (operation: string, error: unknown): void => {
    const signature = `${operation}:${(error as { code?: string; message?: string })?.code
      || (error as { message?: string })?.message
      || 'unknown'}`;
    if (persistenceError === signature) return;
    persistenceError = signature;
    diagnostics.error(`persistence.${operation.replaceAll(' ', '-')}`, error, {
      file: DAILY_FILE_NAME,
    });
  };

  const buildRecord = (): FairyDailyRecord => ({
    date: todayKey,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    estimatedCostUsd,
    estimateComplete,
    pricingVersion: PRICING_VERSION,
    ...(providerCostUsd > 0 ? { providerCostUsd } : {}),
  });

  const save = (): void => {
    try {
      options.store.save(buildRecord());
      persistenceError = null;
    } catch (error) {
      reportPersistenceError('daily usage save', error);
    }
  };

  const rollDay = (at: Date = now()): void => {
    const key = localDateKey(at);
    if (key === todayKey) return;
    todayKey = key;
    inputTokens = 0;
    outputTokens = 0;
    cacheReadTokens = 0;
    cacheWriteTokens = 0;
    estimatedCostUsd = 0;
    providerCostUsd = 0;
    estimateComplete = true;
    save();
  };

  return {
    load() {
      let data: unknown;
      try {
        data = options.store.load();
      } catch (error) {
        reportPersistenceError('daily usage load', error);
        return;
      }
      if (typeof data !== 'object' || data === null) return;
      const stored = data as Record<string, unknown>;
      if (stored.date !== todayKey) return;

      inputTokens = tokenCount(stored.inputTokens);
      outputTokens = tokenCount(stored.outputTokens);
      cacheReadTokens = tokenCount(stored.cacheReadTokens);
      cacheWriteTokens = tokenCount(stored.cacheWriteTokens);

      const storedEstimate = Number(stored.estimatedCostUsd);
      const storedProviderCost = Number(stored.providerCostUsd);
      if (Number.isFinite(storedProviderCost) && storedProviderCost > 0) {
        providerCostUsd = storedProviderCost;
      }

      if (
        stored.pricingVersion === PRICING_VERSION
        && Number.isFinite(storedEstimate)
        && storedEstimate >= 0
      ) {
        estimatedCostUsd = storedEstimate;
        estimateComplete = stored.estimateComplete !== false;
      } else {
        // 单价表已换版：按当前单价重算，并按上游口径标记估算是否完整。
        estimatedCostUsd = estimateUsageUsd(totals(), now());
        estimateComplete = todayTokens() === 0;
      }
    },

    rollDay,

    record(usage, at = now(), provider) {
      rollDay(at);
      const normalized = {
        inputTokens: tokenCount(usage.inputTokens),
        outputTokens: tokenCount(usage.outputTokens),
        cacheReadTokens: tokenCount(usage.cacheReadTokens),
        cacheWriteTokens: tokenCount(usage.cacheWriteTokens),
      };
      inputTokens += normalized.inputTokens;
      outputTokens += normalized.outputTokens;
      cacheReadTokens += normalized.cacheReadTokens;
      cacheWriteTokens += normalized.cacheWriteTokens;
      estimatedCostUsd += estimateUsageUsd(normalized, at);
      if (typeof provider === 'number' && Number.isFinite(provider) && provider > 0) {
        providerCostUsd += provider;
      }
      save();
    },

    snapshot() {
      return {
        record: buildRecord(),
        todayTokens: todayTokens(),
        todayCostCny: estimatedCostUsd * USD_TO_CNY_ESTIMATE,
        estimateComplete,
      };
    },
  };
}
