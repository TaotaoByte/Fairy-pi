/**
 * Fairy-pi 入口：Fairy-DSH 在 Pi 上的移植。
 *
 * 只做装配，不含业务逻辑：
 *   - 数据目录来自 `FAIRY_PI_DATA_DIR` 或 `~/.fairy-pi`（**不写** pi 的 `agent_data`）；
 *   - 四个功能各自注册命令与订阅，长生命周期资源都挂在会话作用域上；
 *   - 人格语料由包内的 `assets/persona/` 提供（相对本文件解析，随包分发）。
 *
 * 工厂里不做 IO、不起进程/socket/定时器：Pi 会在不启动会话的情况下加载扩展，
 * 这些动作留给各功能在 `session_start` 里完成。
 *
 * 用法：
 *   pi -e ./            # 单次试载本包
 *   pi install ./       # 本地安装（会写入 settings.json，需要你确认后再执行）
 *
 * 命令一览：
 *   /fairy-balance   余额与当日用量估算
 *   /fairy-voice     本地语音服务状态、合成音频、朗读简报
 *   /fairy-persona   人设开关、语料与将注入的段落
 *   /fairy-browser   浏览器坞状态、控制命令、MCP 注册情况
 */

import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { resolveFairyDataDir } from './src/adapters/index.ts';
import { createFairyDiagnostics } from './src/contracts/index.ts';
import type { FairyDiagnostics } from './src/contracts/index.ts';
import { applyFairyBalance } from './src/features/balance/index.ts';
import { applyFairyBrowserDock } from './src/features/browser/index.ts';
import { applyFairyPersona } from './src/features/persona/index.ts';
import { applyFairyVoice } from './src/features/voice/index.ts';

/** 人格语料目录（随包分发，见 NOTICE）。 */
export const FAIRY_PI_ASSETS_DIR = fileURLToPath(new URL('./assets/persona/', import.meta.url));

/** 浏览器坞生产者（通用 MCP 代理），被注册为 stdio MCP 服务器。 */
export const FAIRY_PI_BROWSER_PRODUCER = fileURLToPath(new URL('./src/features/browser/dock-producer.cjs', import.meta.url));

/**
 * 目标 MCP 命令的 JSON 数组，例如：
 *   FAIRY_PI_BROWSER_MCP_ARGS='["npx","@playwright/mcp@latest"]'
 * 设了这个才会注册生产者；不设就不注册（默认不引入浏览器自动化）。
 */
export const FAIRY_PI_BROWSER_MCP_ENV = 'FAIRY_PI_BROWSER_MCP_ARGS';

/** 读环境变量里的目标 MCP 命令；格式不对就警告并当作未设置。 */
export function readBrowserMcpArgs(
  env: NodeJS.ProcessEnv = process.env,
  diagnostics: FairyDiagnostics = createFairyDiagnostics('fairy-pi'),
): string[] | undefined {
  const raw = env[FAIRY_PI_BROWSER_MCP_ENV];
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {
    // 落到下面的警告。
  }
  diagnostics.warn('browser.mcp.invalid', { env: FAIRY_PI_BROWSER_MCP_ENV });
  return undefined;
}

export default function fairyPi(pi: ExtensionAPI): void {
  const dataDir = resolveFairyDataDir();
  const diagnostics = createFairyDiagnostics('fairy-pi');
  diagnostics.info('enable', { dataDir, assetsDir: FAIRY_PI_ASSETS_DIR });

  const browserMcpArgs = readBrowserMcpArgs(process.env, diagnostics);
  if (browserMcpArgs) {
    diagnostics.info('browser.mcp', { target: browserMcpArgs[0] });
  }

  applyFairyBalance(pi, { dataDir });
  applyFairyVoice(pi, { dataDir });
  applyFairyPersona(pi, { assetsDir: FAIRY_PI_ASSETS_DIR });
  applyFairyBrowserDock(pi, {
    dataDir,
    ...(browserMcpArgs
      ? { mcp: { config: { command: process.execPath, args: [FAIRY_PI_BROWSER_PRODUCER, ...browserMcpArgs] } } }
      : {}),
  });
}
