/**
 * 功能层：Fairy 语音简报（上游 `dsh-fairy-voice/lib/server/voice-brief-fallback.js` 的
 * `createVoiceBriefFallback` 内核，加上 `lib/index.js` 第 44–47 行的 `configuredApiKey`）。
 *
 * 上游把它包在 `createVoiceBrainServerBoundary` 里，经 `/fairy-voice/brain/*` 端点
 * 读写 `~/.dsh/fairy-voice/voice-brain.json`。Pi 没有 HTTP 端点，也没有「从文件明文读密钥」
 * 的做法，所以本模块：
 *   - 剥掉端点与配置层（`status`/`configure`/`readConfig`/`writeConfig`/`clearConfig`、
 *     `~/.dsh` 路径、`chmod 0600` 之类全部不移植）；
 *   - 密钥改由 `resolveApiKey` 端口**惰性**注入（调用方通常接
 *     `ctx.modelRegistry.getApiKeyForProvider('deepseek')`）；本模块不读文件、不落日志、
 *     不把密钥放进任何返回值或诊断上下文；
 *   - `brief()` 直接返回简报字符串，即上游 HTTP 响应体里的 `brief` 字段。
 *
 * 提示词与上游逐字一致；上游的超时/abort 语义（`voice-brief-timeout` / `client-aborted`）
 * 与全部错误码 literal 原样保留。`markdownToSpeechText` 由调用方注入，避免与本模块循环依赖。
 */

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export const MAX_VOICE_BRIEF_INPUT_LENGTH = 32_000;
export const MAX_VOICE_BRIEF_OUTPUT_LENGTH = 260;
export const VOICE_BRIEF_TIMEOUT_MS = 6_500;
export const DEEPSEEK_V4_FLASH_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';

/** 上游 `lib/index.js` 第 44–47 行的密钥校验：trim 后长度 16–512 且不含 `\r`/`\n`/`\0`。 */
export function configuredApiKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  return key.length >= 16 && key.length <= 512 && !/[\r\n\0]/.test(key) ? key : '';
}

export interface VoiceBriefOptions {
  fetchImpl?: typeof fetch;
  /** 惰性解析密钥。空串/undefined 视为未配置。返回值只用于当次请求头，绝不落日志。 */
  resolveApiKey: () => Promise<string | undefined> | string | undefined;
  model?: string;
  endpoint?: string;
  maxInputLength?: number;
  maxOutputLength?: number;
  timeoutMs?: number;
  /** 由调用方注入的 markdown → 朗读文本函数（来自 `speech-text.ts`，避免循环依赖）。 */
  markdownToSpeechText: (markdown: unknown) => string;
  diagnostics?: FairyDiagnostics;
}

export interface VoiceBrief {
  /** 生成简报；未配置密钥等失败按上游语义抛出带 `code` 的错误。 */
  brief(markdown: unknown, signal?: AbortSignal): Promise<string>;
}

function voiceBriefError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

/** 父信号未携带字符串 reason（例如直接 `abort()`）时归一为上游的 `client-aborted`。 */
function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  return typeof reason === 'string' && reason ? reason : 'client-aborted';
}

/** 上游 `value?.choices?.[0]?.message?.content` 的取值，用 `unknown` 收口避免 `any`。 */
function readChoiceContent(value: unknown): unknown {
  const candidate = value as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
  return candidate?.choices?.[0]?.message?.content;
}

export function createVoiceBrief(options: VoiceBriefOptions): VoiceBrief {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-voice');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const model = options.model ?? DEEPSEEK_V4_FLASH_MODEL;
  const endpoint = options.endpoint ?? DEEPSEEK_CHAT_COMPLETIONS_URL;
  const maxInputLength = options.maxInputLength ?? MAX_VOICE_BRIEF_INPUT_LENGTH;
  const maxOutputLength = options.maxOutputLength ?? MAX_VOICE_BRIEF_OUTPUT_LENGTH;
  const timeoutMs = options.timeoutMs ?? VOICE_BRIEF_TIMEOUT_MS;

  const voiceBriefPrompt = (markdown: string): string => [
    '你是 Fairy 的语音简报模块。保持克制、自然、让人安心的 Fairy 语气，把用户已经看到的最终回答压缩为适合中文语音播报的简报。',
    '只保留一到三个最重要的信息：最终结论、必要数字或风险、明确下一步。删去背景、过程、重复说明、例子、补充解释和客套。',
    '不要添加原文没有的信息，不要解释压缩过程，不要使用 Markdown、标题、列表标记、引用、代码、链接或寒暄。',
    `默认控制在 80 到 180 个中文字符；仅在关键信息无法省略时延长，绝不超过 ${maxOutputLength} 个中文字符。中文自然口语，单段输出。`,
    '最终回答：',
    markdown,
  ].join('\n');

  const request = async (markdown: unknown, apiKey: string, signal?: AbortSignal): Promise<string> => {
    // Only speech-worthy prose crosses the optional cloud boundary.
    const source = options.markdownToSpeechText(markdown) || String(markdown || '').trim();
    if (!source) return '';
    if (Array.from(source).length > maxInputLength) {
      throw voiceBriefError('voice-brief-input-too-large');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('voice-brief-timeout'), timeoutMs);
    const abort = (): void => controller.abort(abortReason(signal));
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: '严格按用户要求输出可直接朗读的中文简报。' },
            { role: 'user', content: voiceBriefPrompt(source) },
          ],
          temperature: 0.2,
          max_tokens: 400,
          thinking: { type: 'disabled' },
        }),
        signal: controller.signal,
      });
      const value: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw voiceBriefError('voice-brief-request-failed');
      const brief = options.markdownToSpeechText(readChoiceContent(value));
      if (!brief) throw voiceBriefError('voice-brief-empty');
      return Array.from(brief).slice(0, maxOutputLength).join('');
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = abortReason(controller.signal);
        throw voiceBriefError(reason);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  };

  return {
    async brief(markdown, signal) {
      const startedAt = diagnostics.start();
      try {
        const apiKey = configuredApiKey(await options.resolveApiKey());
        if (!apiKey) throw voiceBriefError('voice-brief-unconfigured');
        return await request(markdown, apiKey, signal);
      } catch (error) {
        const code = (error as { code?: string })?.code;
        if (code !== 'client-aborted') diagnostics.warn('voice-brief.request', { code }, error);
        throw error;
      } finally {
        diagnostics.metric('voice-brief.request', startedAt, { aborted: signal?.aborted === true });
      }
    },
  };
}
