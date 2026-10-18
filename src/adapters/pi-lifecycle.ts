/**
 * 适配层：会话级资源作用域。
 *
 * 上游用 Cordis 的 `ctx.effect(fn, label)` 声明「这个副作用跟着插件实例一起拆除」。
 * Pi 没有等价的注册点，官方文档给的是两条硬规则：
 *   1. 不要在扩展工厂里启动进程 / socket / watcher / 定时器；
 *      「某些调用会加载扩展但不启动会话」。
 *   2. 长生命周期资源在 `session_start` 中创建，在 `session_shutdown` 中以**幂等**
 *      的方式关闭。
 *
 * 本模块把这两条规则封装成一个可复用的作用域，让后续各功能模块只写「拿到资源就
 * register(名字, 拆除函数)」，而不必各自记住拆除时机与逆序。
 */

import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from '@earendil-works/pi-coding-agent';
import { createFairyDiagnostics } from '../contracts/index.ts';
import type { FairyDiagnostics } from '../contracts/index.ts';

export interface FairySessionScope {
  readonly label: string;
  /** 是否仍可注册资源。`dispose()` 之后恒为 false。 */
  readonly active: boolean;
  /** 注册一个需要跟随会话拆除的资源；返回单独拆除它的函数。 */
  register(resource: string, dispose: () => void): () => void;
  /**
   * 在错误边界内运行一段逻辑。抛错被记录并吞掉，返回 `undefined`。
   * 供 session_start 这类「失败也不能影响 Pi 启动」的位置使用。
   */
  run<T>(
    operation: string,
    callback: () => T | Promise<T>,
    context?: Record<string, unknown>,
  ): Promise<T | undefined>;
  /** 逆序拆除全部资源。幂等。 */
  dispose(reason?: string): void;
}

export interface FairySessionScopeOptions {
  diagnostics: FairyDiagnostics;
  label?: string;
}

export function createFairySessionScope(options: FairySessionScopeOptions): FairySessionScope {
  const { diagnostics } = options;
  const label = options.label ?? 'fairy-session';
  const resources: Array<{ name: string; dispose: () => void }> = [];
  let active = true;

  const disposeOne = (resource: { name: string; dispose: () => void }, reason: string) => {
    try {
      resource.dispose();
    } catch (error) {
      diagnostics.error('dispose', error, { scope: label, resource: resource.name, reason });
    }
  };

  return {
    label,

    get active() {
      return active;
    },

    register(resource, dispose) {
      if (!active) {
        diagnostics.warn('register', { scope: label, resource, reason: 'scope-inactive' });
        disposeOne({ name: resource, dispose }, 'late-register');
        return () => {};
      }
      const entry = { name: resource, dispose };
      resources.push(entry);
      return () => {
        const index = resources.indexOf(entry);
        if (index < 0) return;
        resources.splice(index, 1);
        disposeOne(entry, 'early-release');
      };
    },

    async run(operation, callback, context = {}) {
      try {
        return await diagnostics.guardAsync(operation, () => Promise.resolve(callback()), {
          scope: label,
          ...context,
        });
      } catch (error) {
        // guardAsync 已经写入 error 日志；这里只负责不把异常交给 Pi。
        return undefined;
      }
    },

    dispose(reason = 'unspecified') {
      if (!active) return;
      active = false;
      const pending = resources.splice(0, resources.length);
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        disposeOne(pending[index]!, reason);
      }
      diagnostics.info('dispose', { scope: label, reason, released: pending.length });
    },
  };
}

export interface AttachFairySessionOptions {
  diagnostics?: FairyDiagnostics;
  label?: string;
  /** 在一个新的会话作用域上建立资源。抛错会被吞掉并记录。 */
  onStart: (
    scope: FairySessionScope,
    ctx: ExtensionContext,
    event: SessionStartEvent,
  ) => void | Promise<void>;
}

/**
 * 把作用域绑定到 Pi 的会话边界。返回值用于在工厂被替换（`/reload`）时解除绑定。
 *
 * 注意：`session_start` 的 `reason` 包含 `reload`，因此同一扩展运行期内可能再次触发；
 * 每次都会先拆除上一个作用域，避免资源叠加。
 */
export function attachFairySession(
  pi: ExtensionAPI,
  options: AttachFairySessionOptions,
): () => void {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-adapters');
  let scope: FairySessionScope | undefined;

  const offStart = pi.on('session_start', async (event, ctx) => {
    scope?.dispose('session-restart');
    const next = createFairySessionScope({ diagnostics, label: options.label });
    scope = next;
    await next.run('session-start', () => options.onStart(next, ctx, event), {
      reason: event.reason,
    });
  });

  const offShutdown = pi.on('session_shutdown', (event) => {
    scope?.dispose(event.reason);
    scope = undefined;
  });

  return () => {
    offStart();
    offShutdown();
    scope?.dispose('detach');
    scope = undefined;
  };
}
