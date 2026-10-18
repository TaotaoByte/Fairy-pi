/**
 * Fairy 契约层 —— Fairy-DSH `fairy-contracts` 在 Pi 上的移植。
 *
 * 移植原则：
 * 1. 命名空间、版本号、词汇表字面量与顺序与上游逐字一致，使两侧行为可逐项对照。
 * 2. 去掉只服务于 DSH 浏览器客户端的打包形态（`client-dom.cjs` /
 *    `client-diagnostics.cjs` 的 IIFE 内联拷贝）：Pi 扩展运行在 Node 进程内，
 *    不存在 `window.__ModuleLoader__`，两套拷贝没有意义。
 * 3. 本包必须是运行时的「无状态词汇表」：不含可变单例、定时器、IO 或持久化。
 */

export {
  FAIRY_LOG_PREFIX,
  FAIRY_LOG_SCHEMA_VERSION,
  createFairyDiagnostics,
  normalizeFairyError,
} from './diagnostics.ts';

export type {
  FairyDiagnostics,
  FairyDiagnosticsOptions,
  FairyDiagnosticsSink,
  FairyErrorRecord,
  FairyLogLevel,
  FairyLogRecord,
  FairyMetricOptions,
} from './diagnostics.ts';

export const FAIRY_VISUAL_SETTINGS_NAMESPACE = 'fairy-visual';
export const FAIRY_IDENTITY_SETTINGS_NAMESPACE = 'fairy-identity';
export const FAIRY_VISUAL_SETTINGS_VERSION = 2;

export const FAIRY_VISUAL_THEMES = ['dark', 'light'] as const;
export const FAIRY_VISUAL_POWER_MODES = ['normal', 'low-power'] as const;
export const FAIRY_VISUAL_ACTIVITY = ['normal', 'thinking', 'comforting'] as const;

/**
 * 注意：顺序与上游一致；`preparing` / `interrupted` / `failed` / `disposed`
 * 是保留字面量，当前实现不会发出它们。
 */
export const FAIRY_VISUAL_LIFECYCLE = [
  'idle',
  'preparing',
  'running',
  'interrupted',
  'completed',
  'failed',
  'disposed',
] as const;

/**
 * 上游 DSH 浏览器客户端用于接通语音控制框的 DOM 属性。
 *
 * Pi 侧没有浏览器 DOM，因此当前没有消费者。这里保留原字面量是为了让两侧契约
 * 可以逐项对照；它**不代表** Pi 会使用这个属性。若后续确认 Pi 侧永不消费，
 * 可在单独一次契约变更中移除，并同步更新测试。
 */
export const FAIRY_VOICE_CONTROL_ATTRIBUTE = 'data-dsh-fairy-voice-control';

export type {
  FairyIdentityMode,
  FairyIdentitySettings,
  FairyVisualActivity,
  FairyVisualLifecycle,
  FairyVisualPowerMode,
  FairyVisualSettings,
  FairyVisualSnapshot,
  FairyVisualTheme,
} from './types.ts';
