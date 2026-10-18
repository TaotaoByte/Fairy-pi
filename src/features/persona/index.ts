/**
 * 功能层：Fairy 人格（上游 `.agent-presets/fairy/` 预设的 Pi 移植）。
 *
 * 上游的做法是「常驻人设 + 语料驱动的检索内核」：`@deepseek-ai/dsh-persona` 提供常驻文本，
 * `runtime/fairy_core.py` 从 `assets` 语料里按 `fidelity: strict`、`exampleLimit: 2` 选样。
 * 公开仓库缺 `runtime/`（已核对），因此内核不可移植，这里落地为可验证的降级版：
 *   - 人设正文逐字保留（见 `persona-prompt.ts`）；
 *   - 语料随包分发并生成**有上界**的摘要；
 *   - 注入走 Pi 官方推荐的 `before_agent_start` 提示词**段落**（`systemPromptOptions.sections`），
 *     而不是整体替换 `systemPrompt`，这样 Pi 仍能记录结构化段落与增量。
 *
 * 与上游的两处刻意差异：
 *   1. **默认关闭**。上游预设是常驻的，但把某个角色人设强加给每一次会话不是合理默认值，
 *      改为会话级开关（`/fairy-persona on`），状态**不持久化**，新会话回到关闭。
 *   2. 不注册任何 DSH 的 slot/UI 挂载点；语料全文交给模型按需读取（`corpus` 子命令列出路径）。
 */

import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';
import {
  DEFAULT_DIGEST_MAX_RULES,
  FAIRY_CORPUS_FILES,
  fairyCorpusExists,
  loadFairyCorpus,
  renderFairyCorpusDigest,
  summarizeFairyCorpus,
  type FairyCorpus,
} from './corpus.ts';
import { FAIRY_PERSONA_PROMPT, FAIRY_PERSONA_SECTION_TAG, buildFairyPersonaSection } from './persona-prompt.ts';

export {
  DEFAULT_DIGEST_MAX_CHARS,
  DEFAULT_DIGEST_MAX_RULES,
  FAIRY_CORPUS_FILES,
  collectLeafFacts,
  fairyCorpusExists,
  loadFairyCorpus,
  renderFairyCorpusDigest,
  summarizeFairyCorpus,
} from './corpus.ts';
export type {
  FairyCorpus,
  FairyCorpusDigestOptions,
  FairyCorpusEntry,
  FairyCorpusFileSpec,
  FairyCorpusSummary,
  FairyCorpusDigestOptions as FairyDigestOptions,
  LeafFactOptions,
} from './corpus.ts';
export { FAIRY_PERSONA_PROMPT, FAIRY_PERSONA_SECTION_TAG, buildFairyPersonaSection } from './persona-prompt.ts';

export const FAIRY_PERSONA_COMMAND = 'fairy-persona';

/** 相对包根的语料目录；由入口传入绝对路径。 */
export const FAIRY_PERSONA_ASSETS_DIR = join('assets', 'persona');

export const DEFAULT_PERSONA_SECTION_MAX_CHARS = 8_000;

export interface FairyPersonaOptions {
  /** `assets/persona` 的绝对路径。 */
  assetsDir: string;
  diagnostics?: FairyDiagnostics;
  /** 初始开关状态，默认 false。 */
  enabled?: boolean;
  maxDigestChars?: number;
  maxRules?: number;
  maxSectionChars?: number;
}

export interface FairyPersonaRuntime {
  command: string;
  isEnabled(): boolean;
  setEnabled(value: boolean): void;
  /** 当前语料摘要（懒加载）。 */
  digest(): string;
  /** 丢弃缓存的语料，下次读取重新载入。 */
  reload(): void;
  /** 供单测与命令复用。 */
  corpus(): FairyCorpus;
}

function usageText(): string {
  return [
    'Fairy 人格用法：',
    '  /fairy-persona status    查看开关与语料状态',
    '  /fairy-persona on|off    本次会话启用/关闭人设注入',
    '  /fairy-persona digest    预览将注入的段落（人设 + 语料摘要）',
    '  /fairy-persona corpus    列出语料文件绝对路径',
    '  /fairy-persona reload    重新载入语料',
  ].join('\n');
}

