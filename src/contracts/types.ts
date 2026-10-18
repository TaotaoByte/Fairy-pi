/**
 * Fairy 共享词汇表（类型部分）。
 *
 * 来源：Fairy-DSH `fairy-contracts/types.d.ts`。
 * 移植原则：字面量、字段名、schema 版本与上游逐字一致，使两侧行为可以逐项对照。
 * 本文件为纯类型，不含运行时值。
 */

export type FairyIdentityMode = 'ling' | 'zhe' | 'custom';

export interface FairyIdentitySettings {
  mode: FairyIdentityMode;
  customName: string;
  secondAssistant: string;
  household: string[];
}

/**
 * 共享活动词汇。上游语义：`thinking` 来自官方 Session 的 running 快照；
 * `comforting` 由本地安慰检测器在明确的求助/不适信号后进入，并在该会话内锁存，
 * 优先级高于 `thinking` 与 `normal`。
 */
export type FairyVisualActivity = 'normal' | 'thinking' | 'comforting';

/**
 * 共享生命周期词汇，注意这**不是**「当前实现会发出这些字面量」的承诺。
 * 上游明确：当前只发出 `idle` / `running` / `completed`，
 * 其余四个是保留字面量（无当前运行时消费者）。
 */
export type FairyVisualLifecycle =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'disposed';

export type FairyVisualTheme = 'dark' | 'light';

export type FairyVisualPowerMode = 'normal' | 'low-power';

export interface FairyVisualSettings {
  version: 2;
  enabled: boolean;
  theme: FairyVisualTheme;
  mascotVisible: boolean;
  mascotScale: number;
  mascotAnimationSpeed: number;
  powerMode: FairyVisualPowerMode;
  composerDockHeight: number;
}

/**
 * 快照形状，仅用于类型标注。活动状态来自会话派生，
 * 除非本地安慰锁存在当前会话中生效。
 */
export interface FairyVisualSnapshot {
  settings: FairyVisualSettings;
  activity: FairyVisualActivity;
  lifecycle: FairyVisualLifecycle;
  sessionId?: string;
}
