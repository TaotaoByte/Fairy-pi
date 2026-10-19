/**
 * 原子替换的小工具。
 *
 * 上游的落盘模式是「临时文件 + rename」——换来的是「读到的永远是完整内容」
 * （不会被截断成半个 JSON）。但 Windows 上 `rename` 覆盖**已存在且正被其它进程打开**的
 * 目标文件时会失败（`EPERM` / `EACCES` / `EBUSY`），而消费者恰恰经常在轮询读取同一个文件：
 * 例如 `daily.ts` 的日账被 `/fairy-balance` 读、`dock-state.ts` 的 `state.json` 被监听与命令读。
 *
 * 这类失败是**瞬时**的（只要对方读完就恢复），退避重试即可。若完全不重试，一次丢失的写入
 * 对日账意味着少记一次用量，且失败是静默的——所以三处落盘统一走这里。
 */

import { renameSync } from 'node:fs';

/** Windows 上「目标被打开」类瞬时错误。 */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY']);

const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** 同步睡眠：Node 允许在主线程 `Atomics.wait`，无需 async 传染调用链。 */
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(sleeper, 0, 0, ms);
}

export interface ReplaceFileOptions {
  attempts?: number;
  delayMs?: number;
}

/**
 * 把 `temporary` 原子地搬成 `target`。瞬时错误按线性退避重试；
 * 其它错误（如跨设备、路径不存在）立刻抛出，由调用方按各自语义处理。
 */
export function replaceFileAtomically(
  temporary: string,
  target: string,
  options: ReplaceFileOptions = {},
): void {
  const attempts = Math.max(1, options.attempts ?? 8);
  const delayMs = Math.max(0, options.delayMs ?? 8);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (!code || !TRANSIENT_CODES.has(code) || attempt === attempts) throw error;
      sleepSync(delayMs * attempt);
    }
  }
}
