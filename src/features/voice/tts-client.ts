/**
 * 功能层：本地 GPT-SoVITS TTS 传输（上游 `dsh-fairy-voice/lib/server/local-tts-proxy.js`）。
 *
 * 上游把「探测本地服务 + 流式合成」封成 `createLocalTtsTransport()`，再在
 * `lib/index.js` 的 `/fairy-voice/tts` 处理器里把音频分片写进 `res`。Pi 没有 HTTP 端点，
 * 因此本模块：
 *   - 剥掉所有 `req`/`res`/`sendJson`/`statusFor`/`publicError` 相关部分；
 *   - 不移植 `createPcmStreamHandler` 写响应的分片逻辑，改为把**整段音频**攒成 `Uint8Array`；
 *   - 逐字保留上游的请求体语义（参考音频、参考提示词、流式分片参数）；
 *   - 把上游的超时/abort/错误码语义（`timeout`、`local-service-unavailable`、
 *     `local-service-failed`、`client-aborted`）改为**抛出带 `code` 的错误**，
 *     而不是写 HTTP 响应。
 *
 * 一处刻意差异：上游在注入自定义 `fetchImpl` 时会绕过超时与 abort 桥接
 * （`fetchImpl === fetch ? localFetch(...) : fetchImpl(...)`）。Pi 侧统一走桥接，
 * 否则注入桩也无法被 `ttsTimeoutMs` 与 `signal` 约束，内核就失去了取消能力。
 *
 * 安全：不读文件、不 import pi；参考音频路径**由调用方必填注入**，不设 `~/.dsh` 之类默认值。
 * 上游从 `~/.dsh/.../fairy_ref.txt` 读取参考提示词的部分属于宿主/端点层，已剥离，
 * 这里默认回退到 `REFERENCE_PROMPT_FALLBACK`。
 */

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export const LOCAL_TTS_URL = 'http://127.0.0.1:9880/tts';
export const LOCAL_DOCS_URL = 'http://127.0.0.1:9880/docs';
export const REFERENCE_PROMPT_FALLBACK = '根据用户协议，我无权回复该问题。主人将在合适的时间与合适的场合获知答案。';
export const TTS_TIMEOUT_MS = 180_000;
export const STATUS_TIMEOUT_MS = 3_000;

/** 上游 `lib/index.js` 第 498 行的不可用文案（与 `publicError['local-service-unavailable']` 同字面量）。 */
const UNAVAILABLE_REASON = '本地 Fairy 服务未启动。';

/** 原生 PCM 音频流的分片/采样率元信息（采样率取自 DSH 客户端解码常量 `lib/client.js`）。 */
export interface TtsStreamFormat {
  mediaType: 'raw';
  streamingMode: 1;
  fragmentInterval: 0.14;
  textSplitMethod: 'cut5';
  batchSize: 1;
  sampleRate: 32_000;
  bytesPerSample: 2;
}

const TTS_STREAM_FORMAT: TtsStreamFormat = {
  mediaType: 'raw',
  streamingMode: 1,
  fragmentInterval: 0.14,
  textSplitMethod: 'cut5',
  batchSize: 1,
  sampleRate: 32_000,
  bytesPerSample: 2,
};

export interface TtsStatus {
  available: boolean;
  /** 不可用时的文案（上游字面量）；可用时为 `null`。 */
  reason: string | null;
}

export interface TtsSynthesisResult {
  /** 整段音频字节，即上游分片写进 `res` 的那些 PCM/音频数据。 */
  audio: Uint8Array;
  /** 上游 `res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/raw')` 的取值。 */
  contentType: string;
  byteLength: number;
  format: TtsStreamFormat;
}

export interface TtsClientOptions {
  fetchImpl?: typeof fetch;
  ttsUrl?: string;
  docsUrl?: string;
  /** 参考音频路径。**必填**：Pi 侧不设任何默认路径。 */
  referenceAudioPath: string;
  referencePrompt?: string;
  ttsTimeoutMs?: number;
  statusTimeoutMs?: number;
  diagnostics?: FairyDiagnostics;
}

export interface TtsClient {
  /** 探测本地服务是否可用；失败不抛出，退化为 `{ available: false, reason }`。 */
  status(signal?: AbortSignal): Promise<TtsStatus>;
  /** 合成整段音频。`text` 需已由调用方归一化（见 `speech-text.ts`）。 */
  synthesize(text: string, signal?: AbortSignal): Promise<TtsSynthesisResult>;
}

