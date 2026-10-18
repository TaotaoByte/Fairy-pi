/**
 * persona 移植单测。
 *
 * 直接使用随包分发的**真实语料**（`assets/persona/`）做断言：语料是否真的随包、
 * 摘要是否真的有上界、注入是否只写自己的段落而不整体替换 systemPrompt。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { FAIRY_LOG_PREFIX, createFairyDiagnostics } from '../src/contracts/index.ts';
import type { FairyLogRecord } from '../src/contracts/index.ts';
import {
  FAIRY_CORPUS_FILES,
  FAIRY_PERSONA_COMMAND,
  FAIRY_PERSONA_PROMPT,
  FAIRY_PERSONA_SECTION_TAG,
  collectLeafFacts,
  fairyCorpusExists,
  loadFairyCorpus,
  renderFairyCorpusDigest,
  summarizeFairyCorpus,
  applyFairyPersona,
} from '../src/features/persona/index.ts';

const ASSETS_DIR = fileURLToPath(new URL('../assets/persona/', import.meta.url));

function createTestDiagnostics(moduleName = 'fairy-pi-test') {
  const records: FairyLogRecord[] = [];
  const collect =
    () =>
    (...args: unknown[]): void => {
      const line = String(args[0]);
      if (!line.startsWith(`${FAIRY_LOG_PREFIX} `)) return;
      records.push(JSON.parse(line.slice(FAIRY_LOG_PREFIX.length + 1)) as FairyLogRecord);
    };
  const sink = { info: collect(), log: collect(), warn: collect(), error: collect() };
  return { diagnostics: createFairyDiagnostics(moduleName, { sink }), records };
}

test('语料随包分发：9 个文件全部可载入且带 schema 版本', () => {
  const { diagnostics } = createTestDiagnostics();
  assert.equal(fairyCorpusExists(ASSETS_DIR), true);
  assert.equal(fairyCorpusExists(join(tmpdir(), 'fairy-不存在')), false);

  const corpus = loadFairyCorpus(ASSETS_DIR, { diagnostics });
  assert.equal(corpus.entries.length, FAIRY_CORPUS_FILES.length);
  assert.equal(corpus.entries.length, 9);
  for (const entry of corpus.entries) {
    assert.equal(entry.loaded, true, `${entry.id} 应载入成功`);
    assert.ok(entry.byteLength > 0, `${entry.id} 应有内容`);
    assert.equal(entry.schemaVersion, '1.0', `${entry.id} 的 schema 版本`);
  }

  const summary = summarizeFairyCorpus(corpus);
  const behavior = summary.find((entry) => entry.id === 'behavior-rules');
  assert.ok((behavior?.itemCount ?? 0) > 0, '行为规则条数应大于 0');
  const speech = summary.find((entry) => entry.id === 'speech-style');
  assert.equal(speech?.sampleCount, 1299);
  assert.ok(summary.reduce((sum, entry) => sum + entry.byteLength, 0) > 400_000);
});

test('单个语料文件读取失败只影响该文件', () => {
  const { diagnostics, records } = createTestDiagnostics();
  const corpus = loadFairyCorpus(ASSETS_DIR, {
    diagnostics,
    readFile: (path) => {
      if (path.endsWith('fairy_canon.json')) throw new Error('EACCES');
      return '{"schema_version":"1.0"}';
    },
  });
  const canon = corpus.entries.find((entry) => entry.id === 'canon');
  assert.equal(canon?.loaded, false);
  assert.equal(canon?.error, 'EACCES');
  assert.equal(corpus.entries.filter((entry) => entry.loaded).length, 8);
  assert.ok(records.some((record) => record.level === 'warn' && record.operation === 'corpus.load'));
  assert.ok(records.some((record) => record.operation === 'corpus.incomplete'));
});

test('语料摘要含四类内容且遵守条数与字符上限', () => {
  const { diagnostics } = createTestDiagnostics();
  const corpus = loadFairyCorpus(ASSETS_DIR, { diagnostics });

  const digest = renderFairyCorpusDigest(corpus);
  assert.match(digest, /Fairy 语料摘要/);
  // 语料共 5 条行为规则；默认 maxRules 为 12，因此 5 条全被摘录。
  assert.match(digest, /【行为规则｜共 5 条，摘录 5 条】/);
  assert.match(digest, /【语域与句式统计】/);
  assert.match(digest, /- 文体指引：/);
  assert.match(digest, /- 句长参考：均值/);
  assert.match(digest, /【已知漂移风险】/);
  assert.match(digest, /mechanical_owner/);
  assert.ok(digest.includes('- Do not invent a fixed catchphrase.'), '应含 style 的 rules');

  const trimmed = renderFairyCorpusDigest(corpus, { maxChars: 400, maxRules: 1 });
  assert.ok(trimmed.length < 400 + 120, `截断后长度应接近上限，实际 ${trimmed.length}`);
  assert.match(trimmed, /已按 400 字符上限截断/);
  assert.match(trimmed, /【行为规则｜共 5 条，摘录 1 条】/);
});

test('通用叶子收集不会带出深层对话样例', () => {
  const { diagnostics } = createTestDiagnostics();
  const corpus = loadFairyCorpus(ASSETS_DIR, { diagnostics });
  const behavior = corpus.entries.find((entry) => entry.id === 'behavior-rules');
  const facts = collectLeafFacts(behavior?.value, { maxItems: 60, maxDepth: 1 });
  assert.ok(facts.length > 0);
  for (const fact of facts) {
    assert.equal(fact.includes('scene_id'), false);
    assert.equal(fact.includes('turn_id'), false);
    assert.equal(fact.includes('speaker_id'), false);
    assert.ok(fact.length <= 230, `单条事实应有长度上限：${fact.length}`);
  }
  assert.ok(facts.some((fact) => fact.startsWith('rules：')), '应给出数组摘要而不是展开样例');
});

// ---------- 端到端：applyFairyPersona ----------

function createFakePi() {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: ExtensionContext) => unknown>>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const api = {
    on(event: string, handler: (event: Record<string, unknown>, ctx: ExtensionContext) => unknown) {
      const group = handlers.get(event);
      if (group) group.push(handler);
      else handlers.set(event, [handler]);
      return () => {};
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, options.handler);
    },
  };
  return {
    api: api as unknown as ExtensionAPI,
    commands,
    dispatch(event: string, payload: Record<string, unknown>, ctx: ExtensionContext) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ type: event, ...payload }, ctx);
    },
  };
}

function createFakeContext() {
  const notifications: Array<[string, string]> = [];
  const context = {
    mode: 'tui',
    hasUI: true,
    cwd: 'C:/fairy',
    sessionManager: { getSessionId: () => 'persona-1' },
    ui: {
      setStatus: () => {},
      notify: (message: string, type: string) => {
        notifications.push([message, type]);
      },
    },
  } as unknown as ExtensionContext;
  return { context, notifications };
}

function startEvent() {
  return {
    prompt: '你好',
    systemPrompt: 'BASE PROMPT',
    systemPromptOptions: { sections: {} as Record<string, string> },
  };
}

test('默认关闭：before_agent_start 不写入任何段落', () => {
  const { diagnostics } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();
  const { context } = createFakeContext();
  applyFairyPersona(api, { assetsDir: ASSETS_DIR, diagnostics });

  const event = startEvent();
  dispatch('before_agent_start', event, context);

  assert.deepEqual(event.systemPromptOptions.sections, {});
  assert.equal(event.systemPrompt, 'BASE PROMPT');
});

test('启用后只写入 fairy-persona 段落，不整体替换 systemPrompt', () => {
  const { diagnostics, records } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();
  const { context } = createFakeContext();
  const runtime = applyFairyPersona(api, { assetsDir: ASSETS_DIR, diagnostics, enabled: true });

  const event = startEvent();
  const returned = dispatch('before_agent_start', event, context);

  assert.equal(returned, undefined, '不应返回 systemPrompt 覆盖');
  assert.equal(event.systemPrompt, 'BASE PROMPT');
  const section = event.systemPromptOptions.sections[FAIRY_PERSONA_SECTION_TAG];
  assert.ok(section, '应写入 fairy-persona 段落');
  assert.ok(section.startsWith(FAIRY_PERSONA_PROMPT), '段落应以逐字人设正文开头');
  assert.match(section, /Fairy 语料摘要/);
  assert.match(section, /【行为规则/);
  assert.equal(runtime.isEnabled(), true);
  assert.ok(records.some((record) => record.operation === 'inject'));
});

test('段落总长受上限约束', () => {
  const { diagnostics } = createTestDiagnostics();
  const { api, dispatch } = createFakePi();
  const { context } = createFakeContext();
  applyFairyPersona(api, {
    assetsDir: ASSETS_DIR,
    diagnostics,
    enabled: true,
    maxSectionChars: FAIRY_PERSONA_PROMPT.length + 200,
  });

  const event = startEvent();
  dispatch('before_agent_start', event, context);
  const section = event.systemPromptOptions.sections[FAIRY_PERSONA_SECTION_TAG] ?? '';
  assert.ok(section.length <= FAIRY_PERSONA_PROMPT.length + 200 + 120, `实际长度 ${section.length}`);
  assert.match(section, /语料摘要已按 \d+ 字符上限截断/);
});

test('语料不可用时跳过注入并记警告', () => {
  const directory = mkdtempSync(join(tmpdir(), 'fairy-persona-'));
  try {
    const { diagnostics, records } = createTestDiagnostics();
    const { api, dispatch } = createFakePi();
    const { context } = createFakeContext();
    applyFairyPersona(api, { assetsDir: directory, diagnostics, enabled: true });

    const event = startEvent();
    dispatch('before_agent_start', event, context);

    assert.deepEqual(event.systemPromptOptions.sections, {});
    const warn = records.find((record) => record.operation === 'inject.skipped');
    assert.ok(warn);
    assert.equal((warn?.context as { reason?: string }).reason, 'corpus-unavailable');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('命令：status / on / off / digest / corpus / reload / 未知子命令', async () => {
  const { diagnostics } = createTestDiagnostics();
  const { api, commands } = createFakePi();
  const { context, notifications } = createFakeContext();
  const runtime = applyFairyPersona(api, { assetsDir: ASSETS_DIR, diagnostics });

  const handler = commands.get(FAIRY_PERSONA_COMMAND);
  assert.ok(handler, '应注册 /fairy-persona');

  await handler!('', context);
  assert.match(notifications.at(-1)?.[0] ?? '', /Fairy 人格：已关闭（会话级，不持久化）/);
  assert.match(notifications.at(-1)?.[0] ?? '', /语料：9\/9 已载入/);

  await handler!('on', context);
  assert.match(notifications.at(-1)?.[0] ?? '', /Fairy 人格已启用。/);
  assert.equal(runtime.isEnabled(), true);

  await handler!('off', context);
  assert.equal(notifications.at(-1)?.[0], 'Fairy 人格已关闭。');
  assert.equal(runtime.isEnabled(), false);

  await handler!('corpus', context);
  const corpusText = notifications.at(-1)?.[0] ?? '';
  assert.match(corpusText, /- behavior-rules（341\d+ 字节，schema 1\.0）/);
  assert.ok(corpusText.includes(join(ASSETS_DIR, 'canon', 'fairy_canon.json')));

  await handler!('digest', context);
  const digestText = notifications.at(-1)?.[0] ?? '';
  assert.match(digestText, /你是《绝区零》中的 Fairy/);

  await handler!('reload', context);
  assert.match(notifications.at(-1)?.[0] ?? '', /语料已重新载入。/);

  await handler!('乱写', context);
  assert.equal(notifications.at(-1)?.[1], 'warning');
  assert.match(notifications.at(-1)?.[0] ?? '', /\/fairy-persona status/);
});

test('runtime 的 setEnabled 与 reload 可被程序化使用', () => {
  const { diagnostics } = createTestDiagnostics();
  const { api } = createFakePi();
  const runtime = applyFairyPersona(api, { assetsDir: ASSETS_DIR, diagnostics });

  const before = runtime.digest();
  runtime.setEnabled(true);
  assert.equal(runtime.isEnabled(), true);
  assert.equal(runtime.reload(), undefined);
  assert.equal(runtime.digest(), before, '语料未变，摘要应稳定');
  assert.equal(runtime.corpus().entries.length, 9);
});
