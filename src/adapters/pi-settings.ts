/**
 * 适配层：设置语义映射。
 *
 * 上游用 `@deepseek-ai/dsh-settings` 的 `settingsNamespace(name)` +
 * `@deepseek-ai/schemastery` 的 `settings.register(ns, schema)` 声明带默认值、
 * 取值范围与枚举的命名空间。**Pi 没有这两样东西**：`pi.getSettings()` 返回的是
 * settings.json 的固定 schema（无索引签名），既不能注册命名空间，也不能写入自定义字段。
 *
 * 因此这里做三项显式替换：
 *   1. 用本文件内的描述符表（`FairySettingsSchema`）承载 schemastery 的
 *      default / min / max / step / union 语义；
 *   2. 用 `FairySettingsStore` 端口承载存取，Pi 的 settings.json 不在其中——
 *      Fairy 的设置属于 Fairy 自己的数据目录，不写 `agent_data`；
 *   3. 用 `createFairySettingsRegistry` 提供 `get`/`set`，默认值在读取时补齐。
 *
 * 本模块不含业务默认值之外的行为：不落盘、不监听变更、不做 v1→v2 迁移
 * （迁移规则由后续功能阶段带入，这里只把版本不一致报出来）。
 */

import {
  FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_NAMESPACE,
  FAIRY_VISUAL_SETTINGS_VERSION,
} from '../contracts/index.ts';
import { createFairyDiagnostics } from '../contracts/index.ts';
import type { FairyDiagnostics } from '../contracts/index.ts';

export interface FairyNumberField {
  kind: 'number';
  default: number;
  min?: number;
  max?: number;
  step?: number;
}

export interface FairyBooleanField {
  kind: 'boolean';
  default: boolean;
}

export interface FairyStringField {
  kind: 'string';
  default: string;
}

export interface FairyStringArrayField {
  kind: 'string-array';
  default: readonly string[];
}

export interface FairyEnumField {
  kind: 'enum';
  default: string | number;
  values: readonly (string | number)[];
}

export type FairyFieldRules =
  | FairyNumberField
  | FairyBooleanField
  | FairyStringField
  | FairyStringArrayField
  | FairyEnumField;

export interface FairySettingsSchema {
  namespace: string;
  version: number;
  fields: Readonly<Record<string, FairyFieldRules>>;
}

export const FAIRY_VISUAL_SCHEMA: FairySettingsSchema = {
  namespace: FAIRY_VISUAL_SETTINGS_NAMESPACE,
  version: FAIRY_VISUAL_SETTINGS_VERSION,
  fields: {
    version: { kind: 'number', default: FAIRY_VISUAL_SETTINGS_VERSION, step: 1 },
    enabled: { kind: 'boolean', default: false },
    theme: { kind: 'enum', default: 'dark', values: ['dark', 'light'] },
    mascotVisible: { kind: 'boolean', default: true },
    mascotScale: { kind: 'number', default: 1, min: 0.55, max: 1, step: 0.01 },
    mascotAnimationSpeed: { kind: 'enum', default: 1, values: [0.7, 1, 1.5] },
    powerMode: { kind: 'enum', default: 'normal', values: ['normal', 'low-power'] },
    composerDockHeight: { kind: 'number', default: 132, min: 132, max: 420, step: 1 },
  },
};

export const FAIRY_IDENTITY_SCHEMA: FairySettingsSchema = {
  namespace: FAIRY_IDENTITY_SETTINGS_NAMESPACE,
  version: FAIRY_VISUAL_SETTINGS_VERSION,
  fields: {
    mode: { kind: 'enum', default: 'ling', values: ['ling', 'zhe', 'custom'] },
    customName: { kind: 'string', default: '' },
    secondAssistant: { kind: 'string', default: '' },
    household: { kind: 'string-array', default: [] },
  },
};

export const FAIRY_SETTINGS_SCHEMAS: readonly FairySettingsSchema[] = [
  FAIRY_VISUAL_SCHEMA,
  FAIRY_IDENTITY_SCHEMA,
];

export interface FairySettingsResolution {
  value: Record<string, unknown>;
  issues: readonly string[];
}

function decimalsOf(step: number): number {
  const text = String(step);
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : text.length - dot - 1;
}