function ttsError(message: string, code: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 父信号未携带字符串 reason（例如直接 `abort()`）时归一为上游的 `client-aborted`。 */
function abortReason(signal: AbortSignal | undefined): string {
  const reason: unknown = signal?.reason;
  return typeof reason === 'string' && reason ? reason : 'client-aborted';
}

interface LocalStreamHandle {
  response: Response;
  release: () => void;
  signal: AbortSignal;
}

/** 上游 `localFetch`：一次性请求 + 超时 + 父信号桥接，失败一律收敛为错误码。 */
async function localFetch(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = (): void => controller.abort(abortReason(parentSignal));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch {
    if (controller.signal.aborted) {
      const reason = abortReason(controller.signal);
      throw ttsError(reason, reason);
    }
    throw ttsError('local service unavailable', 'local-service-unavailable');
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  }
}

/**
 * 上游 `openLocalStream`：流式请求在 `fetch()` resolve 后仍处于活动状态，
 * 因此 `release()` 负责在消费方读完音频体之前持有父信号桥接。
 */
function openLocalStream(
  fetchImpl: typeof fetch,
  url: string,
  options: RequestInit,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
): Promise<LocalStreamHandle> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  const onAbort = (): void => controller.abort(abortReason(parentSignal));
  if (parentSignal?.aborted) onAbort();
  else parentSignal?.addEventListener('abort', onAbort, { once: true });
  const release = (): void => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', onAbort);
  };
  return fetchImpl(url, { ...options, signal: controller.signal })
    .catch(() => {
      release();
      if (controller.signal.aborted) {
        const reason = abortReason(controller.signal);
        throw ttsError(reason, reason);
      }
      throw ttsError('local service unavailable', 'local-service-unavailable');
    })
    .then((response) => ({ response, release, signal: controller.signal }));
}

/** 上游 `localTtsRequest(text)` 的请求体，逐字保留。 */
function localTtsRequest(text: string, referenceAudioPath: string, referencePrompt: string): string {
  return JSON.stringify({ text, text_lang: 'zh', ref_audio_path: referenceAudioPath, prompt_text: referencePrompt, prompt_lang: 'zh', text_split_method: 'cut5', batch_size: 1, media_type: 'raw', streaming_mode: 1, fragment_interval: 0.14, parallel_infer: false });
}

export function createTtsClient(options: TtsClientOptions): TtsClient {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-voice');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const ttsUrl = options.ttsUrl ?? LOCAL_TTS_URL;
  const docsUrl = options.docsUrl ?? LOCAL_DOCS_URL;
  const referenceAudioPath = options.referenceAudioPath;
  const referencePrompt = options.referencePrompt ?? REFERENCE_PROMPT_FALLBACK;
  const ttsTimeoutMs = options.ttsTimeoutMs ?? TTS_TIMEOUT_MS;
  const statusTimeoutMs = options.statusTimeoutMs ?? STATUS_TIMEOUT_MS;

  const status = async (signal?: AbortSignal): Promise<TtsStatus> => {
    const startedAt = diagnostics.start();
    try {
      const response = await localFetch(fetchImpl, docsUrl, { method: 'GET' }, statusTimeoutMs, signal);
      if (!response.ok) throw new Error(`Fairy status returned ${response.status}`);
      return { available: true, reason: null };
    } catch (error) {
      diagnostics.warn('status.request', {}, error);
      return { available: false, reason: UNAVAILABLE_REASON };
    } finally {
      diagnostics.metric('status.request', startedAt, {}, { thresholdMs: 100 });
    }
  };

  const synthesize = async (text: string, signal?: AbortSignal): Promise<TtsSynthesisResult> => {
    const startedAt = diagnostics.start();
    let handle: LocalStreamHandle | undefined;
    try {
      handle = await openLocalStream(fetchImpl, ttsUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: localTtsRequest(text, referenceAudioPath, referencePrompt),
      }, ttsTimeoutMs, signal);
      const { response, signal: streamSignal } = handle;
      if (!response.ok) throw ttsError('local synthesis failed', 'local-service-failed');
      const body = response.body;
      if (!body) throw ttsError('local synthesis returned no audio', 'local-service-failed');
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for await (const chunk of body) {
          const bytes = chunk as Uint8Array;
          chunks.push(bytes);
          length += bytes.byteLength;
        }
      } finally {
        // 上游 `createPcmStreamHandler` 的收尾语义：被打断的 async iterator 不会
        // 立刻关闭所有 fetch 实现的 body，显式 cancel 以便尽快释放 socket。
        if (streamSignal.aborted && typeof body.cancel === 'function') {
          await body.cancel().catch((error) => {
            if (!streamSignal.aborted && (error as { name?: string })?.name !== 'AbortError') throw error;
          });
        }
      }
      if (streamSignal.aborted) {
        const reason = abortReason(streamSignal);
        throw ttsError(reason, reason);
      }
      const audio = new Uint8Array(length);
      let offset = 0;
      for (const bytes of chunks) {
        audio.set(bytes, offset);
        offset += bytes.byteLength;
      }
      return {
        audio,
        contentType: response.headers.get('content-type') || 'audio/raw',
        byteLength: length,
        format: TTS_STREAM_FORMAT,
      };
    } catch (error) {
      const streamSignal = handle?.signal;
      if (streamSignal?.aborted) {
        const reason = abortReason(streamSignal);
        if (reason !== 'client-aborted' && reason !== 'superseded') {
          diagnostics.warn('tts.stream', { code: reason }, error);
        }
        throw ttsError(reason, reason);
      }
      const code = (error as { code?: string })?.code ?? 'local-service-failed';
      if (code !== 'client-aborted' && code !== 'superseded') {
        diagnostics.warn('tts.stream', { code }, error);
      }
      throw error;
    } finally {
      diagnostics.metric('tts.stream', startedAt, { aborted: handle?.signal.aborted === true });
      handle?.release();
    }
  };

  return { status, synthesize };
}
