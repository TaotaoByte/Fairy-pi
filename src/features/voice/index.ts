/**
 * 功能层：Fairy 语音（上游 `dsh-fairy-voice` 的 Pi 移植）。
 *
 * 上游是一个 HTTP 服务：`webServer.register` 暴露 `/fairy-voice/{status,prepare,tts}` 与
 * `/fairy-voice/brain/{...}`，用 `req/res` 收发；客户端（DSH 前端）拿到 PCM 分片后在浏览器里
 * 解码播放。**Pi 没有 HTTP 端点注册能力，也没有浏览器客户端**，所以端到端只能这样落地：
 *   - 内核（文本管线、TTS 传输、语音简报）原样移植，见 `speech-text.ts` / `tts-client.ts` /
 *     `voice-brief.ts`，三者都可离线单测；
 *   - 端点层改为 `/fairy-voice` 命令的 `status` / `say` / `brief` 三个子命令；
 *   - 「客户端解码播放」改为把整段音频落成 **WAV 文件**并回传路径（上游客户端声明的
 *     32000Hz/16bit 元信息用来补一个 44 字节 RIFF 头，原始 PCM 直接写盘在 Windows 上无法播放）；
 *   - 上游 `~/.dsh/fairy-voice/runtime/reference/` 的参考音频与参考提示词改到 Fairy 自己的
 *     数据目录下（`<dataDir>/fairy-voice/runtime/reference/`），且不写 pi 的 `agent_data`。
 *
 * 保留的上游编排语义：最新一次 `say` 会 abort 上一段（reason `superseded`），因为本地
 * GPT-SoVITS 只有一条推理管线，并发会互相污染（上游第 481–483 行的注释所述原因）。
 *
 * 现状说明：`http://127.0.0.1:9880` 后端未部署，`status` 会如实返回「未启动」。
 * 这不是缺陷，是上游设计里本地服务缺失时的既有行为（上游同样回 `{ available: false }`）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import { attachFairySession } from '../../adapters/index.ts';
import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';
import {
  REFERENCE_PROMPT_FALLBACK,
  createTtsClient,
  type TtsClient,
  type TtsStatus,
  type TtsSynthesisResult,
} from './tts-client.ts';
import {
  createVoiceBrief,
  type VoiceBrief,
  type VoiceBriefOptions,
} from './voice-brief.ts';
import { markdownToSpeechText, normalizeSpeechText, splitSpeechSentences } from './speech-text.ts';
import {
  DEFAULT_SPEECH_TIMEOUT_MS,
  createWindowsSpeech,
  type FairySpeechSpawn,
  type WindowsSpeech,
} from './windows-speech.ts';

export {
  LOCAL_DOCS_URL,
  LOCAL_TTS_URL,
  REFERENCE_PROMPT_FALLBACK,
  STATUS_TIMEOUT_MS,
  TTS_TIMEOUT_MS,
  createTtsClient,
} from './tts-client.ts';
export type {
  TtsClient,
  TtsClientOptions,
  TtsStatus,
  TtsStreamFormat,
  TtsSynthesisResult,
} from './tts-client.ts';
export {
  DEEPSEEK_CHAT_COMPLETIONS_URL,
  DEEPSEEK_V4_FLASH_MODEL,
  MAX_VOICE_BRIEF_INPUT_LENGTH,
  MAX_VOICE_BRIEF_OUTPUT_LENGTH,
  VOICE_BRIEF_TIMEOUT_MS,
  configuredApiKey,
  createVoiceBrief,
} from './voice-brief.ts';
export type { VoiceBrief, VoiceBriefOptions } from './voice-brief.ts';
export { markdownToSpeechText, normalizeSpeechText, splitSpeechSentences } from './speech-text.ts';
export {
  DEFAULT_SPEECH_TIMEOUT_MS,
  FAIRY_SPEECH_DIR,
  buildSpeechScript,
  createWindowsSpeech,
} from './windows-speech.ts';
export type {
  FairySpeechProcess,
  FairySpeechSpawn,
  WindowsSpeech,
  WindowsSpeechOptions,
  WindowsSpeechResult,
} from './windows-speech.ts';

/** 触发离线语音回退的上游错误码：后端没起、超时、合成失败。 */
export const TTS_FALLBACK_CODES = new Set(['local-service-unavailable', 'timeout', 'local-service-failed']);

export const FAIRY_VOICE_COMMAND = 'fairy-voice';

/** 参考音频/提示词相对 Fairy 数据目录的位置（对齐上游 `runtime/reference/` 布局）。 */
export const FAIRY_VOICE_REFERENCE_AUDIO = join('fairy-voice', 'runtime', 'reference', 'fairy_ref.wav');
export const FAIRY_VOICE_REFERENCE_PROMPT = join('fairy-voice', 'runtime', 'reference', 'fairy_ref.txt');
export const FAIRY_VOICE_OUTPUT_DIR = join('fairy-voice', 'out');

export interface FairyVoicePaths {
  referenceAudioPath: string;
  referencePromptPath: string;
  outputDir: string;
}