export function applyFairyPersona(pi: ExtensionAPI, options: FairyPersonaOptions): FairyPersonaRuntime {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-persona');
  let enabled = options.enabled === true;

  let cached: FairyCorpus | undefined;
  let cachedDigest: string | undefined;

  const corpus = (): FairyCorpus => {
    cached ??= loadFairyCorpus(options.assetsDir, { diagnostics });
    return cached;
  };

  const digest = (): string => {
    cachedDigest ??= renderFairyCorpusDigest(corpus(), {
      ...(options.maxDigestChars !== undefined ? { maxChars: options.maxDigestChars } : {}),
      ...(options.maxRules !== undefined ? { maxRules: options.maxRules } : {}),
    });
    return cachedDigest;
  };

  const statusText = (): string => {
    const summary = summarizeFairyCorpus(corpus());
    const loaded = summary.filter((entry) => entry.loaded).length;
    const bytes = summary.reduce((sum, entry) => sum + entry.byteLength, 0);
    return [
      `Fairy 人格：${enabled ? '已启用' : '已关闭'}（会话级，不持久化）`,
      `语料：${loaded}/${summary.length} 已载入，共 ${bytes} 字节`,
      `语料目录：${options.assetsDir}${fairyCorpusExists(options.assetsDir) ? '' : '（目录不存在）'}`,
    ].join('\n');
  };

  const corpusText = (): string => {
    const byId = new Map(FAIRY_CORPUS_FILES.map((spec) => [spec.id, spec]));
    return summarizeFairyCorpus(corpus())
      .map((entry) => {
        const spec = byId.get(entry.id);
        const state = entry.loaded
          ? `${entry.byteLength} 字节${entry.schemaVersion ? `，schema ${entry.schemaVersion}` : ''}`
          : '载入失败（详见日志）';
        return `- ${entry.id}（${state}）：${spec?.purpose ?? ''}\n  ${join(options.assetsDir, spec?.path ?? '')}`;
      })
      .join('\n');
  };

  const notify = (ctx: ExtensionContext, message: string, type: 'info' | 'warning' | 'error' = 'info'): void => {
    ctx.ui.notify(message, type);
  };

  pi.on('before_agent_start', (event) => {
    if (!enabled) return;
    const loaded = corpus().entries.filter((entry) => entry.loaded);
    if (loaded.length === 0) {
      diagnostics.warn('inject.skipped', { reason: 'corpus-unavailable', assetsDir: options.assetsDir });
      return;
    }
    const section = buildFairyPersonaSection(digest(), {
      maxChars: options.maxSectionChars ?? DEFAULT_PERSONA_SECTION_MAX_CHARS,
    });
    // 只写入自己的段落，绝不返回 systemPrompt：整体替换会丢掉 Pi 的结构化段落与增量记录。
    event.systemPromptOptions.sections[FAIRY_PERSONA_SECTION_TAG] = section;
    diagnostics.info('inject', {
      chars: section.length,
      corpusFiles: loaded.length,
    });
  });

  pi.registerCommand(FAIRY_PERSONA_COMMAND, {
    description: 'Fairy 人格：开关人设注入、查看语料与将注入的段落',
    handler: async (args, ctx) => {
      const [subcommand] = (args ?? '').trim().split(/\s+/);
      switch (subcommand) {
        case '':
        case 'status':
          notify(ctx, statusText());
          return;
        case 'on':
          enabled = true;
          notify(ctx, `Fairy 人格已启用。\n${statusText()}`);
          return;
        case 'off':
          enabled = false;
          notify(ctx, 'Fairy 人格已关闭。');
          return;
        case 'digest':
          notify(ctx, buildFairyPersonaSection(digest(), {
            maxChars: options.maxSectionChars ?? DEFAULT_PERSONA_SECTION_MAX_CHARS,
          }));
          return;
        case 'corpus':
          notify(ctx, `Fairy 语料（${options.assetsDir}）：\n${corpusText()}`);
          return;
        case 'reload':
          cached = undefined;
          cachedDigest = undefined;
          notify(ctx, `语料已重新载入。\n${statusText()}`);
          return;
        default:
          notify(ctx, usageText(), 'warning');
      }
    },
  });

  return {
    command: FAIRY_PERSONA_COMMAND,
    isEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = value === true;
    },
    digest,
    reload: () => {
      cached = undefined;
      cachedDigest = undefined;
    },
    corpus,
  };
}
