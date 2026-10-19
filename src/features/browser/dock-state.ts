/**
 * 功能层：浏览器坞的文件协议（上游 `dsh-browser-dock` 的可移植内核）。
 *
 * 上游由三块构成：`proxy.cjs`（stdio MCP 代理，是**生产者**：spawn playwright MCP、逐动作截图、
 * 检测人机验证，然后原子写 `state.json`）、`lib/index.js`（宿主侧：读 state、写 command、
 * 暴露 `/browser-dock/{state,events,frame,control}`）、前端 DOM（消费方）。Pi 侧只有第三块的
 * 位置不同，前两块的**传输层**都不可达：
 *   - 宿主侧没有 HTTP 端点注册能力 → `/state`、`/events`（SSE）、`/frame`（JPEG 流）、
 *     `/control`（带 control-token 的鉴权写）四类端点全部不存在；
 *   - Pi 也没有浏览器客户端 → frame 图片无人渲染。
 * 因此这里只移植**两端共享的文件契约**：目录布局、state 读取的容错、command 的原子写入、
 * 帧文件命名、状态目录监听。生产者保持上游语义（写 state.json），消費方由本包的
 * `/fairy-browser` 命令承担（读 state、写 command）。
 *
 * 关于 `control-token`：上游用它给 `/browser-dock/control` 做鉴权（`403 forbidden`）。
 * Pi 没有 HTTP 写入面，命令只在本进程内由用户触发，因此**不移植令牌文件**——
 * 留一个无用途的密钥文件只会增加误解。上游的校验语义（动作白名单、takeover 的
 * 三重前提与冲突码）改为在 `normalizeDockCommand()` 里原样保留。
 *
 * 上游用 `fs.watch` 监听**目录**而不是 state.json 本身，因为生产者用原子 rename 替换文件
 * （监听文件 inode 会漏事件）。此处保持同样的选择与同样的 `state.json` 文件名过滤。
 */

import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { replaceFileAtomically } from '../../atomic-file.ts';
import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export const DOCK_DIR_NAME = 'browser-dock';
export const DOCK_STATE_FILE_NAME = 'state.json';
export const DOCK_COMMAND_FILE_NAME = 'command.json';
/** 上游 `MAX_CONTROL_BYTES`：控制命令载荷上限。 */
export const DOCK_MAX_COMMAND_BYTES = 2_048;
/** 上游在监听不可用时回给客户端的降级轮询间隔。 */
export const DOCK_WATCH_FALLBACK_POLL_MS = 800;

export const DOCK_COMMAND_ACTIONS = ['bind', 'close', 'takeover'] as const;
export type DockCommandAction = (typeof DOCK_COMMAND_ACTIONS)[number];

/** 上游 `proxy.cjs` 的 `inactiveState()` 字段，逐项保留。 */
export interface DockState {
  active: boolean;
  status: string;
  url: string;
  title: string;
  tabs: unknown[];
  currentTab: number;
  frameRevision: number;
  takeoverAvailable: boolean;
  takeoverConsumed: boolean;
  ownerSessionId: string | null;
  error: string | null;
  updatedAt: number;
  revision: number;
  loading?: boolean;
  [key: string]: unknown;
}

export const INACTIVE_DOCK_STATE: Readonly<DockState> = Object.freeze({
  active: false,
  status: 'idle',
  url: '',
  title: '',
  tabs: [],
  currentTab: -1,
  frameRevision: 0,
  takeoverAvailable: false,
  takeoverConsumed: false,
  ownerSessionId: null,
  error: null,
  updatedAt: 0,
  revision: 0,
});

export interface DockPaths {
  runtimeDir: string;
  stateFile: string;
  commandFile: string;
}

export function dockPaths(dataDir: string): DockPaths {
  const runtimeDir = join(dataDir, DOCK_DIR_NAME);
  return {
    runtimeDir,
    stateFile: join(runtimeDir, DOCK_STATE_FILE_NAME),
    commandFile: join(runtimeDir, DOCK_COMMAND_FILE_NAME),
  };
}

export interface DockStateReadResult {
  state: DockState;
  /** 文件是否存在。false 时 `state` 为 `INACTIVE_DOCK_STATE`。 */
  present: boolean;
  /** 读取失败的原因（`ENOENT` 不算失败）。 */
  error?: string;
}

/** 上游 `readState()`：缺文件或非对象一律退化为 idle，其它错误记警告但不抛出。 */
export function readDockState(paths: DockPaths, diagnostics?: FairyDiagnostics): DockStateReadResult {
  const log = diagnostics ?? createFairyDiagnostics('fairy-pi-browser');
  try {
    const value: unknown = JSON.parse(readFileSync(paths.stateFile, 'utf8'));
    if (typeof value !== 'object' || value === null) {
      return { state: { ...INACTIVE_DOCK_STATE }, present: false };
    }
    return { state: value as DockState, present: true };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== 'ENOENT') {
      log.warn('state.read', { file: DOCK_STATE_FILE_NAME }, error);
      return { state: { ...INACTIVE_DOCK_STATE }, present: false, error: (error as { message?: string })?.message };
    }
    return { state: { ...INACTIVE_DOCK_STATE }, present: false };
  }
}