export function fairyVoicePaths(dataDir: string): FairyVoicePaths {
  return {
    referenceAudioPath: join(dataDir, FAIRY_VOICE_REFERENCE_AUDIO),
    referencePromptPath: join(dataDir, FAIRY_VOICE_REFERENCE_PROMPT),
    outputDir: join(dataDir, FAIRY_VOICE_OUTPUT_DIR),
  };
}

/** 上游 `readReferencePrompt()`：读不到就用 `REFERENCE_PROMPT_FALLBACK` 并记警告。 */
export function readReferencePrompt(path: string, diagnostics: FairyDiagnostics): string {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch (error) {
    diagnostics.warn('reference.prompt.load', { file: 'fairy_ref.txt', fallback: true }, error);
    return REFERENCE_PROMPT_FALLBACK;
  }
}

export function formatFairyVoiceStatus(status: TtsStatus): string {
  return status.available
    ? 'Fairy 本地语音服务可用。'
    : `Fairy 本地语音服务不可用：${status.reason ?? '未知原因'}`;
}

function writeWavChunk(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}

/**
 * 把上游客户端解码用的 32000Hz/16bit 原始 PCM 补上 RIFF 头。
 * 非 raw 的响应（服务端已给出 wav/mp3）在调用处直接原样落盘，不走这里。
 */
export function buildWavFile(audio: Uint8Array, format: TtsSynthesisResult['format']): Uint8Array {
  const channels = 1;
  const blockAlign = channels * format.bytesPerSample;
  const byteRate = format.sampleRate * blockAlign;
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  writeWavChunk(view, 0, 'RIFF');
  view.setUint32(4, 36 + audio.byteLength, true);
  writeWavChunk(view, 8, 'WAVE');
  writeWavChunk(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, format.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, format.bytesPerSample * 8, true);
  writeWavChunk(view, 36, 'data');
  view.setUint32(40, audio.byteLength, true);

  const file = new Uint8Array(header.byteLength + audio.byteLength);
  file.set(header, 0);
  file.set(audio, header.byteLength);
  return file;
}

export interface FairyVoiceOptions {
  /** Fairy 数据目录（参考音频、输出音频都落在这里）。 */
  dataDir: string;
  diagnostics?: FairyDiagnostics;
  fetchImpl?: typeof fetch;
  ttsUrl?: string;
  docsUrl?: string;
  /** `brief` 取密钥用的供应商 id，默认 `deepseek`。 */
  provider?: string;
  now?: () => Date;
  /** 本地 TTS 失败时是否改用 Windows 内置语音，默认 win32 上开启（本包新增的回退）。 */
  speechFallback?: boolean;
  /** 回退用的进程端口，测试注入用。 */
  speechSpawnImpl?: FairySpeechSpawn;
  /** 平台覆盖，测试注入用。 */
  platform?: NodeJS.Platform;
}

/** 命令子语义，便于单测直接调用而不必解析字符串。 */
export interface FairyVoiceCommandHandlers {
  status(ctx: ExtensionContext): Promise<void>;
  say(text: string, ctx: ExtensionContext): Promise<void>;
  brief(markdown: string, ctx: ExtensionContext): Promise<void>;
}

export interface FairyVoiceRuntime {
  command: string;
  handlers: FairyVoiceCommandHandlers;
}

function usageText(): string {
  return [
    'Fairy 语音用法：',
    '  /fairy-voice status           探测本地语音服务',
    '  /fairy-voice say <文本>       合成并写出 WAV 文件（本地 TTS 不可用时回退到 Windows 语音）',
    '  /fairy-voice brief <Markdown> 生成适合朗读的中文简报',
  ].join('\n');
}

/**
 * 组装语音功能。与其它 feature 一致：只注册命令与订阅，不在这里创建长生命周期资源；
 * TTS 客户端与 brief 都挂在会话作用域上。
 */
