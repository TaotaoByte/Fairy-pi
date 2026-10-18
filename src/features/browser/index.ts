/**
 * 功能层：Fairy 浏览器坞（上游 `dsh-browser-dock` 的 Pi 移植）。
 *
 * 上游把「宿主读取浏览器状态」暴露成四个 HTTP 端点，其中 `/browser-dock/control` 用
 * `control-token` 鉴权、`/browser-dock/events` 是 SSE、`/browser-dock/frame` 只回 JPEG 字节流。
 * **Pi 没有 HTTP 端点注册能力，也没有浏览器客户端**，所以端点层整体替换为：
 *   - `/fairy-browser` 命令：`state`（读状态）、`frames`（列出帧文件）、
 *     `bind`/`close`/`takeover`（写命令，校验语义与上游 control 端点一致）；
 *   - 状态行：`ctx.ui.setStatus`（仅 tui），替代 SSE 推送；
 *   - MCP：上游用 `cordis.patch.yml` 注入 `@playwright/mcp`，Pi 侧改用
 *     `pi.registerMcpServer()`，且**默认不注册**——是否引入浏览器自动化由使用方决定。
 *
 * 会话结束时的清理语义与上游一致：有 state 就写一条 `close`（reason `plugin-unload`），
 * 没有 state 但有残留 command 文件则删除它。
 *
 * 说明：本包**不分发** `proxy.cjs`（生产者）。它 fork 出来是为了桥接 MCP 与写状态文件，
 * 而 Pi 的 MCP 注册本身就能拉起任意 MCP 服务器；需要浏览器状态时，让使用者把生产者指向
 * `<dataDir>/browser-dock/`（契约见 `dock-state.ts`）即可，本模块负责消费。
 */

import { existsSync, unlinkSync } from 'node:fs';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { attachFairySession } from '../../adapters/index.ts';
import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';
import {
  DOCK_COMMAND_ACTIONS,
  DOCK_WATCH_FALLBACK_POLL_MS,
  dockFramePath,
  dockPaths,
  listDockFrameRevisions,
  normalizeDockCommand,
  readDockState,
  watchDockState,
  writeDockCommand,
  type DockPaths,
  type DockState,
} from './dock-state.ts';

export {
  DOCK_COMMAND_ACTIONS,
  DOCK_DIR_NAME,
  DOCK_MAX_COMMAND_BYTES,
  DOCK_STATE_FILE_NAME,
  DOCK_WATCH_FALLBACK_POLL_MS,
  INACTIVE_DOCK_STATE,
  dockFramePath,
  dockPaths,
  listDockFrameRevisions,
  normalizeDockCommand,
  readDockState,
  watchDockState,
  writeDockCommand,
} from './dock-state.ts';
export type {
  DockCommandAction,
  DockCommandValidation,
  DockPaths,
  DockState,
  DockStateReadResult,
  DockWatchHandle,
  DockWatchOptions,
  WriteDockCommandOptions,
} from './dock-state.ts';

export const FAIRY_BROWSER_COMMAND = 'fairy-browser';
export const FAIRY_BROWSER_STATUS_KEY = 'fairy-browser';
export const FAIRY_BROWSER_MCP_SERVER_NAME = 'browser-dock';

/** 上游卸载时的关闭原因字面量。 */
export const DOCK_UNLOAD_REASON = 'plugin-unload';

/** 用 `Parameters<...>` 取 MCP 配置类型，避免依赖未从包根导出的深层类型。 */
export type FairyBrowserMcpConfig = Parameters<ExtensionAPI['registerMcpServer']>[1];

export interface FairyBrowserOptions {
  dataDir: string;
  diagnostics?: FairyDiagnostics;
  /** 提供时注册 MCP 服务器；`name` 默认 `browser-dock`。 */
  mcp?: { name?: string; config: FairyBrowserMcpConfig };
  /** 是否在 tui 下写状态行，默认 true。 */
  statusLine?: boolean;
}

export interface FairyBrowserRuntime {
  command: string;
  paths: DockPaths;
  /** 当前状态（重新读盘，不缓存）。 */
  read(): DockState;
  /** 供单测/程序化调用：写一条控制命令并返回校验结果。 */
  control(command: Record<string, unknown>, ctx?: ExtensionContext): { status: number; error?: string };
  mcpServerName(): string | undefined;
}

export function formatDockState(state: DockState): string {
  if (!state.active) return `浏览器坞未激活（status=${state.status}）`;
  const where = state.url || state.title || '未知页面';
  const takeover = state.takeoverAvailable && !state.takeoverConsumed ? '，需要人工接管' : '';
  return `浏览器坞：${state.status} · ${where}${takeover}`;
}

export function formatDockStatusLine(state: DockState): string | undefined {
  if (!state.active) return undefined;
  return `坞 ${state.status}${state.takeoverAvailable && !state.takeoverConsumed ? ' · 待接管' : ''}`;
}

function usageText(): string {
  return [
    'Fairy 浏览器坞用法：',
    '  /fairy-browser state               查看当前状态',
    '  /fairy-browser frames              列出可用帧文件',
    `  /fairy-browser bind               写一条 bind 命令`,
    `  /fairy-browser close [原因]        写一条 close 命令`,
    '  /fairy-browser takeover <revision> 人工接管（需状态允许）',
    '  /fairy-browser mcp                 查看 MCP 注册情况',
  ].join('\n');
}

