/**
 * 适配层 —— DSH 宿主接口在 Pi 上的替代实现。
 *
 * 与契约层的关系：契约层定义「Fairy 说什么词汇」，适配层定义「这些话由 Pi 的哪个
 * 事件、哪个目录、哪份设置送进来」。两者都不包含功能行为。
 *
 * 逐项对照（DSH → Pi）：
 * | DSH 接口                                   | Pi 侧替代                              |
 * |--------------------------------------------|----------------------------------------|
 * | `ctx.on('session/event')`                  | `bindFairySignals()` → `pi.on()`       |
 * | `sessions.list` running 快照                | `agent_start` / `turn_*` 信号          |
 * | `ctx.effect(fn, label)`                     | `attachFairySession()` 会话作用域      |
 * | `ctx.inject(['webServer'])` + `webServer.register()` | 未覆盖，由依赖 HTTP 的功能阶段决定 |
 * | `settingsNamespace()` + `settings.register()` | `createFairySettingsRegistry()`      |
 * | `ctx.slots.inject/register`                 | 未覆盖，Pi 侧为 `ctx.ui` / 渲染器      |
 * | `DSH_HOME` 下的运行时目录                    | `resolveFairyDataDir()`                |
 */

export {
  FAIRY_DATA_DIR_ENV_VAR,
  FAIRY_DATA_DIR_NAME,
  describePlatform,
  detectPlatform,
  normalizePlatform,
  resolveFairyDataDir,
} from './pi-platform.ts';

export type {
  FairyDataScope,
  FairyPlatform,
  FairyPlatformInfo,
  ResolveFairyDataDirOptions,
} from './pi-platform.ts';

export { FAIRY_EVENT_BINDINGS, bindFairySignals, findFairyBinding } from './pi-events.ts';

export type {
  BindFairySignalsOptions,
  FairyEventBinding,
  FairySignal,
  FairySignalHandler,
  FairySignalPayload,
  FairySignalSession,
} from './pi-events.ts';

export { attachFairySession, createFairySessionScope } from './pi-lifecycle.ts';

export type {
  AttachFairySessionOptions,
  FairySessionScope,
  FairySessionScopeOptions,
} from './pi-lifecycle.ts';

export {
  FAIRY_IDENTITY_SCHEMA,
  FAIRY_SETTINGS_SCHEMAS,
  FAIRY_VISUAL_SCHEMA,
  createFairySettingsRegistry,
  createMemorySettingsStore,
  findFairySettingsSchema,
  resolveFairySettings,
} from './pi-settings.ts';

export type {
  FairyBooleanField,
  FairyEnumField,
  FairyFieldRules,
  FairyNumberField,
  FairySettingsRegistry,
  FairySettingsRegistryOptions,
  FairySettingsResolution,
  FairySettingsSchema,
  FairySettingsStore,
  FairyStringArrayField,
  FairyStringField,
} from './pi-settings.ts';