export function applyFairyVoice(pi: ExtensionAPI, options: FairyVoiceOptions): FairyVoiceRuntime {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-voice');
  const now = options.now ?? (() => new Date());
  const provider = options.provider ?? 'deepseek';
  const paths = fairyVoicePaths(options.dataDir);

  let client: TtsClient | undefined;
  let voiceBrief: VoiceBrief | undefined;
  let activeSay: AbortController | undefined;

  const platform = options.platform ?? process.platform;
  const speech: WindowsSpeech = createWindowsSpeech({
    dataDir: options.dataDir,
    diagnostics,
    ...(options.speechSpawnImpl ? { spawnImpl: options.speechSpawnImpl } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
  });
  const speechFallback = options.speechFallback ?? platform === 'win32';

  attachFairySession(pi, {
    diagnostics,
    label: 'fairy-voice',
    onStart: (scope, ctx) => {
      client = createTtsClient({
        referenceAudioPath: paths.referenceAudioPath,
        referencePrompt: readReferencePrompt(paths.referencePromptPath, diagnostics),
        diagnostics,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.ttsUrl ? { ttsUrl: options.ttsUrl } : {}),
        ...(options.docsUrl ? { docsUrl: options.docsUrl } : {}),
      });
      voiceBrief = createVoiceBrief({
        resolveApiKey: () => readProviderApiKey(ctx, provider, diagnostics),
        markdownToSpeechText,
        diagnostics,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      } satisfies VoiceBriefOptions);
      scope.register('voice-client', () => {
        activeSay?.abort('disposed');
        activeSay = undefined;
        speech.cancel();
        client = undefined;
        voiceBrief = undefined;
      });
      diagnostics.info('enable', { dataDir: options.dataDir, reference: paths.referenceAudioPath });
    },
  });

  const handlers: FairyVoiceCommandHandlers = {
    async status(ctx) {
      const status = client ? await client.status() : { available: false, reason: '未启动会话。' };
      ctx.ui.notify(formatFairyVoiceStatus(status), status.available ? 'info' : 'warning');
    },

    async say(text, ctx) {
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (!trimmed) {
        ctx.ui.notify(usageText(), 'warning');
        return;
      }
      if (!client) {
        ctx.ui.notify('Fairy 语音未就绪：缺少活动会话。', 'warning');
        return;
      }

      // 上游「最新意图取消上一段」：本地推理管线是单条可变状态。
      activeSay?.abort('superseded');
      speech.cancel();
      const controller = new AbortController();
      activeSay = controller;
      const spoken = normalizeSpeechText(markdownToSpeechText(trimmed));
      try {
        const result = await client.synthesize(spoken, controller.signal);
        const isRaw = result.format.mediaType === 'raw' && !/wav|mpeg|mp3|ogg/i.test(result.contentType);
        const extension = isRaw ? 'wav' : (result.contentType.split('/')[1] || 'bin');
        const bytes = isRaw ? buildWavFile(result.audio, result.format) : result.audio;

        mkdirSync(paths.outputDir, { recursive: true });
        const stamp = now().toISOString().replaceAll(/[:.]/g, '-');
        const file = join(paths.outputDir, `${stamp}.${extension}`);
        writeFileSync(file, bytes, { mode: 0o600 });

        ctx.ui.notify(
          `Fairy 语音已合成：${result.byteLength} 字节（${result.format.sampleRate}Hz）\n${file}`,
          'info',
        );
        diagnostics.info('speech.write', {
          file,
          byteLength: result.byteLength,
          sentences: splitSpeechSentences(spoken).length,
        });
      } catch (error) {
        const code = (error as { code?: string })?.code ?? 'unknown';
        if (code === 'superseded' || code === 'client-aborted') return;

        // 上游路径失败（最常见：9880 后端没起）→ 用本机离线语音朗读，别让 say 变成死路。
        if (speechFallback && speech.available() && TTS_FALLBACK_CODES.has(code)) {
          const fallback = await speech.speak(spoken);
          if (fallback.spoken) {
            ctx.ui.notify(
              `Fairy 语音：本地 TTS 不可用（${code}），已改用 Windows 内置语音朗读。\n注意：这不是 Fairy 的音色。`,
              'warning',
            );
            return;
          }
          if (fallback.reason === 'canceled') return;
          ctx.ui.notify(
            `Fairy 语音不可用：本地 TTS（${code}），Windows 语音回退也失败（${fallback.reason}）。`,
            'error',
          );
          return;
        }
        ctx.ui.notify(`Fairy 语音合成失败：${code}`, 'error');
      } finally {
        if (activeSay === controller) activeSay = undefined;
      }
    },

    async brief(markdown, ctx) {
      if (!markdown || !markdown.trim()) {
        ctx.ui.notify(usageText(), 'warning');
        return;
      }
      try {
        const brief = voiceBrief ? await voiceBrief.brief(markdown) : '';
        if (!brief) {
          ctx.ui.notify('Fairy 语音简报未就绪：缺少活动会话。', 'warning');
          return;
        }
        ctx.ui.notify(brief, 'info');
      } catch (error) {
        ctx.ui.notify(`Fairy 语音简报失败：${(error as { code?: string })?.code ?? 'unknown'}`, 'error');
      }
    },
  };

  pi.registerCommand(FAIRY_VOICE_COMMAND, {
    description: 'Fairy 语音：探测本地服务、合成音频、生成朗读简报',
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = (args ?? '').trim().split(/\s+/);
      const payload = rest.join(' ');
      if (subcommand === 'say') {
        await handlers.say(payload, ctx);
        return;
      }
      if (subcommand === 'brief') {
        await handlers.brief(payload, ctx);
        return;
      }
      if (subcommand && subcommand !== 'status') {
        ctx.ui.notify(usageText(), 'warning');
        return;
      }
      await handlers.status(ctx);
    },
  });

  return { command: FAIRY_VOICE_COMMAND, handlers };
}

async function readProviderApiKey(
  ctx: ExtensionContext,
  provider: string,
  diagnostics: FairyDiagnostics,
): Promise<string | undefined> {
  try {
    return await ctx.modelRegistry.getApiKeyForProvider(provider);
  } catch (error) {
    diagnostics.warn('voice.credentials', { provider }, error);
    return undefined;
  }
}
