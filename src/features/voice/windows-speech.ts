/**
 * 功能层：Windows 离线语音回退（本包新增，非上游移植）。
 *
 * 上游 Fairy 的语音只能来自本机 GPT-SoVITS（`127.0.0.1:9880`）。那个后端没部署时，
 * `/fairy-voice` 就只有接口可用，`say` 永远失败——「移植完成但用不了」。本模块补上
 * 唯一不需要任何后端的朗读路径：Windows 内置的 `System.Speech`（SAPI）。
 *
 * 定位与边界：
 *   - **回退，不是替代**。音色不是 Fairy 本人的音色，通知里会明确写出来；
 *     9880 可用时优先走上游路径，本模块不参与。
 *   - 朗读文本走**临时文件**而不是命令行参数：`say` 的输入是任意用户文本，
 *     拼进 `-Command` 会有引号与注入风险，落文件再让 PowerShell 按 UTF-8 读取最稳。
 *   - 只在 `win32` 上可用；其它平台 `available()` 返回 false。
 *   - 进程由命令触发时启动（Pi 的扩展生命周期要求），不在工厂里起进程；
 *     超时会 kill，被新的 `say` 取代时也会 kill。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export const FAIRY_SPEECH_DIR = join('fairy-voice', 'spoken');
export const DEFAULT_SPEECH_TIMEOUT_MS = 120_000;

/** 最小进程端口：默认真实 `child_process.spawn`，测试可注入桩。 */
export interface FairySpeechProcess {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type FairySpeechSpawn = (command: string, args: string[]) => FairySpeechProcess;

export interface WindowsSpeechOptions {
  /** 文本临时文件与朗读产物落地目录（应是 Fairy 自己的数据目录）。 */
  dataDir: string;
  diagnostics?: FairyDiagnostics;
  spawnImpl?: FairySpeechSpawn;
  /** SAPI 语速，-10..10，0 为正常。 */
  rate?: number;
  /** 单次朗读上限；超时即 kill，避免子进程悬挂。 */
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export interface WindowsSpeechResult {
  spoken: boolean;
  /** 未朗读成功时的原因（用于通知里如实说明）。 */
  reason?: string;
}

export interface WindowsSpeech {
  available(): boolean;
  /** 朗读文本。失败不抛出，返回 `{ spoken: false, reason }`。 */
  speak(text: string): Promise<WindowsSpeechResult>;
  /** 打断当前朗读（新的 say 取代旧朗读时调用）。 */
  cancel(): void;
}

/** PowerShell 单引号字符串里只有单引号需要转义。 */
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildSpeechScript(textFile: string, rate: number): string {
  return [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    `$s.Rate = ${Math.max(-10, Math.min(10, Math.round(rate)))}`,
    `$s.Speak([System.IO.File]::ReadAllText(${quotePowerShell(textFile)}, [System.Text.Encoding]::UTF8))`,
    '$s.Dispose()',
  ].join('; ');
}

export function createWindowsSpeech(options: WindowsSpeechOptions): WindowsSpeech {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-voice');
  const platform = options.platform ?? process.platform;
  const spawnImpl: FairySpeechSpawn =
    options.spawnImpl
    ?? ((command, args) => spawn(command, args, { stdio: 'ignore' }) as unknown as FairySpeechProcess);
  const rate = options.rate ?? 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SPEECH_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());

  let active: { kill: () => void } | undefined;
  const spokenDir = join(options.dataDir, FAIRY_SPEECH_DIR);

  const speak = async (text: string): Promise<WindowsSpeechResult> => {
    const source = typeof text === 'string' ? text.trim() : '';
    if (!source) return { spoken: false, reason: 'empty-text' };
    if (platform !== 'win32') return { spoken: false, reason: 'platform-unsupported' };

    const startedAt = diagnostics.start();
    let textFile: string | undefined;
    try {
      mkdirSync(spokenDir, { recursive: true });
      textFile = join(spokenDir, `${now()}-${process.pid}.txt`);
      writeFileSync(textFile, source, { encoding: 'utf8', mode: 0o600 });

      const result = await new Promise<WindowsSpeechResult>((resolve) => {
        let settled = false;
        const finish = (value: WindowsSpeechResult): void => {
          if (settled) return;
          settled = true;
          active = undefined;
          resolve(value);
        };
        let child: FairySpeechProcess;
        try {
          child = spawnImpl('powershell.exe', [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            buildSpeechScript(textFile!, rate),
          ]);
        } catch (error) {
          diagnostics.warn('speech.spawn', {}, error);
          finish({ spoken: false, reason: 'spawn-failed' });
          return;
        }

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // kill 失败也无能为力，交给超时结果说明。
          }
          diagnostics.warn('speech.timeout', { timeoutMs });
          finish({ spoken: false, reason: 'timeout' });
        }, timeoutMs);

        active = {
          kill: () => {
            clearTimeout(timer);
            try {
              child.kill();
            } catch {
              // kill 失败也无法让子进程立刻结束；此处仍按被打断结案。
            }
            finish({ spoken: false, reason: 'canceled' });
          },
        };

        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) finish({ spoken: true });
          else {
            diagnostics.warn('speech.exit', { code });
            finish({ spoken: false, reason: `exit-${String(code)}` });
          }
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          diagnostics.warn('speech.error', {}, error);
          finish({ spoken: false, reason: 'spawn-error' });
        });
      });

      return result;
    } catch (error) {
      diagnostics.warn('speech.failed', {}, error);
      return { spoken: false, reason: (error as { code?: string })?.code ?? 'unknown' };
    } finally {
      if (textFile) {
        try {
          rmSync(textFile, { force: true });
        } catch {
          // 清理失败不影响结果。
        }
      }
      diagnostics.metric('speech.spoken', startedAt, { platform });
    }
  };

  return {
    available: () => platform === 'win32',
    speak,
    cancel: () => {
      active?.kill();
      active = undefined;
    },
  };
}