export function applyFairyBrowserDock(
  pi: ExtensionAPI,
  options: FairyBrowserOptions,
): FairyBrowserRuntime {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-browser');
  const paths = dockPaths(options.dataDir);
  const statusLine = options.statusLine !== false;

  const mcpName = options.mcp ? (options.mcp.name ?? FAIRY_BROWSER_MCP_SERVER_NAME) : undefined;
  if (options.mcp && mcpName) {
    // 上游在 profile 的 cordis.patch.yml 里静态声明；Pi 必须在扩展加载期注册，
    // 这样 session_start 时 `pi.getMcpServers()` 才能读到它。
    pi.registerMcpServer(mcpName, options.mcp.config);
    diagnostics.info('mcp.register', { name: mcpName });
  }

  const read = (): DockState => readDockState(paths, diagnostics).state;

  const updateStatus = (ctx: ExtensionContext, state: DockState): void => {
    if (!statusLine || ctx.mode !== 'tui') return;
    ctx.ui.setStatus(FAIRY_BROWSER_STATUS_KEY, formatDockStatusLine(state));
  };

  const control = (
    command: Record<string, unknown>,
    ctx?: ExtensionContext,
  ): { status: number; error?: string } => {
    const state = read();
    const validation = normalizeDockCommand(command, state);
    if (!validation.ok) {
      diagnostics.warn('control.write', { status: validation.status, action: command.action });
      return { status: validation.status, error: validation.error };
    }
    try {
      writeDockCommand(paths, validation.command);
    } catch (error) {
      const message = (error as { message?: string })?.message ?? 'unknown';
      diagnostics.warn('control.write', { status: 400 }, error);
      if (ctx) ctx.ui.notify(`浏览器坞命令写入失败：${message}`, 'error');
      return { status: 400, error: message };
    }
    if (ctx) {
      updateStatus(ctx, state);
      ctx.ui.notify(`浏览器坞命令已写入：${validation.command.action}`, 'info');
    }
    return { status: 202 };
  };

  attachFairySession(pi, {
    diagnostics,
    label: 'fairy-browser',
    onStart: (scope, ctx) => {
      if (statusLine) updateStatus(ctx, read());
      const handle = watchDockState(
        paths,
        () => {
          updateStatus(ctx, read());
        },
        { diagnostics, emitInitial: true },
      );
      scope.register('dock-watch', () => handle.close());
      if (!handle.available) {
        diagnostics.warn('state.watch.unavailable', { fallback_poll_ms: DOCK_WATCH_FALLBACK_POLL_MS });
      }
      diagnostics.info('enable', { runtimeDir: paths.runtimeDir, watch: handle.available });
    },
  });

  // 上游 ctx.effect 的卸载清理：有 state 就通知生产者关闭，否则删掉残留命令文件。
  pi.on('session_shutdown', () => {
    try {
      if (existsSync(paths.stateFile)) {
        writeDockCommand(paths, { action: 'close', reason: DOCK_UNLOAD_REASON });
      } else if (existsSync(paths.commandFile)) {
        unlinkSync(paths.commandFile);
      }
    } catch (error) {
      diagnostics.warn('lifecycle.cleanup', {}, error);
    }
  });

  pi.registerCommand(FAIRY_BROWSER_COMMAND, {
    description: 'Fairy 浏览器坞：查看状态、写控制命令、查看 MCP 注册',
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = (args ?? '').trim().split(/\s+/);
      switch (subcommand) {
        case '':
        case 'state': {
          const state = read();
          updateStatus(ctx, state);
          ctx.ui.notify(`${formatDockState(state)}\n${JSON.stringify(state, null, 2)}`, state.active ? 'info' : 'warning');
          return;
        }
        case 'frames': {
          const revisions = listDockFrameRevisions(paths);
          if (revisions.length === 0) {
            ctx.ui.notify(`暂无帧文件（目录：${paths.runtimeDir}）`, 'warning');
            return;
          }
          ctx.ui.notify(
            `可用帧（${revisions.length}）：\n${revisions.map((revision) => `- ${revision}: ${dockFramePath(paths, revision)}`).join('\n')}`,
          );
          return;
        }
        case 'bind':
          control({ action: 'bind', sessionId: rest[0] ?? null }, ctx);
          return;
        case 'close':
          control({ action: 'close', ...(rest[0] ? { reason: rest[0] } : {}) }, ctx);
          return;
        case 'takeover': {
          const revision = Number(rest[0]);
          const result = control({ action: 'takeover', revision }, ctx);
          if (result.status !== 202) {
            ctx.ui.notify(`接管失败（${result.status}）：${result.error}`, 'warning');
          }
          return;
        }
        case 'mcp':
          ctx.ui.notify(
            mcpName
              ? `已注册 MCP 服务器：${mcpName}`
              : '未注册 MCP 服务器（浏览器自动化需由使用方提供）。',
            mcpName ? 'info' : 'warning',
          );
          return;
        default:
          ctx.ui.notify(usageText(), 'warning');
      }
    },
  });

  if (!mcpName) {
    diagnostics.info('mcp.absent', { actions: DOCK_COMMAND_ACTIONS.join(',') });
  }

  return {
    command: FAIRY_BROWSER_COMMAND,
    paths,
    read,
    control,
    mcpServerName: () => mcpName,
  };
}
