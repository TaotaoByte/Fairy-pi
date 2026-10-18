/**
 * 适配层：事件语义映射。
 *
 * 上游 Fairy-DSH 的扩展通过 Cordis 的 `ctx.on('session/event')` 与插件生命周期
 * (`apply` / `ctx.effect` 卸载) 获得运行时信号，客户端还额外读 `sessions.list` /
 * `sessions.binding` 的 running 快照。Pi 侧只有一张扁平的 `pi.on(<事件名>, handler)`
 * 表，因此映射关系必须显式写下来，而不是靠调用方记。
 *
 * 本模块是**纯通知**的：包装器不返回任何值，因此永远不会改变 Pi 的事件语义
 * （不修改消息、不取消工具调用、不替换结果）。
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createFairyDiagnostics } from '../contracts/index.ts';
import type { FairyDiagnostics, FairyVisualLifecycle } from '../contracts/index.ts';

/** 归一化后的信号词汇。Fairy 各功能模块只订阅这些名字，不直接依赖 pi 事件名。 */
export type FairySignal =
  | 'session:start'
  | 'session:shutdown'
  | 'agent:start'
  | 'agent:end'
  | 'agent:settled'
  | 'turn:start'
  | 'turn:end'
  | 'tool:start'
  | 'tool:end'
  | 'message:end'
  | 'context:build'
  | 'mcp:change'
  | 'project:trust';

export interface FairyEventBinding {
  signal: FairySignal;
  /** `pi.on()` 的事件名。 */
  piEvent: string;
  /** 上游对应的获取方式，`-` 表示 DSH 侧没有对应物（Pi 独有）。 */
  dshSource: string;
  /** 该信号隐含的生命周期词汇；只使用上游会真正发出的 idle/running/completed。 */
  lifecycle?: FairyVisualLifecycle;
}

export const FAIRY_EVENT_BINDINGS: readonly FairyEventBinding[] = [
  {
    signal: 'session:start',
    piEvent: 'session_start',
    dshSource: 'cordis apply / ctx.sessions.binding',
  },
  {
    signal: 'session:shutdown',
    piEvent: 'session_shutdown',
    dshSource: 'cordis ctx.effect 卸载',
  },
  {
    signal: 'agent:start',
    piEvent: 'agent_start',
    dshSource: 'sessions.list 的 running 快照',
    lifecycle: 'running',
  },
  {
    signal: 'agent:end',
    piEvent: 'agent_end',
    dshSource: 'session/event 的 agent 结束',
    lifecycle: 'completed',
  },
  {
    signal: 'agent:settled',
    piEvent: 'agent_settled',
    dshSource: '-',
  },
  {
    signal: 'turn:start',
    piEvent: 'turn_start',
    dshSource: 'session/event',
    lifecycle: 'running',
  },
  {
    signal: 'turn:end',
    piEvent: 'turn_end',
    dshSource: 'session/event',
    lifecycle: 'idle',
  },
  {
    signal: 'tool:start',
    piEvent: 'tool_execution_start',
    dshSource: 'session/event 工具调用',
  },
  {
    signal: 'tool:end',
    piEvent: 'tool_execution_end',
    dshSource: 'session/event 工具结果',
  },
  {
    signal: 'message:end',
    piEvent: 'message_end',
    dshSource: 'session/event 消息完成',
  },
  {
    signal: 'context:build',
    piEvent: 'context',
    dshSource: '-',
  },
  {
    signal: 'mcp:change',
    piEvent: 'mcp_servers_change',
    dshSource: '-（DSH 用 profile bundles 静态声明 MCP）',
  },
  {
    signal: 'project:trust',
    piEvent: 'project_trust',
    dshSource: '-（DSH 用 workspace/profile 授权）',
  },
];

export function findFairyBinding(signal: FairySignal): FairyEventBinding | undefined {
  return FAIRY_EVENT_BINDINGS.find((binding) => binding.signal === signal);
}

export interface FairySignalSession {
  id?: string;
  mode: ExtensionContext['mode'];
  hasUI: boolean;
}

export interface FairySignalPayload {
  signal: FairySignal;
  lifecycle?: FairyVisualLifecycle;
  /** 触发该信号的 pi 事件名。 */
  source: string;
  /** 上游对应获取方式，便于比对角逐项核对。 */
  dshSource: string;
  at: number;
  session: FairySignalSession;
  event: unknown;
}

export type FairySignalHandler = (
  payload: FairySignalPayload,
  ctx: ExtensionContext,
) => void | Promise<void>;

export interface BindFairySignalsOptions {
  /** 只订阅这些信号；省略则订阅整张表。 */
  signals?: readonly FairySignal[];
  diagnostics?: FairyDiagnostics;
  wallClock?: () => number;
}

function readSessionId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

/**
 * 把归一化信号接到 `pi.on()`。返回统一退订函数。
 *
 * 处理器抛错只记录日志，不向 Pi 冒泡：Fairy 是旁路观察者，不能因为自身故障
 * 影响会话本身。
 */
export function bindFairySignals(
  pi: ExtensionAPI,
  handler: FairySignalHandler,
  options: BindFairySignalsOptions = {},
): () => void {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-adapters');
  const wallClock = options.wallClock ?? (() => Date.now());
  const wanted = options.signals ? new Set(options.signals) : undefined;

  for (const signal of wanted ?? []) {
    if (!findFairyBinding(signal)) {
      diagnostics.warn('bind', { reason: 'unknown-signal', signal });
    }
  }

  const byPiEvent = new Map<string, FairyEventBinding[]>();
  for (const binding of FAIRY_EVENT_BINDINGS) {
    if (wanted && !wanted.has(binding.signal)) continue;
    const group = byPiEvent.get(binding.piEvent);
    if (group) group.push(binding);
    else byPiEvent.set(binding.piEvent, [binding]);
  }

  // `pi.on()` 是按事件名重载的，动态事件名必须绕过重载签名。
  const subscribe = pi.on.bind(pi) as unknown as (
    event: string,
    handler: (event: unknown, ctx: ExtensionContext) => void,
  ) => () => void;

  const unsubscribes: Array<() => void> = [];
  for (const [piEvent, bindings] of byPiEvent) {
    unsubscribes.push(
      subscribe(piEvent, (event, ctx) => {
        for (const binding of bindings) {
          const payload: FairySignalPayload = {
            signal: binding.signal,
            ...(binding.lifecycle ? { lifecycle: binding.lifecycle } : {}),
            source: binding.piEvent,
            dshSource: binding.dshSource,
            at: wallClock(),
            session: { id: readSessionId(ctx), mode: ctx.mode, hasUI: ctx.hasUI },
            event,
          };
          try {
            void handler(payload, ctx);
          } catch (error) {
            diagnostics.error('signal', error, { signal: binding.signal });
          }
        }
      }),
    );
  }

  return () => {
    for (const off of unsubscribes.splice(0)) off();
  };
}
