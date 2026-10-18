/**
 * 功能层：Fairy 人格语料（上游 `.agent-presets/fairy/` 的语料目录）。
 *
 * 上游把语料交给 `@deepseek-ai/dsh-persona` + `.agent-presets/fairy/runtime/fairy_core.py`
 * 做检索与选样（`fidelity: strict`、`exampleLimit: 2`）。**公开仓库里没有 `runtime/` 目录**
 * （`fairy_core.py`、`safety-gate.js`、`index.js` 均不存在，已逐文件核对过），所以那套
 * 语料驱动的检索内核无法移植。本模块做的是**可验证的降级版**：
 *   - 语料原样随包分发（`assets/persona/`，Apache-2.0，见同目录 NOTICE）；
 *   - 提供「载入 → 概括 → 摘要渲染」三段，摘要用于注入提示词或给人看；
 *   - 语料全文交给模型按需阅读（`/fairy-persona corpus` 会列出路径，skill 里有指引）。
 *
 * 摘要渲染是**机械的**：不猜测语义，只按各文件已声明的 `schema_version: "1.0"` 结构取值
 * （behavior 的 `rules[]`、style 的 `rules[]`/`online_guidance`、anti-fanon 的 `risks[]`），
 * 其余文件走通用「字符串叶子」收集并受深度与条数上限约束，避免把对话样例灌进上下文。
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { createFairyDiagnostics } from '../../contracts/index.ts';
import type { FairyDiagnostics } from '../../contracts/index.ts';

export interface FairyCorpusFileSpec {
  id: string;
  /** 相对 `assets/persona` 的路径。 */
  path: string;
  /** 该文件主要提供什么，供 `/fairy-persona corpus` 展示。 */
  purpose: string;
}

/** 9 个语料文件，路径与上游 `.agent-presets/fairy/` 保持一致。 */
export const FAIRY_CORPUS_FILES: readonly FairyCorpusFileSpec[] = [
  { id: 'behavior-rules', path: 'behavior/fairy_behavior_rules.json', purpose: '情境→行为倾向与回应策略' },
  { id: 'canon', path: 'canon/fairy_canon.json', purpose: '已确认设定' },
  { id: 'anti-fanon', path: 'canon/fairy_anti_fanon.json', purpose: '漂移风险与禁止臆造项' },
  { id: 'personality', path: 'personality/fairy_personality.json', purpose: '性格维度与表现' },
  { id: 'relationships', path: 'personality/fairy_relationships.json', purpose: '人物关系' },
  { id: 'world-view', path: 'personality/fairy_world_view.json', purpose: '世界观与术语' },
  { id: 'real-ai-antipatterns', path: 'style/fairy_real_ai_antipatterns.json', purpose: '现实 AI 套话反例' },
  { id: 'speech-style', path: 'style/fairy_speech_style.json', purpose: '语域、句长与标点统计' },
  { id: 'voice-model', path: 'style/fairy_voice_model.json', purpose: '语料驱动的声音模型' },
];

export interface FairyCorpusEntry {
  id: string;
  path: string;
  purpose: string;
  loaded: boolean;
  byteLength: number;
  schemaVersion: string | null;
  value: unknown;
  error?: string;
}

export interface FairyCorpus {
  assetsDir: string;
  entries: readonly FairyCorpusEntry[];
}

export interface LoadFairyCorpusOptions {
  diagnostics?: FairyDiagnostics;
  readFile?: (path: string) => string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** 载入全部语料。单文件失败只记录该文件的 error，不影响其余文件。 */
export function loadFairyCorpus(
  assetsDir: string,
  options: LoadFairyCorpusOptions = {},
): FairyCorpus {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-persona');
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, 'utf8'));

  const entries = FAIRY_CORPUS_FILES.map((spec): FairyCorpusEntry => {
    const absolute = join(assetsDir, spec.path);
    const base = {
      id: spec.id,
      path: spec.path,
      purpose: spec.purpose,
      loaded: false,
      byteLength: 0,
      schemaVersion: null,
      value: undefined as unknown,
    };
    try {
      const source = readFile(absolute);
      const value: unknown = JSON.parse(source);
      return {
        ...base,
        loaded: true,
        byteLength: Buffer.byteLength(source, 'utf8'),
        schemaVersion: readString(asRecord(value)?.schema_version),
        value,
      };
    } catch (error) {
      const message = (error as { message?: string })?.message ?? 'unknown';
      diagnostics.warn('corpus.load', { file: spec.path, reason: message });
      return { ...base, error: message };
    }
  });

  const loaded = entries.filter((entry) => entry.loaded).length;
  if (loaded !== entries.length) {
    diagnostics.warn('corpus.incomplete', { loaded, total: entries.length });
  }
  diagnostics.info('corpus.loaded', {
    assetsDir,
    loaded,
    total: entries.length,
    byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
  });

  return { assetsDir, entries };
}