/** 上游 `frameFile(revision)` 的命名。 */
export function dockFramePath(paths: DockPaths, revision: number): string {
  return join(paths.runtimeDir, `frame-${revision}.jpg`);
}

/** 扫描已存在的帧文件（上游 `/frame?revision=N` 按需读单个文件；这里列出可用的 rev）。 */
export function listDockFrameRevisions(paths: DockPaths): number[] {
  try {
    return readdirSync(paths.runtimeDir)
      .map((name) => /^frame-(\d+)\.jpg$/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

export interface WriteDockCommandOptions {
  now?: () => number;
  random?: () => number;
}

/**
 * 上游 `writeCommand()`：临时文件 + 原子 rename + 0600 + 追加随机 nonce
 * （nonce 让生产者能区分「新命令」与「旧命令」）。载荷超过上限则拒绝。
 */
export function writeDockCommand(
  paths: DockPaths,
  command: Record<string, unknown>,
  options: WriteDockCommandOptions = {},
): string {
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? (() => Math.random());
  const nonce = `${now()}-${random()}`;
  const payload = JSON.stringify({ ...command, nonce });
  if (Buffer.byteLength(payload, 'utf8') > DOCK_MAX_COMMAND_BYTES) {
    throw new Error('control body too large');
  }

  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const temporary = `${paths.commandFile}.${process.pid}.tmp`;
  writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    // 生产者可能在读同一文件；Windows 上 rename 会瞬时失败，故走带重试的原子替换。
    replaceFileAtomically(temporary, paths.commandFile);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // 清理失败不掩盖原始错误。
    }
    throw error;
  }
  return nonce;
}

export type DockCommandValidation =
  | { ok: true; command: { action: DockCommandAction } & Record<string, unknown> }
  | { ok: false; status: number; error: string };

/**
 * 上游 `/browser-dock/control` 的校验语义（去掉令牌比对，见文件头说明）。
 * 错误字面量与状态码保持上游原样。
 */
export function normalizeDockCommand(raw: unknown, state: DockState): DockCommandValidation {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, status: 400, error: 'invalid JSON' };
  }
  const candidate = raw as { action?: unknown; revision?: unknown };
  if (
    typeof candidate.action !== 'string'
    || !(DOCK_COMMAND_ACTIONS as readonly string[]).includes(candidate.action)
  ) {
    return { ok: false, status: 400, error: 'unsupported action' };
  }
  const action = candidate.action as DockCommandAction;

  if (action === 'takeover') {
    const matchesRevision = candidate.revision === state.revision;
    if (!state.active || !state.takeoverAvailable || state.takeoverConsumed || !matchesRevision) {
      return { ok: false, status: 409, error: 'takeover is no longer available' };
    }
  }

  const { token: _token, ...rest } = raw as Record<string, unknown>;
  return { ok: true, command: { ...rest, action } };
}

export interface DockWatchOptions {
  diagnostics?: FairyDiagnostics;
  /** 监听建立后立即回调一次，便于消费方对齐当前状态。 */
  emitInitial?: boolean;
}

export interface DockWatchHandle {
  /** 监听是否真的建立成功（上游以此决定 `/events` 回 200 还是 503）。 */
  readonly available: boolean;
  close(): void;
}

/**
 * 监听 `state.json` 变化。上游在监听失败时不抛错，而是降级为「不可用 + 记一次警告」
 * （消费方自行轮询）。这里保持同一语义：返回的 handle 上 `available` 反映结果。
 */
export function watchDockState(
  paths: DockPaths,
  onChange: () => void,
  options: DockWatchOptions = {},
): DockWatchHandle {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-browser');
  let watcher: ReturnType<typeof watch> | undefined;
  let available = false;
  let errorReported = false;
  let scheduled = false;

  const notify = (): void => {
    // 上游用 queueMicrotask 合并同一轮事件，避免风暴式回调。
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      try {
        onChange();
      } catch (error) {
        diagnostics.warn('state.notify', {}, error);
      }
    });
  };

  const disable = (error?: unknown): void => {
    available = false;
    try {
      watcher?.close();
    } catch {
      // close 失败无需上报：监听已经停止。
    }
    watcher = undefined;
    if (error && !errorReported) {
      errorReported = true;
      diagnostics.warn('state.watch', { fallback_poll_ms: DOCK_WATCH_FALLBACK_POLL_MS }, error);
    }
  };

  try {
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    watcher = watch(paths.runtimeDir, (event, filename) => {
      if ((event === 'change' || event === 'rename') && String(filename ?? '') === DOCK_STATE_FILE_NAME) {
        notify();
      }
    });
    watcher.on('error', (error) => disable(error));
    available = true;
    if (options.emitInitial) notify();
  } catch (error) {
    disable(error);
  }

  return {
    get available() {
      return available;
    },
    close: () => disable(),
  };
}
