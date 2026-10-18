/**
 * 适配层：平台与路径语义。
 *
 * 上游（Fairy-DSH）把全部运行时状态放在 `DSH_HOME`（默认 `~/.dsh`）下：
 * `fairy-voice` 写 `~/.dsh/fairy-voice/runtime/...`、`balance-meter` 写
 * `~/.dsh/balance-meter-daily.json`、`browser-dock` 写 `~/.dsh/browser-dock/state.json`。
 * `DSH_HOME` 是 DSH 宿主给的，Pi 没有对应物，所以这里必须显式决定数据目录，
 * 而不是隐式借用 pi 的 `agent_data`（该目录不在本包的可写范围内）。
 *
 * 本模块只做「归一化 + 路径解析」，不含 IO。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** 本包使用的平台词汇，只区分 Windows 与类 Unix。 */
export type FairyPlatform = 'windows' | 'posix' | 'unknown';

/** 覆盖 Fairy 数据目录的环境变量，优先级高于一切默认值。 */
export const FAIRY_DATA_DIR_ENV_VAR = 'FAIRY_PI_DATA_DIR';

/** 默认数据目录名。刻意不用 `~/.dsh`，避免与 DSH 宿主状态互相污染。 */
export const FAIRY_DATA_DIR_NAME = '.fairy-pi';

export type FairyDataScope = 'global' | 'project';

export interface ResolveFairyDataDirOptions {
  scope?: FairyDataScope;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  cwd?: string;
}

export interface FairyPlatformInfo {
  platform: FairyPlatform;
  isWindows: boolean;
  /** `path.sep` 的等价物，避免为了一个字符去 import node:path。 */
  pathSeparator: '\\' | '/';
  /** 已经解析好的 Fairy 数据目录（global 作用域）。 */
  dataDir: string;
}

export function normalizePlatform(raw: string | undefined): FairyPlatform {
  if (raw === 'win32') return 'windows';
  if (raw === 'darwin' || raw === 'linux' || raw === 'freebsd' || raw === 'openbsd') return 'posix';
  return 'unknown';
}

export function resolveFairyDataDir(options: ResolveFairyDataDirOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env[FAIRY_DATA_DIR_ENV_VAR];
  if (typeof override === 'string' && override.trim() !== '') return override.trim();

  const scope = options.scope ?? 'global';
  if (scope === 'project') {
    return join(options.cwd ?? process.cwd(), FAIRY_DATA_DIR_NAME);
  }
  return join(options.homeDir ?? homedir(), FAIRY_DATA_DIR_NAME);
}

export function detectPlatform(options: ResolveFairyDataDirOptions = {}): FairyPlatformInfo {
  const platform = normalizePlatform(process.platform);
  return {
    platform,
    isWindows: platform === 'windows',
    pathSeparator: platform === 'windows' ? '\\' : '/',
    dataDir: resolveFairyDataDir(options),
  };
}

/** 供诊断日志使用的单行描述。 */
export function describePlatform(info: FairyPlatformInfo): string {
  return `${info.platform} data=${info.dataDir}`;
}