/** 目录是否真的存在语料（用于区分「未随包分发」与「分发但读失败」）。 */
export function fairyCorpusExists(assetsDir: string): boolean {
  try {
    return statSync(join(assetsDir, FAIRY_CORPUS_FILES[0]!.path)).isFile();
  } catch {
    return false;
  }
}

export interface FairyCorpusSummary {
  id: string;
  loaded: boolean;
  byteLength: number;
  schemaVersion: string | null;
  /** `rules[]` / `risks[]` 的条数，取不到为 null。 */
  itemCount: number | null;
  sampleCount: number | null;
}

export function summarizeFairyCorpus(corpus: FairyCorpus): FairyCorpusSummary[] {
  return corpus.entries.map((entry) => {
    const record = asRecord(entry.value);
    const items = record?.rules ?? record?.risks;
    const sample = record?.sample_count;
    return {
      id: entry.id,
      loaded: entry.loaded,
      byteLength: entry.byteLength,
      schemaVersion: entry.schemaVersion,
      itemCount: Array.isArray(items) ? items.length : null,
      sampleCount: typeof sample === 'number' ? sample : null,
    };
  });
}

export interface LeafFactOptions {
  maxDepth?: number;
  maxItems?: number;
  maxCharsPerItem?: number;
}

/**
 * 通用「字符串叶子」收集：只在浅层取值，遇到数组转换为 `数组名[N]` 之类的摘要，
 * 绝不把深层对话样例（behavior 的 `surface_language.examples`）带出来。
 */
export function collectLeafFacts(value: unknown, options: LeafFactOptions = {}): string[] {
  const maxDepth = options.maxDepth ?? 2;
  const maxItems = options.maxItems ?? 40;
  const maxChars = options.maxCharsPerItem ?? 220;
  const facts: string[] = [];

  const push = (fact: string): void => {
    const trimmed = fact.replace(/\s+/g, ' ').trim();
    if (!trimmed || facts.length >= maxItems) return;
    facts.push(trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed);
  };

  const walk = (node: unknown, path: string, depth: number): void => {
    if (facts.length >= maxItems) return;
    if (typeof node === 'string') {
      push(`${path}：${node}`);
      return;
    }
    if (typeof node === 'number' || typeof node === 'boolean') {
      push(`${path}：${String(node)}`);
      return;
    }
    if (Array.isArray(node)) {
      const strings = readStringArray(node);
      if (strings.length > 0) {
        push(`${path}：${strings.join('、')}`);
        return;
      }
      if (depth >= maxDepth) {
        push(`${path}：${node.length} 项`);
        return;
      }
      for (let index = 0; index < Math.min(node.length, 3); index += 1) {
        walk(node[index], `${path}[${index}]`, depth + 1);
      }
      return;
    }
    const record = asRecord(node);
    if (!record) return;
    if (depth >= maxDepth) {
      push(`${path}：{${Object.keys(record).join('、')}}`);
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (key === 'schema_version' || key === 'source') continue;
      walk(child, path ? `${path}.${key}` : key, depth + 1);
    }
  };

  walk(value, '', 0);
  return facts;
}

export interface FairyCorpusDigestOptions {
  maxChars?: number;
  maxRules?: number;
  maxFactsPerFile?: number;
}

export const DEFAULT_DIGEST_MAX_CHARS = 4_000;
export const DEFAULT_DIGEST_MAX_RULES = 12;

function renderBehaviorRules(entry: FairyCorpusEntry, maxRules: number): string[] {
  const rules = asRecord(entry.value)?.rules;
  if (!Array.isArray(rules)) return [];
  const lines: string[] = [];
  for (const item of rules.slice(0, maxRules)) {
    const rule = asRecord(item);
    if (!rule) continue;
    const id = readString(rule.rule_id) ?? 'rule';
    const situation = readString(rule.situation) ?? '';
    const interpretation = readString(rule.interpretation) ?? '';
    const strategy = readString(rule.response_strategy) ?? '';
    const tendency = readString(rule.decision_tendency) ?? '';
    const tags = readStringArray(asRecord(rule.surface_language)?.tags).join('/');
    lines.push(
      `- ${id}｜情境：${situation}｜理解：${interpretation}｜倾向：${tendency}｜策略：${strategy}${tags ? `｜语域标签：${tags}` : ''}`,
    );
  }
  return lines;
}

