/**
 * voice 移植单测。
 *
 * 覆盖四层：文本管线（期望值取自与上游的逐输入对照结果）、TTS 传输、
 * 语音简报、以及端到端的 `applyFairyVoice`（含「最新意图取消上一段」与 WAV 落盘）。
 *
 * 期望值是**上游行为的快照**，其中若干看起来「怪」的结果（`第二句!` 半角、
 * `负 负二百七十三点一五` 重复、千分位逗号被转全角）都是上游原样行为，
 * 断言它们的目的正是防止后人「顺手优化」而破坏移植一致性。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAIRY_LOG_PREFIX, createFairyDiagnostics } from '../src/contracts/index.ts';
import type { FairyLogRecord } from '../src/contracts/index.ts';
import {
  FAIRY_VOICE_COMMAND,
  TTS_FALLBACK_CODES,
  buildSpeechScript,
  buildWavFile,
  createTtsClient,
  createVoiceBrief,
  createWindowsSpeech,
  configuredApiKey,
  fairyVoicePaths,
  formatFairyVoiceStatus,
  markdownToSpeechText,
  normalizeSpeechText,
  readReferencePrompt,
  splitSpeechSentences,
  applyFairyVoice,
} from '../src/features/voice/index.ts';
import type { FairySpeechProcess } from '../src/features/voice/index.ts';

function createTestDiagnostics(moduleName = 'fairy-pi-test') {
  const records: FairyLogRecord[] = [];
  const lines: string[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      const line = String(args[0]);
      lines.push(line);
      if (!line.startsWith(`${FAIRY_LOG_PREFIX} `)) return;
      records.push(JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as FairyLogRecord);
    };
  const sink = { info: collect(), log: collect(), warn: collect(), error: collect() };
  return {
    diagnostics: createFairyDiagnostics(moduleName, { sink }),
    records,
    text: () => lines.join('\n'),
  };
}

const HANGING = (init: RequestInit): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const fail = (): void => {
      const error = new Error('aborted') as Error & { name: string };
      error.name = 'AbortError';
      reject(error);
    };
    if (init.signal?.aborted) {
      fail();
      return;
    }
    init.signal?.addEventListener('abort', fail);
  });

function fetchReturning(handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  return (async (input: unknown, init: RequestInit) => await handler(String(input), init)) as unknown as typeof fetch;
}

// ---------- 文本管线 ----------

test('normalizeSpeechText 输出与上游一致（罗马数字、缩写、时间、数值）', () => {
  assert.equal(normalizeSpeechText('第 IV 章，MCMXCIV 年。'), '第 四 章，一千九百九十四 年。');
  assert.equal(normalizeSpeechText('API 与 HTTP、TTS 都要念清楚。'), '接口 与 超文本传输协议、TTS 都要念清楚。');
  assert.equal(normalizeSpeechText('时间 09:30:15。'), '时间 九点三十分十五秒。');
  assert.equal(
    normalizeSpeechText('圆周率 3.14159，负 -273.15，千分位 1,234,567，50%，3/4。'),
    '圆周率 三点一四一五九，负 负二百七十三点一五，千分位 1，234，567，百分之五十，四分之三。',
  );
  assert.equal(normalizeSpeechText('.5 与 5. 与 1.2.3 与 1,5'), '零点五 与 5.与 1.2.3 与 1，5');
  assert.equal(normalizeSpeechText(''), '');
  assert.equal(normalizeSpeechText(undefined), '');
  assert.equal(normalizeSpeechText(null), '');
});

test('markdownToSpeechText 剥离标记、保留可朗读文本', () => {
  assert.equal(
    markdownToSpeechText('# 标题\n\n正文一段。\n\n- 列表项\n\n```js\nconst a = 1;\n```\n\n结尾句。'),
    '标题；正文一段。列表项；结尾句。',
  );
  assert.equal(
    markdownToSpeechText('[链接](https://example.com) 和 `code` 和 **粗体**。'),
    '链接 和 和 粗体。',
  );
  assert.equal(markdownToSpeechText(''), '');
});

test('splitSpeechSentences 按终止符切句并把超长句切到 40 字', () => {
  assert.deepEqual(splitSpeechSentences('第一句。第二句！第三句？第四句；第五句…'), [
    '第一句。',
    '第二句!',
    '第三句?',
    '第四句；',
    '第五句……',
  ]);
  assert.deepEqual(
    splitSpeechSentences('这是一个很长很长的句子需要被切开处理否则无法一次念完而且还要继续延伸下去直到超过限制为止。'),
    ['这是一个很长很长的句子需要被切开处理否则无法一次念完而且还要继续延伸下去直到超过', '限制为止。'],
  );
  assert.deepEqual(splitSpeechSentences('这是一个非常长的句子，需要被切开，否则一次念不完。'), [
    '这是一个非常长的句子，需要被切开，否则一次念不完。',
  ]);
  assert.deepEqual(splitSpeechSentences('   '), []);
});

test('readReferencePrompt 读不到时回退并记警告', () => {
  const { diagnostics, records } = createTestDiagnostics();
  const fallback = readReferencePrompt(join(tmpdir(), 'fairy-不存在', 'fairy_ref.txt'), diagnostics);
  assert.match(fallback, /我无权回复该问题/);
  assert.ok(records.some((record) => record.level === 'warn' && record.operation === 'reference.prompt.load'));
});

test('fairyVoicePaths 全部落在 Fairy 自己的数据目录下', () => {
  const paths = fairyVoicePaths('D:/fairy');
  assert.equal(paths.referenceAudioPath.replace(/\\/g, '/'), 'D:/fairy/fairy-voice/runtime/reference/fairy_ref.wav');
  assert.equal(paths.referencePromptPath.replace(/\\/g, '/'), 'D:/fairy/fairy-voice/runtime/reference/fairy_ref.txt');
  assert.equal(paths.outputDir.replace(/\\/g, '/'), 'D:/fairy/fairy-voice/out');
});

// ---------- TTS 传输 ----------

test('TTS status：可用返回 available，不可用退化为上游文案', async () => {
  const { diagnostics, records } = createTestDiagnostics();

  const ok = createTtsClient({
    referenceAudioPath: 'ref.wav',
    diagnostics,
    fetchImpl: fetchReturning(() => new Response('', { status: 200 })),
  });
  assert.deepEqual(await ok.status(), { available: true, reason: null });

  const bad = createTtsClient({
    referenceAudioPath: 'ref.wav',
    diagnostics,
    fetchImpl: fetchReturning(() => {
      throw new Error('connection refused');
    }),
  });
  const status = await bad.status();
  assert.equal(status.available, false);
  assert.equal(status.reason, '本地 Fairy 服务未启动。');
  assert.equal(formatFairyVoiceStatus(status), 'Fairy 本地语音服务不可用：本地 Fairy 服务未启动。');
  assert.ok(records.some((record) => record.operation === 'status.request'));
});

test('TTS synthesize：整段攒成 Uint8Array 并保留分片元信息', async () => {
  const { diagnostics } = createTestDiagnostics();
  let seenBody = '';
  const client = createTtsClient({
    referenceAudioPath: 'D:/fairy/ref.wav',
    referencePrompt: '参考提示',
    diagnostics,
    fetchImpl: fetchReturning((_url, init) => {
      seenBody = String(init.body);
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'audio/raw' },
      });
    }),
  });

  const result = await client.synthesize('你好。');
  assert.deepEqual([...result.audio], [1, 2, 3, 4]);
  assert.equal(result.byteLength, 4);
  assert.equal(result.contentType, 'audio/raw');
  assert.equal(result.format.sampleRate, 32_000);
  assert.equal(result.format.bytesPerSample, 2);
  assert.equal(result.format.streamingMode, 1);

  const body = JSON.parse(seenBody) as Record<string, unknown>;
  assert.equal(body.text, '你好。');
  assert.equal(body.ref_audio_path, 'D:/fairy/ref.wav');
  assert.equal(body.prompt_text, '参考提示');
  assert.equal(body.text_split_method, 'cut5');
  assert.equal(body.media_type, 'raw');
  assert.equal(body.fragment_interval, 0.14);
});

test('TTS synthesize 的错误码：非 2xx、超时、被取消', async () => {
  const { diagnostics } = createTestDiagnostics();

  const notOk = createTtsClient({
    referenceAudioPath: 'ref.wav',
    diagnostics,
    fetchImpl: fetchReturning(() => new Response('nope', { status: 500 })),
  });
  await assert.rejects(notOk.synthesize('x'), (error: { code?: string }) => error.code === 'local-service-failed');

  const timingOut = createTtsClient({
    referenceAudioPath: 'ref.wav',
    diagnostics,
    ttsTimeoutMs: 5,
    fetchImpl: fetchReturning((_url, init) => HANGING(init)),
  });
  await assert.rejects(timingOut.synthesize('x'), (error: { code?: string }) => error.code === 'timeout');

  const controller = new AbortController();
  const cancellable = createTtsClient({
    referenceAudioPath: 'ref.wav',
    diagnostics,
    fetchImpl: fetchReturning((_url, init) => HANGING(init)),
  });
  const pending = cancellable.synthesize('x', controller.signal);
  controller.abort('superseded');
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'superseded');
});

test('buildWavFile 补出可播放的 44 字节 RIFF 头', () => {
  const audio = new Uint8Array([9, 8, 7]);
  const wav = buildWavFile(audio, {
    mediaType: 'raw',
    streamingMode: 1,
    fragmentInterval: 0.14,
    textSplitMethod: 'cut5',
    batchSize: 1,
    sampleRate: 32_000,
    bytesPerSample: 2,
  });
  assert.equal(wav.byteLength, 47);
  const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(text(8, 12), 'WAVE');
  assert.equal(text(12, 16), 'fmt ');
  assert.equal(text(36, 40), 'data');
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(4, true), 39);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 32_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 3);
  assert.deepEqual([...wav.slice(44)], [9, 8, 7]);
});

// ---------- 语音简报 ----------

test('configuredApiKey 校验长度与非法字符', () => {
  assert.equal(configuredApiKey('  sk-1234567890abcdef  '), 'sk-1234567890abcdef');
  assert.equal(configuredApiKey('short'), '');
  assert.equal(configuredApiKey('sk-1234567890abc\ndef'), '');
  assert.equal(configuredApiKey(undefined), '');
  assert.equal(configuredApiKey('x'.repeat(513)), '');
});

test('语音简报：无密钥报 unconfigured，超长输入报 input-too-large', async () => {
  const { diagnostics } = createTestDiagnostics();

  const unconfigured = createVoiceBrief({
    resolveApiKey: () => undefined,
    markdownToSpeechText,
    diagnostics,
  });
  await assert.rejects(
    unconfigured.brief('正文。'),
    (error: { code?: string }) => error.code === 'voice-brief-unconfigured',
  );

  const tooLarge = createVoiceBrief({
    resolveApiKey: () => 'sk-1234567890abcdef',
    markdownToSpeechText,
    maxInputLength: 3,
    diagnostics,
  });
  await assert.rejects(
    tooLarge.brief('一二三四五。'),
    (error: { code?: string }) => error.code === 'voice-brief-input-too-large',
  );
});

test('语音简报：请求体与上游一致、结果按上限截断、密钥不入日志', async () => {
  const { diagnostics, text } = createTestDiagnostics();
  const secret = 'sk-brief-secret-0001';
  let seenBody: Record<string, unknown> = {};
  let seenAuth = '';

  const brief = createVoiceBrief({
    resolveApiKey: () => secret,
    markdownToSpeechText,
    diagnostics,
    maxOutputLength: 5,
    fetchImpl: fetchReturning((_url, init) => {
      seenAuth = String((init.headers as Record<string, string>).Authorization);
      seenBody = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '**简报** 内容很长很长。' } }] }),
        { status: 200 },
      );
    }),
  });

  const result = await brief.brief('原始回答。');
  assert.equal(seenAuth, `Bearer ${secret}`);
  assert.equal(seenBody.model, 'deepseek-v4-flash');
  assert.equal(seenBody.max_tokens, 400);
  assert.equal(seenBody.temperature, 0.2);
  assert.deepEqual(seenBody.thinking, { type: 'disabled' });
  const messages = seenBody.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, '严格按用户要求输出可直接朗读的中文简报。');
  assert.equal(messages[1]?.role, 'user');
  assert.match(messages[1]?.content ?? '', /只保留一到三个最重要的信息/);
  assert.match(messages[1]?.content ?? '', /最终回答：\n原始回答。/);

  assert.equal(result, '简报 内容');
  assert.equal(text().includes(secret), false);
});

test('语音简报：上游错误与取消语义', async () => {
  const { diagnostics } = createTestDiagnostics();

  const failing = createVoiceBrief({
    resolveApiKey: () => 'sk-1234567890abcdef',
    markdownToSpeechText,
    diagnostics,
    fetchImpl: fetchReturning(() => new Response('{}', { status: 500 })),
  });
  await assert.rejects(
    failing.brief('正文。'),
    (error: { code?: string }) => error.code === 'voice-brief-request-failed',
  );

  const empty = createVoiceBrief({
    resolveApiKey: () => 'sk-1234567890abcdef',
    markdownToSpeechText,
    diagnostics,
    fetchImpl: fetchReturning(() => new Response(JSON.stringify({ choices: [] }), { status: 200 })),
  });
  await assert.rejects(empty.brief('正文。'), (error: { code?: string }) => error.code === 'voice-brief-empty');

  const controller = new AbortController();
  const cancellable = createVoiceBrief({
    resolveApiKey: () => 'sk-1234567890abcdef',
    markdownToSpeechText,
    diagnostics,
    fetchImpl: fetchReturning((_url, init) => HANGING(init)),
  });
  const pending = cancellable.brief('正文。', controller.signal);
  controller.abort('client-aborted');
  await assert.rejects(pending, (error: { code?: string }) => error.code === 'client-aborted');
});

// ---------- Windows 离线语音回退 ----------

function withTempDir(run: (directory: string) => void | Promise<void>) {
  return async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

interface FakeChild {
  process: FairySpeechProcess;
  killCount: number;
  command: string;
  args: string[];
}

function createFakeChild(options: { exitCode?: number; neverExits?: boolean } = {}): FakeChild {
  const exitListeners: Array<(code: number | null) => void> = [];
  const errorListeners: Array<(error: Error) => void> = [];
  let fired = false;
  const handle: FakeChild = {
    killCount: 0,
    command: '',
    args: [],
    process: {
      on(event: 'exit' | 'error', listener: ((code: number | null) => void) | ((error: Error) => void)) {
        if (event === 'exit') {
          exitListeners.push(listener as (code: number | null) => void);
          // 退出必须发生在监听器挂上之后（真实 spawn 就是这个时序），
          // 否则监听器永远收不到事件，只会等到超时。
          if (!options.neverExits && !fired) {
            fired = true;
            queueMicrotask(() => {
              for (const registered of exitListeners) registered(options.exitCode ?? 0);
            });
          }
        } else {
          errorListeners.push(listener as (error: Error) => void);
        }
        return handle.process;
      },
      kill() {
        handle.killCount += 1;
      },
    },
  };
  void errorListeners;
  return handle;
}

test('buildSpeechScript 用单引号字符串并把文本转义', () => {
  const script = buildSpeechScript("C:/a'b/say.txt", 3);
  assert.match(script, /Add-Type -AssemblyName System\.Speech/);
  assert.match(script, /\$s\.Rate = 3/);
  assert.match(script, /'C:\/a''b\/say\.txt'/);
  assert.equal(buildSpeechScript('x.txt', 99).includes('$s.Rate = 10'), true, '语速应夹到 10');
  assert.equal(buildSpeechScript('x.txt', -99).includes('$s.Rate = -10'), true, '语速应夹到 -10');
});

test('Windows 语音回退：成功、非零退出、超时、非 Windows', withTempDir(async (directory) => {
  const { diagnostics, records } = createTestDiagnostics();
  const paths = fairyVoicePaths(directory);

  const okChild = createFakeChild({ exitCode: 0 });
  const ok = createWindowsSpeech({
    dataDir: directory,
    diagnostics,
    platform: 'win32',
    spawnImpl: (command, args) => {
      okChild.command = command;
      okChild.args = args;
      return okChild.process;
    },
  });
  assert.equal(ok.available(), true);
  assert.deepEqual(await ok.speak('你好，主人。'), { spoken: true });
  assert.equal(okChild.command, 'powershell.exe');
  assert.equal(okChild.args[0], '-NoProfile');
  assert.match(okChild.args[3] ?? '', /System\.Speech/);
  // 朗读文本落临时文件后按 UTF-8 读取，读不出才是失败
  assert.equal(existsSync(join(directory, 'fairy-voice', 'spoken')), true);
  assert.equal(readdirSync(join(directory, 'fairy-voice', 'spoken')).length, 0, '临时文本文件应被清理');
  assert.ok(records.some((record) => record.event === 'metric' && record.operation === 'speech.spoken'));
  void paths;

  const failed = createWindowsSpeech({
    dataDir: directory,
    diagnostics,
    platform: 'win32',
    spawnImpl: () => createFakeChild({ exitCode: 1 }).process,
  });
  assert.deepEqual(await failed.speak('文本'), { spoken: false, reason: 'exit-1' });

  const timingOut = createWindowsSpeech({
    dataDir: directory,
    diagnostics,
    platform: 'win32',
    timeoutMs: 10,
    spawnImpl: () => createFakeChild({ neverExits: true }).process,
  });
  const timeoutChild = createFakeChild({ neverExits: true });
  const timingOutChild = createWindowsSpeech({
    dataDir: directory,
    diagnostics,
    platform: 'win32',
    timeoutMs: 10,
    spawnImpl: () => timeoutChild.process,
  });
  assert.deepEqual(await timingOutChild.speak('文本'), { spoken: false, reason: 'timeout' });
  assert.equal(timeoutChild.killCount, 1, '超时应 kill 子进程');
  void timingOut;
  void failed;

  const unsupported = createWindowsSpeech({ dataDir: directory, diagnostics, platform: 'linux' });
  assert.equal(unsupported.available(), false);
  assert.deepEqual(await unsupported.speak('文本'), { spoken: false, reason: 'platform-unsupported' });
  assert.deepEqual(await ok.speak('   '), { spoken: false, reason: 'empty-text' });
}));

test('Windows 语音回退：cancel 会立刻打断当前朗读', withTempDir(async (directory) => {
  const { diagnostics } = createTestDiagnostics();
  const child = createFakeChild({ neverExits: true });
  const speech = createWindowsSpeech({
    dataDir: directory,
    diagnostics,
    platform: 'win32',
    timeoutMs: 30_000,
    spawnImpl: () => child.process,
  });

  const pending = speech.speak('很长的文本');
  speech.cancel();
  assert.equal(child.killCount, 1);
  assert.deepEqual(await pending, { spoken: false, reason: 'canceled' }, '不应等到超时才结案');
}));

// ---------- 端到端：applyFairyVoice ----------

interface FakePi {
  api: ExtensionAPI;
  commands: Map<string, { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  dispatch: (event: string, payload: Record<string, unknown>, ctx: ExtensionContext) => Promise<void>;
}

function createFakePi(): FakePi {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<
    string,
    { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> }
  >();
  const api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      return () => {};
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: ExtensionContext) => Promise<void> },
    ) {
      commands.set(name, options);
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    async dispatch(event, payload, ctx) {
      for (const handler of [...(handlers.get(event) ?? [])]) await handler({ type: event, ...payload }, ctx);
    },
  };
}

function createFakeContext() {
  const notifications: Array<[string, string]> = [];
  const context = {
    mode: 'tui',
    hasUI: true,
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => 'voice-1' },
    modelRegistry: { getApiKeyForProvider: async () => 'sk-1234567890abcdef' },
    ui: {
      setStatus: () => {},
      notify: (message: string, type: string) => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  return { context, notifications };
}

test('applyFairyVoice：命令注册、status 文案、say 落 WAV 文件', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, commands, dispatch } = createFakePi();
    const { context, notifications } = createFakeContext();

    // 先让参考提示词真实存在，验证「读得到就用文件内容」这条分支。
    const paths = fairyVoicePaths(directory);

    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      fetchImpl: fetchReturning((url, init) => {
        if (url.includes('/docs')) return new Response('', { status: 200 });
        if (init.method === 'POST') {
          return new Response(new Uint8Array([5, 6, 7, 8]), {
            status: 200,
            headers: { 'content-type': 'audio/raw' },
          });
        }
        return new Response('', { status: 404 });
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    assert.ok(commands.has(FAIRY_VOICE_COMMAND));

    await runtime.handlers.status(context);
    assert.equal(notifications.at(-1)?.[0], 'Fairy 本地语音服务可用。');
    assert.equal(notifications.at(-1)?.[1], 'info');

    await runtime.handlers.say('好的，主人。', context);
    const wrote = notifications.at(-1)?.[0] ?? '';
    assert.match(wrote, /Fairy 语音已合成：4 字节（32000Hz）/);
    assert.equal(notifications.at(-1)?.[1], 'info');

    const file = wrote.split('\n')[1] ?? '';
    assert.ok(file.startsWith(paths.outputDir.replace(/\//g, '\\')) || file.includes('fairy-voice'), file);
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file).byteLength, 48);
    assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'RIFF');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applyFairyVoice：空文本提示用法，本地服务不可用时如实告警', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context, notifications } = createFakeContext();

    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      fetchImpl: fetchReturning(() => {
        throw new Error('connection refused');
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    await runtime.handlers.status(context);
    assert.equal(notifications.at(-1)?.[1], 'warning');
    assert.match(notifications.at(-1)?.[0] ?? '', /本地语音服务不可用：本地 Fairy 服务未启动。/);

    await runtime.handlers.say('   ', context);
    assert.equal(notifications.at(-1)?.[1], 'warning');
    assert.match(notifications.at(-1)?.[0] ?? '', /\/fairy-voice status/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applyFairyVoice：新的 say 取消上一段，被取消方不报错', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context, notifications } = createFakeContext();

    let call = 0;
    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      fetchImpl: fetchReturning((_url, init) => {
        call += 1;
        if (call === 1) return HANGING(init);
        return new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/raw' } });
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    const first = runtime.handlers.say('第一段。', context);
    const second = runtime.handlers.say('第二段。', context);
    await Promise.all([first, second]);

    assert.equal(notifications.length, 1, '被取代的那次不应产生通知');
    assert.equal(notifications[0]?.[1], 'info');
    assert.match(notifications[0]?.[0] ?? '', /2 字节/);
    assert.equal(existsSync(fairyVoicePaths(directory).outputDir), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applyFairyVoice：本地 TTS 不可用时回退到 Windows 语音朗读', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics, records } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context, notifications } = createFakeContext();
    const child = createFakeChild({ exitCode: 0 });

    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      platform: 'win32',
      speechSpawnImpl: (command, args) => {
        child.command = command;
        child.args = args;
        return child.process;
      },
      fetchImpl: fetchReturning(() => {
        throw new Error('connection refused');
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    await runtime.handlers.say('主人，测试回退。', context);

    assert.equal(notifications.length, 1);
    assert.equal(notifications[0]?.[1], 'warning');
    assert.match(notifications[0]?.[0] ?? '', /本地 TTS 不可用（local-service-unavailable）/);
    assert.match(notifications[0]?.[0] ?? '', /已改用 Windows 内置语音朗读/);
    assert.match(notifications[0]?.[0] ?? '', /不是 Fairy 的音色/);
    assert.equal(child.command, 'powershell.exe');
    assert.equal(child.args[0], '-NoProfile');
    assert.match(child.args[3] ?? '', /System\.Speech/);
    assert.ok(records.some((record) => record.operation === 'speech.spoken'));
    assert.equal(records.some((record) => record.operation === 'speech.write'), false);

    dispatch('session_shutdown', { reason: 'quit' }, context);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applyFairyVoice：关闭回退时仍然如实报错', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context, notifications } = createFakeContext();
    let spawned = false;

    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      platform: 'win32',
      speechFallback: false,
      speechSpawnImpl: () => {
        spawned = true;
        return createFakeChild().process;
      },
      fetchImpl: fetchReturning(() => {
        throw new Error('connection refused');
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    await runtime.handlers.say('测试。', context);

    assert.equal(spawned, false, '关闭回退时不应起朗读进程');
    assert.equal(notifications.at(-1)?.[1], 'error');
    assert.equal(
      notifications.at(-1)?.[0],
      'Fairy 语音合成失败：local-service-unavailable',
    );

    dispatch('session_shutdown', { reason: 'quit' }, context);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('applyFairyVoice：参考提示词从数据目录读取并进入请求体', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-voice-'));
  try {
    const { diagnostics } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context } = createFakeContext();
    const paths = fairyVoicePaths(directory);
    mkdirSync(join(paths.referencePromptPath, '..'), { recursive: true });
    writeFileSync(paths.referencePromptPath, '  自定义参考提示  ', 'utf8');

    let promptText: string | undefined;
    const runtime = applyFairyVoice(api, {
      dataDir: directory,
      diagnostics,
      fetchImpl: fetchReturning((_url, init) => {
        promptText = (JSON.parse(String(init.body)) as { prompt_text?: string }).prompt_text;
        return new Response(new Uint8Array([1]), {
          status: 200,
          headers: { 'content-type': 'audio/raw' },
        });
      }),
    });

    await dispatch('session_start', { reason: 'startup' }, context);
    await runtime.handlers.say('一句话。', context);

    assert.equal(promptText, '自定义参考提示');
    assert.equal(readReferencePrompt(paths.referencePromptPath, diagnostics), '自定义参考提示');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
