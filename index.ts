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
import { applyFairyBalance } from './src/features/balance/index.ts';
import { applyFairyBrowserDock } from './src/features/browser/index.ts';
import { applyFairyPersona } from './src/features/persona/index.ts';
import { applyFairyVoice } from './src/features/voice/index.ts';

/** 人格语料目录（随包分发，见 NOTICE）。 */
export const FAIRY_PI_ASSETS_DIR = fileURLToPath(new URL('./assets/persona/', import.meta.url));

export default function fairyPi(pi: ExtensionAPI): void {
  const dataDir = resolveFairyDataDir();
  const diagnostics = createFairyDiagnostics('fairy-pi');
  diagnostics.info('enable', { dataDir, assetsDir: FAIRY_PI_ASSETS_DIR });

  applyFairyBalance(pi, { dataDir });
  applyFairyVoice(pi, { dataDir });
  applyFairyPersona(pi, { assetsDir: FAIRY_PI_ASSETS_DIR });
  applyFairyBrowserDock(pi, { dataDir });
}