function resolveField(name: string, rules: FairyFieldRules, raw: unknown, issues: string[]) {
  if (raw === undefined || raw === null) return rules.default;

  switch (rules.kind) {
    case 'number': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        issues.push(`${name}:not-a-number`);
        return rules.default;
      }
      let value = raw;
      if (rules.step) {
        const rounded = Math.round(value / rules.step) * rules.step;
        if (rounded !== value) issues.push(`${name}:rounded-to-step`);
        value = Number(rounded.toFixed(decimalsOf(rules.step)));
      }
      if (rules.min !== undefined && value < rules.min) {
        issues.push(`${name}:below-min`);
        value = rules.min;
      }
      if (rules.max !== undefined && value > rules.max) {
        issues.push(`${name}:above-max`);
        value = rules.max;
      }
      return value;
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        issues.push(`${name}:not-a-boolean`);
        return rules.default;
      }
      return raw;
    }
    case 'string': {
      if (typeof raw !== 'string') {
        issues.push(`${name}:not-a-string`);
        return rules.default;
      }
      return raw;
    }
    case 'string-array': {
      if (!Array.isArray(raw)) {
        issues.push(`${name}:not-an-array`);
        return [...rules.default];
      }
      const items = raw.filter((item): item is string => typeof item === 'string');
      if (items.length !== raw.length) issues.push(`${name}:dropped-non-string-items`);
      return items;
    }
    case 'enum': {
      if (!rules.values.includes(raw as string | number)) {
        issues.push(`${name}:not-in-enum`);
        return rules.default;
      }
      return raw;
    }
  }
}

/**
 * 把外部输入解析成符合描述符的完整取值：缺字段补默认值，越界取边界，
 * 非法值回退默认值，未声明的字段被丢弃（与 schemastery 行为一致）。
 */
export function resolveFairySettings(
  schema: FairySettingsSchema,
  raw: unknown,
): FairySettingsResolution {
  const issues: string[] = [];
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const value: Record<string, unknown> = {};

  for (const [name, rules] of Object.entries(schema.fields)) {
    value[name] = resolveField(name, rules, source[name], issues);
  }

  for (const key of Object.keys(source)) {
    if (!(key in schema.fields)) issues.push(`unknown:${key}`);
  }

  if (value.version !== undefined && value.version !== schema.version) {
    issues.push(`version:${String(value.version)}!=${schema.version}`);
  }

  return { value, issues };
}

export function findFairySettingsSchema(
  namespace: string,
): FairySettingsSchema | undefined {
  return FAIRY_SETTINGS_SCHEMAS.find((schema) => schema.namespace === namespace);
}

/** 持久化端口。Pi 的 settings.json 不是实现之一。 */
export interface FairySettingsStore {
  read(namespace: string): unknown;
  write(namespace: string, value: unknown): void;
}

export function createMemorySettingsStore(
  initial: Record<string, unknown> = {},
): FairySettingsStore {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    read: (namespace) => data.get(namespace),
    write: (namespace, value) => {
      data.set(namespace, value);
    },
  };
}

export interface FairySettingsRegistry {
  namespaces(): readonly string[];
  schema(namespace: string): FairySettingsSchema;
  /** 读取并补齐默认值；未注册的命名空间抛错。 */
  get<T = Record<string, unknown>>(namespace: string): T;
  /** 解析后写入；返回实际落库的取值。 */
  set(namespace: string, value: unknown): Record<string, unknown>;
}

export interface FairySettingsRegistryOptions {
  store: FairySettingsStore;
  diagnostics?: FairyDiagnostics;
}

export function createFairySettingsRegistry(
  options: FairySettingsRegistryOptions,
): FairySettingsRegistry {
  const diagnostics = options.diagnostics ?? createFairyDiagnostics('fairy-pi-adapters');

  const schemaOf = (namespace: string): FairySettingsSchema => {
    const schema = findFairySettingsSchema(namespace);
    if (!schema) {
      throw new Error(
        `未注册的设置命名空间: ${namespace}（已知: ${FAIRY_SETTINGS_SCHEMAS.map((entry) => entry.namespace).join(', ')}）`,
      );
    }
    return schema;
  };

  return {
    namespaces: () => FAIRY_SETTINGS_SCHEMAS.map((schema) => schema.namespace),
    schema: schemaOf,
    get<T = Record<string, unknown>>(namespace: string): T {
      const schema = schemaOf(namespace);
      const { value, issues } = resolveFairySettings(schema, options.store.read(namespace));
      if (issues.length) diagnostics.warn('settings-read', { namespace, issues });
      return value as T;
    },
    set(namespace, value) {
      const schema = schemaOf(namespace);
      const { value: resolved, issues } = resolveFairySettings(schema, value);
      if (issues.length) diagnostics.warn('settings-write', { namespace, issues });
      options.store.write(namespace, resolved);
      return resolved;
    },
  };
}
