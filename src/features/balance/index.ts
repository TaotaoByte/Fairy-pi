/**
 * 功能层：Fairy 余额与当日用量（上游 `dsh-balance-meter` 的 Pi 移植）。
 *
 * 上游由三块组成：纯估算函数、日账累加、以及 `ctx.inject(['webServer'])` 暴露的
 * `/balance-meter` JSON 端点。**Pi 没有 HTTP 端点注册能力**，所以第三块的替代方案是：
 *   - `/fairy-balance` 命令 → `ctx.ui.notify` 的可读摘要（面向人）；
 *   - 同一份数据仍由 `buildFairyBalanceReport()` 产出**字段与上游一致的 JSON**
 *     （面向程序化消费），供后续阶段接 `pi.registerTool` 或写文件时复用；
 *   - 状态行 → `ctx.ui.setStatus`。
 *
 * 触发时机的映射：上游监听 Cordis 的 `session/event` 里 `assistant/message` 且带 usage；
 * Pi 侧对应 `message_end` 且 `message.role === 'assistant'`。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { attachFairySession } from '../../adapters/index.ts';
import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';
import { createBalanceClient, type FairyBalanceClient } from './balance-client.ts';
import {
  createDailyLedger,
  createFileDailyStore,
  type FairyDailyLedger,
  type FairyDailySnapshot,
} from './daily.ts';
import {
  PRICING_MODEL,
  PRICING_SOURCE_URL,
  PRICING_VERIFIED_DATE,
  USD_TO_CNY_ESTIMATE,
  pricingBandForDate,
  toFairyTokenUsage,
  type FairyTokenUsage,
  type PiUsageLike,
} from './pricing.ts';

export {
  BALANCE_TIMEOUT_MS,
  BALANCE_TTL_MS,
  BALANCE_URL,
  createBalanceClient,
} from './balance-client.ts';
export type { FairyBalanceClient, FairyBalanceClientOptions } from './balance-client.ts';
export { DAILY_FILE_NAME, createDailyLedger, createFileDailyStore } from './daily.ts';
export type {
  FairyDailyLedger,
  FairyDailyRecord,
  FairyDailySnapshot,
  FairyDailyStore,
} from './daily.ts';
export {
  PRICING_MODEL,
  PRICING_SOURCE_URL,
  PRICING_VERIFIED_DATE,
  USD_PER_MILLION,
  USD_TO_CNY_ESTIMATE,
  estimateUsageUsd,
  pricingBandForDate,
  toFairyTokenUsage,
  tokenCount,
} from './pricing.ts';
export type { FairyTokenUsage, PiUsageLike, PricingBand } from './pricing.ts';

/** 状态行与命令使用的前缀名。 */
export const FAIRY_BALANCE_STATUS_KEY = 'fairy-balance';
export const FAIRY_BALANCE_COMMAND = 'fairy-balance';

export interface FairyBalanceReport {
  balance: unknown;
  todayTokens: number;
  todayCost: number;
  pricing: {
    model: string;
    verifiedDate: string;
    sourceUrl: string;
    band: string;
    usdToCnyEstimate: number;
    estimateComplete: boolean;
  };
  /** Pi 独有：Pi 按模型目录算出的当日累计费用（USD）。上游无此字段。 */
  providerCostUsd: number;
}

export interface FairyBalanceReportInput {
  balance: unknown;
  snapshot: FairyDailySnapshot;
  at?: Date;
}

/** 产出与上游 `/balance-meter` 响应同构的 JSON（末尾多一个 Pi 独有字段）。 */
export function buildFairyBalanceReport({
  balance,
  snapshot,
  at = new Date(),
}: FairyBalanceReportInput): FairyBalanceReport {
  return {
    balance,
    todayTokens: snapshot.todayTokens,
    todayCost: snapshot.todayCostCny,
    pricing: {
      model: PRICING_MODEL,
      verifiedDate: PRICING_VERIFIED_DATE,
      sourceUrl: PRICING_SOURCE_URL,
      band: pricingBandForDate(at),
      usdToCnyEstimate: USD_TO_CNY_ESTIMATE,
      estimateComplete: snapshot.estimateComplete,
    },
    providerCostUsd: snapshot.record.providerCostUsd ?? 0,
  };
}

export interface AssistantUsage {
  fairy: FairyTokenUsage;
  providerCostUsd?: number;
}

/** 从 Pi 的 `message_end` 消息里取出助手用量。非助手消息返回 undefined。 */
export function readAssistantUsage(message: unknown): AssistantUsage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const candidate = message as {
    role?: string;
    usage?: PiUsageLike & { cost?: { total?: number } };
  };
  if (candidate.role !== 'assistant' || !candidate.usage) return undefined;

  const total = candidate.usage.cost?.total;
  return {
    fairy: toFairyTokenUsage(candidate.usage),
    ...(typeof total === 'number' && Number.isFinite(total) && total >= 0
      ? { providerCostUsd: total }
      : {}),
  };
}