function renderSpeechStyle(entry: FairyCorpusEntry): string[] {
  const record = asRecord(entry.value);
  if (!record) return [];
  const lines: string[] = [];
  const guidance = readString(record.online_guidance);
  if (guidance) lines.push(`- 文体指引：${guidance}`);

  const length = asRecord(record.sentence_length_chars);
  if (length) {
    lines.push(
      `- 句长参考：均值 ${String(length.mean ?? '?')} 字、中位 ${String(length.median ?? '?')} 字、p90 ${String(length.p90 ?? '?')} 字`,
    );
  }
  for (const rule of readStringArray(record.rules)) lines.push(`- ${rule}`);

  const relation = asRecord(record.relation_counts);
  if (relation) {
    lines.push(
      `- 关系分布：${Object.entries(relation).map(([key, count]) => `${key} ${String(count)}`).join('、')}`,
    );
  }
  return lines;
}

function renderAntiFanon(entry: FairyCorpusEntry): string[] {
  const risks = asRecord(entry.value)?.risks;
  if (!Array.isArray(risks)) return [];
  const lines: string[] = [];
  for (const item of risks) {
    const risk = asRecord(item);
    if (!risk) continue;
    const id = readString(risk.risk_id) ?? 'risk';
    const claim = readString(risk.claim) ?? '';
    const status = readString(risk.status) ?? '';
    lines.push(`- ${id}（${status}）：${claim}`);
  }
  return lines;
}

/**
 * 渲染注入用摘要。总长受 `maxChars` 约束，超出即截断并显式标注，
 * 以保证「注入上下文有上界」这一条不会随语料增长而失控。
 */
export function renderFairyCorpusDigest(
  corpus: FairyCorpus,
  options: FairyCorpusDigestOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_DIGEST_MAX_CHARS;
  const maxRules = options.maxRules ?? DEFAULT_DIGEST_MAX_RULES;
  const maxFacts = options.maxFactsPerFile ?? 12;
  const byId = new Map(corpus.entries.map((entry) => [entry.id, entry]));

  const blocks: string[] = [];

  const behavior = byId.get('behavior-rules');
  if (behavior?.loaded) {
    const rules = renderBehaviorRules(behavior, maxRules);
    if (rules.length) blocks.push(`【行为规则｜共 ${readItemCount(behavior)} 条，摘录 ${rules.length} 条】`, ...rules);
  }

  const speech = byId.get('speech-style');
  if (speech?.loaded) {
    const lines = renderSpeechStyle(speech);
    if (lines.length) blocks.push('【语域与句式统计】', ...lines);
  }

  const antiFanon = byId.get('anti-fanon');
  if (antiFanon?.loaded) {
    const lines = renderAntiFanon(antiFanon);
    if (lines.length) blocks.push('【已知漂移风险】', ...lines);
  }

  for (const id of ['canon', 'world-view', 'relationships', 'personality', 'real-ai-antipatterns'] as const) {
    const entry = byId.get(id);
    if (!entry?.loaded) continue;
    // 深度 3：`entries[0].claim` 这一层才是有内容的字符串；再深就会带出对话样例。
    const facts = collectLeafFacts(entry.value, { maxItems: maxFacts, maxDepth: 3 });
    if (facts.length) blocks.push(`【${labelOf(id)}】`, ...facts.map((fact) => `- ${fact}`));
  }

  const missing = corpus.entries.filter((entry) => !entry.loaded).map((entry) => entry.id);
  if (missing.length) blocks.push(`【未载入】${missing.join('、')}`);

  const header = `Fairy 语料摘要（${corpus.assetsDir}）。完整语料请按需读取该目录下的 JSON。`;
  const body = `${header}\n${blocks.join('\n')}`;
  return body.length > maxChars ? `${body.slice(0, maxChars)}\n…（摘要已按 ${maxChars} 字符上限截断，完整内容见语料文件）` : body;
}

function labelOf(id: string): string {
  const labels: Record<string, string> = {
    canon: '已确认设定',
    'world-view': '世界观',
    relationships: '人物关系',
    personality: '性格',
    'real-ai-antipatterns': '现实 AI 套话反例',
  };
  return labels[id] ?? id;
}

function readItemCount(entry: FairyCorpusEntry): number {
  const items = asRecord(entry.value)?.rules;
  return Array.isArray(items) ? items.length : 0;
}
