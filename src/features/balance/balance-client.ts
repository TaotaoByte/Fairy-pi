/**
 * 功能层：DeepSeek 余额查询。
 *
 * 上游行为 1:1 保留：60s TTL 缓存、同刻请求合并、10s 超时后 abort（reason 为 `timeout`）、
 * 非超时的 abort（例如被 dispose）不告警、失败一律退化为 `{ is_available: false }`、
 * 顺带记录耗时 metric。
 *
 * **唯一的行为改动（安全相关）**：上游从 `DSH_HOME/.credentials.yaml` 里用正则**明文提取**
 * `DEEPSEEK_API_KEY`。Pi 侧不走文件：密钥由 `resolveApiKey` 端口注入，调用方接
 * `ctx.modelRegistry.getApiKeyForProvider(...)`。本模块既不记录密钥、也不把它放进返回值。
 */

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export const BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const BALANCE_TTL_MS = 60_000;
export const BALANCE_TIMEOUT_MS = 10_000;

export interface FairyBalanceClientOptions {
  /** 惰性解析密钥。返回值只用于当次请求头，绝不落日志。 */
  resolveApiKey: () => Promise<string | undefined> | string | undefined;
  fetchImpl?: typeof fetch;
  diagnostics?: FairyDiagnostics;
  balanceUrl?: string;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export interface FairyBalanceClient {
  getBalance(): Promise<unknown>;
  /** 中止在途请求并放开缓存请求槽。幂等。 */
  dispose(): void;
}

export function createBalanceClient(options: FairyBalanceClientOptions): FairyBalanceClient {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-balance');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const balanceUrl = options.balanceUrl ?? BALANCE_URL;
  const ttlMs = options.ttlMs ?? BALANCE_TTL_MS;
  const timeoutMs = options.timeoutMs ?? BALANCE_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  let cachedBalance: unknown = null;
  let cachedAt = 0;
  let inFlight: Promise<unknown> | null = null;
  let activeController: AbortController | null = null;

  const request = async (): Promise<unknown> => {
    const startedAt = diagnostics.start();
    const controller = new AbortController();
    activeController = controller;

    const key = await options.resolveApiKey();
    if (!key) {
      if (activeController === controller) activeController = null;
      return { is_available: false };
    }

    const timeout = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
      const response = await fetchImpl(balanceUrl, {
        headers: { Authorization: `Bearer ${key}` },
        signal: controller.signal,
      });
      if (!response.ok) return { is_available: false };
      cachedBalance = await response.json();
      cachedAt = now();
      return cachedBalance;
    } catch (error) {
      const reason = controller.signal.reason;
      if ((error as { name?: string })?.name !== 'AbortError' || reason === 'timeout') {
        diagnostics.warn('balance.fetch', { reason: reason || 'request-failed' }, error);
      }
      return { is_available: false };
    } finally {
      clearTimeout(timeout);
      diagnostics.metric('balance.fetch', startedAt, { aborted: controller.signal.aborted });
      if (activeController === controller) activeController = null;
    }
  };

  return {
    async getBalance() {
      if (cachedBalance && now() - cachedAt < ttlMs) return cachedBalance;
      if (inFlight) return inFlight;

      const started = request();
      inFlight = started;
      try {
        return await started;
      } finally {
        if (inFlight === started) inFlight = null;
      }
    },

    dispose() {
      activeController?.abort('disposed');
      activeController = null;
      inFlight = null;
    },
  };
}