function describeBalance(balance: unknown): string {
  if (typeof balance !== 'object' || balance === null) return '不可用';
  const candidate = balance as { is_available?: boolean; balance_infos?: unknown[] };
  const infos = candidate.balance_infos;
  if (candidate.is_available === false || !Array.isArray(infos) || infos.length === 0) {
    return '不可用（未配置密钥或请求失败）';
  }
  return infos
    .map((info) => {
      const entry = info as { total_balance?: unknown; currency?: unknown };
      return `${String(entry.total_balance ?? '?')} ${String(entry.currency ?? '')}`.trim();
    })
    .join(' / ');
}

export function formatFairyBalanceStatus(snapshot: FairyDailySnapshot): string {
  const prefix = snapshot.estimateComplete ? '' : '≈';
  return `Fairy 今日 ${prefix}¥${snapshot.todayCostCny.toFixed(4)} · ${snapshot.todayTokens} tok`;
}

export function formatFairyBalanceSummary(report: FairyBalanceReport): string {
  return [
    `Fairy 余额：${describeBalance(report.balance)}`,
    `今日用量：${report.todayTokens} tok`,
    `费用估算：≈¥${report.todayCost.toFixed(4)}（${report.pricing.model} ${report.pricing.verifiedDate}，当前档位 ${report.pricing.band}）`,
    ...(report.providerCostUsd > 0
      ? [`Pi 记账：$${report.providerCostUsd.toFixed(6)} 等值 ¥${(report.providerCostUsd * report.pricing.usdToCnyEstimate).toFixed(4)}`]
      : []),
    ...(report.pricing.estimateComplete ? [] : ['注意：存在未按当前单价表重算的历史用量，估算不完整']),
  ].join('\n');
}

async function readProviderApiKey(
  ctx: ExtensionContext,
  provider: string,
  diagnostics: FairyDiagnostics,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider(provider);
  } catch (error) {
    diagnostics.warn('balance.credentials', { provider }, error);
    return undefined;
  }
}

function updateStatus(
  ctx: ExtensionContext,
  snapshot: FairyDailySnapshot,
  statusKey: string,
): void {
  if (ctx.mode !== 'tui') return;
  ctx.ui.setStatus(statusKey, formatFairyBalanceStatus(snapshot));
}

export interface FairyBalanceOptions {
  /** 日账与其它 Fairy 状态的目录（由调用方给，默认应是 Fairy 自己的数据目录）。 */
  dataDir: string;
  diagnostics?: FairyDiagnostics;
  /** 取密钥的供应商 id，默认 `deepseek`。 */
  provider?: string;
  balanceUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  statusKey?: string;
}

/**
 * 注册 balance-meter 的三个观测点。只调用一次；重复调用会叠加 `message_end` 订阅。
 */
export function applyFairyBalance(pi: ExtensionAPI, options: FairyBalanceOptions): void {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-balance');
  const now = options.now ?? (() => new Date());
  const statusKey = options.statusKey ?? FAIRY_BALANCE_STATUS_KEY;
  const provider = options.provider ?? 'deepseek';

  const ledger: FairyDailyLedger = createDailyLedger({
    store: createFileDailyStore(options.dataDir),
    diagnostics,
    now,
  });

  // 上游把客户端挂在 `ctx.effect` 上，随插件实例销毁；Pi 侧对应会话作用域。
  let client: FairyBalanceClient | undefined;
  attachFairySession(pi, {
    diagnostics,
    label: 'fairy-balance',
    onStart: (scope, ctx) => {
      ledger.load();
      client = createBalanceClient({
        resolveApiKey: () => readProviderApiKey(ctx, provider, diagnostics),
        diagnostics,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.balanceUrl ? { balanceUrl: options.balanceUrl } : {}),
      });
      scope.register('balance-client', () => {
        client?.dispose();
        client = undefined;
      });
      diagnostics.info('enable', { dataDir: options.dataDir, provider });
    },
  });

  pi.on('message_end', (event, ctx) => {
    const usage = readAssistantUsage(event.message);
    if (!usage) return;
    ledger.record(usage.fairy, now(), usage.providerCostUsd);
    updateStatus(ctx, ledger.snapshot(), statusKey);
  });

  pi.registerCommand(FAIRY_BALANCE_COMMAND, {
    description: '查询 Fairy 余额与当日用量估算',
    handler: async (_args, ctx) => {
      ledger.rollDay(now());
      const balance = client ? await client.getBalance() : { is_available: false };
      const snapshot = ledger.snapshot();
      const report = buildFairyBalanceReport({ balance, snapshot, at: now() });
      updateStatus(ctx, snapshot, statusKey);
      const available =
        typeof report.balance === 'object'
        && report.balance !== null
        && (report.balance as { is_available?: boolean }).is_available !== false;
      ctx.ui.notify(formatFairyBalanceSummary(report), available ? 'info' : 'warning');
    },
  });
}
