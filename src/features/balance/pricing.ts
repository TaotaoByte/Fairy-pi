/**
 * 功能层：费用估算（上游 `balance-meter/lib/index.js` 的纯函数部分）。
 *
 * 与上游逐字对齐：档位判定、单价表、估算公式、token 归一化全部照搬，使两侧对同一
 * 用量应给出同一个数字。差异只有一处：入参形状从上游的 `inputTokens/outputTokens/...`
 * 换成 Pi 的 `Usage`（`input/output/cacheRead/cacheWrite`），由 `toFairyTokenUsage()` 承担。
 */

export const PRICING_MODEL = 'deepseek-v4-flash';
export const PRICING_VERSION = 'deepseek-v4-flash-2026-08-26';
export const PRICING_VERIFIED_DATE = '2026-08-26';
export const PRICING_SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';

const USD_TO_CNY_ESTIMATE = 7.2;
const USD_PER_MILLION = Object.freeze({
  offPeak: Object.freeze({ cacheHit: 0.007, cacheMiss: 0.22, output: 0.66 }),
  peak: Object.freeze({ cacheHit: 0.014, cacheMiss: 0.44, output: 1.32 }),
});

export { USD_TO_CNY_ESTIMATE, USD_PER_MILLION };

export type PricingBand = 'peak' | 'offPeak';

/** 上游口径：UTC 周一至周五的 01:00–03:59 与 06:00–09:59 为高峰。 */
export function pricingBandForDate(date: Date | string | number = new Date()): PricingBand {
  const value = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(value.getTime())) return 'offPeak';
  const day = value.getUTCDay();
  const hour = value.getUTCHours();
  const weekday = day >= 1 && day <= 5;
  return weekday && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10)) ? 'peak' : 'offPeak';
}

export function tokenCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/** 上游的用量形状。 */
export interface FairyTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface PiUsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Pi `Usage` → 上游用量形状。语义对齐：`cacheWrite` 计入 cacheMiss 档。 */
export function toFairyTokenUsage(usage: PiUsageLike | undefined): FairyTokenUsage {
  return {
    inputTokens: tokenCount(usage?.input),
    outputTokens: tokenCount(usage?.output),
    cacheReadTokens: tokenCount(usage?.cacheRead),
    cacheWriteTokens: tokenCount(usage?.cacheWrite),
  };
}

export function estimateUsageUsd(
  usage: Partial<FairyTokenUsage> | undefined,
  date: Date | string | number = new Date(),
): number {
  const rate = USD_PER_MILLION[pricingBandForDate(date)];
  return (
    tokenCount(usage?.cacheReadTokens) * rate.cacheHit
    + (tokenCount(usage?.inputTokens) + tokenCount(usage?.cacheWriteTokens)) * rate.cacheMiss
    + tokenCount(usage?.outputTokens) * rate.output
  ) / 1_000_000;
}
