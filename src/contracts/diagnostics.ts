/**
 * Fairy 诊断边界。
 *
 * 来源：Fairy-DSH `fairy-contracts/diagnostics.js`。
 * 行为契约与上游保持一致：敏感键脱敏、超长字符串截断、嵌套深度限制、
 * 相同错误在去重窗口内只记录一次、结构化单行输出。
 */

export const FAIRY_LOG_PREFIX = 'DSH_FAIRY_LOG';
export const FAIRY_LOG_SCHEMA_VERSION = 1;

const SENSITIVE_KEY = /authorization|credential|password|secret|token|api[_-]?key|cookie/i;
const MAX_STRING_LENGTH = 320;
const MAX_DEPTH = 2;
const MAX_ARRAY_ITEMS = 12;
const MAX_OBJECT_ENTRIES = 24;

export type FairyLogLevel = 'info' | 'warn' | 'error';

export interface FairyErrorRecord {
  name: string;
  code?: string;
  message: string;
}

export interface FairyLogRecord {
  schema: number;
  timestamp: string;
  level: FairyLogLevel;
  module: string;
  operation: string;
  event: string;
  context: unknown;
  error?: FairyErrorRecord;
  duration_ms?: number;
}

/** 结构化日志的输出通道。默认写 `console`。 */
export interface FairyDiagnosticsSink {
  info?: (...args: unknown[]) => void;
  log?: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface FairyDiagnosticsOptions {
  sink?: FairyDiagnosticsSink;
  wallClock?: () => string;
  monotonicClock?: () => number;
  dedupeWindowMs?: number;
}

export interface FairyMetricOptions {
  thresholdMs?: number;
}

export interface FairyDiagnostics {
  start: () => number;
  metric: (
    operation: string,
    startedAt: number,
    context?: Record<string, unknown>,
    options?: FairyMetricOptions,
  ) => FairyLogRecord | null;
  guard: <T>(operation: string, callback: () => T, context?: Record<string, unknown>) => T;
  guardAsync: <T>(
    operation: string,
    callback: () => Promise<T>,
    context?: Record<string, unknown>,
  ) => Promise<T>;
  info: (operation: string, context?: Record<string, unknown>) => FairyLogRecord | null;
  warn: (
    operation: string,
    context?: Record<string, unknown>,
    error?: unknown,
  ) => FairyLogRecord | null;
  error: (
    operation: string,
    error?: unknown,
    context?: Record<string, unknown>,
  ) => FairyLogRecord | null;
}

function safeString(value: unknown): string {
  const text = String(value ?? '');
  return text.length > MAX_STRING_LENGTH ? `${text.slice(0, MAX_STRING_LENGTH)}…` : text;
}

function sanitize(value: unknown, key = '', depth = 0): unknown {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return safeString(value);
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, '', depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_OBJECT_ENTRIES)
        .map(([name, item]) => [name, sanitize(item, name, depth + 1)]),
    );
  }
  return safeString(value);
}

export function normalizeFairyError(error: unknown): FairyErrorRecord | undefined {
  if (!error) return undefined;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return {
    name: safeString(candidate.name || 'Error'),
    code: candidate.code == null ? undefined : safeString(candidate.code),
    message: safeString(candidate.message || error),
  };
}

export function createFairyDiagnostics(
  moduleName: string,
  {
    sink = console,
    wallClock = () => new Date().toISOString(),
    monotonicClock = () => globalThis.performance?.now?.() ?? Date.now(),
    dedupeWindowMs = 60_000,
  }: FairyDiagnosticsOptions = {},
): FairyDiagnostics {
  const recentErrors = new Map<string, number>();
  const module = safeString(moduleName);
  const start = () => monotonicClock();

  const emit = (
    level: FairyLogLevel,
    operation: string,
    event: string,
    context?: Record<string, unknown>,
    error?: unknown,
    durationMs?: number,
  ): FairyLogRecord | null => {
    const normalizedError = normalizeFairyError(error);
    if (normalizedError) {
      const signature = `${operation}:${normalizedError.code || normalizedError.message}`;
      const now = Date.now();
      if (now - (recentErrors.get(signature) || 0) < dedupeWindowMs) return null;
      recentErrors.set(signature, now);
    }
    const record: FairyLogRecord = {
      schema: FAIRY_LOG_SCHEMA_VERSION,
      timestamp: wallClock(),
      level,
      module,
      operation: safeString(operation),
      event,
      context: sanitize(context || {}),
      ...(normalizedError ? { error: normalizedError } : {}),
      ...(Number.isFinite(durationMs) ? { duration_ms: Number(durationMs!.toFixed(3)) } : {}),
    };
    const output = `${FAIRY_LOG_PREFIX} ${JSON.stringify(record)}`;
    const writer =
      level === 'error' ? sink.error : level === 'warn' ? sink.warn : sink.info || sink.log;
    writer!.call(sink, output);
    return record;
  };

  const metric = (
    operation: string,
    startedAt: number,
    context: Record<string, unknown> = {},
    { thresholdMs = 0 }: FairyMetricOptions = {},
  ): FairyLogRecord | null => {
    const duration = monotonicClock() - startedAt;
    if (duration < thresholdMs) return null;
    return emit('info', operation, 'metric', context, undefined, duration);
  };

  const guard = <T>(
    operation: string,
    callback: () => T,
    context: Record<string, unknown> = {},
  ): T => {
    const startedAt = start();
    try {
      const result = callback();
      metric(operation, startedAt, { ...context, outcome: 'success' });
      return result;
    } catch (error) {
      emit('error', operation, 'failure', context, error);
      metric(operation, startedAt, { ...context, outcome: 'failure' });
      throw error;
    }
  };

  const guardAsync = async <T>(
    operation: string,
    callback: () => Promise<T>,
    context: Record<string, unknown> = {},
  ): Promise<T> => {
    const startedAt = start();
    try {
      const result = await callback();
      metric(operation, startedAt, { ...context, outcome: 'success' });
      return result;
    } catch (error) {
      emit('error', operation, 'failure', context, error);
      metric(operation, startedAt, { ...context, outcome: 'failure' });
      throw error;
    }
  };

  return {
    start,
    metric,
    guard,
    guardAsync,
    info: (operation, context) => emit('info', operation, 'event', context),
    warn: (operation, context, error) => emit('warn', operation, 'failure', context, error),
    error: (operation, error, context) => emit('error', operation, 'failure', context, error),
  };
}
