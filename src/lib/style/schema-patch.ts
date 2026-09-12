import { createEmptyPrompt } from './prompt-schema';

export type StyleSchemaPatchOp = 'replace' | 'set' | 'append' | 'remove';

export interface StyleSchemaPatch {
  op: StyleSchemaPatchOp;
  path: string;
  value?: unknown;
  reason: string;
  source_question_ids: string[];
  confidence: number;
}

export interface StyleSchemaPatchValidationResult {
  valid: boolean;
  errors: string[];
}

type UnknownRecord = Record<string, unknown>;

const PROMPT_SCHEMA_SHAPE = createEmptyPrompt() as unknown as UnknownRecord;
const ALLOWED_ROOT_PATHS: Record<string, true> = Object.fromEntries(
  Object.keys(PROMPT_SCHEMA_SHAPE).map((key) => [key, true]),
);

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isJsonSafe(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (isRecord(value)) return Object.values(value).every(isJsonSafe);
  return false;
}

function assertAllowedPath(path: string) {
  const segments = path.split('.');
  const root = segments[0];
  if (!ALLOWED_ROOT_PATHS[root]) {
    throw new Error(`Path root '${root}' is not allowed.`);
  }
  for (const segment of segments) {
    if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
      throw new Error(`Path segment '${segment}' is not allowed for security reasons.`);
    }
  }
  if (segments.length > 2) {
    throw new Error(`Path '${path}' does not exist in PromptSchema.`);
  }
  if (segments.length === 2) {
    const group = PROMPT_SCHEMA_SHAPE[root];
    if (!isRecord(group) || !Object.hasOwn(group, segments[1])) {
      throw new Error(`Path '${path}' does not exist in PromptSchema.`);
    }
  }
}

function getParent(root: UnknownRecord, path: string, createMissing = false): { parent: UnknownRecord; key: string } {
  const parts = path.split('.');
  const key = parts.pop()!;
  let parent: UnknownRecord = root;
  for (const part of parts) {
    if (!isRecord(parent[part]) || !Object.hasOwn(parent, part)) {
      if (createMissing) {
        parent[part] = {};
      } else {
        throw new Error(`Path segment '${part}' does not exist in schema.`);
      }
    }
    parent = parent[part] as UnknownRecord;
  }
  return { parent, key };
}

function toArrayItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function appendUnique(existing: unknown[], value: unknown): unknown[] {
  const items = toArrayItems(value);
  const result = [...existing];
  for (const item of items) {
    const str = JSON.stringify(item);
    if (!result.some((e) => JSON.stringify(e) === str)) {
      result.push(item);
    }
  }
  return result;
}

function appendText(existing: string, value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return existing;
  return existing ? `${existing}, ${text}` : text;
}

function applyOnePatch(root: UnknownRecord, patch: StyleSchemaPatch) {
  const { op, path, value } = patch;
  assertAllowedPath(path);

  switch (op) {
    case 'set': {
      const { parent, key } = getParent(root, path, true);
      parent[key] = value;
      break;
    }
    case 'replace': {
      const { parent, key } = getParent(root, path, false);
      if (parent[key] === undefined) throw new Error(`Cannot replace undefined path '${path}'.`);
      parent[key] = value;
      break;
    }
    case 'append': {
      const { parent, key } = getParent(root, path, true);
      const current = parent[key];
      if (Array.isArray(current)) {
        parent[key] = appendUnique(current, value);
      } else if (typeof current === 'string') {
        parent[key] = appendText(current, value);
      } else {
        parent[key] = value;
      }
      break;
    }
    case 'remove': {
      const { parent, key } = getParent(root, path, false);
      const current = parent[key];
      if (value !== undefined && Array.isArray(current)) {
        // Remove specific items matching value, not the whole array
        const toRemove = toArrayItems(value);
        const removeSet = new Set(toRemove.map(v => JSON.stringify(v)));
        parent[key] = current.filter(item => !removeSet.has(JSON.stringify(item)));
      } else {
        // Remove entire field
        delete parent[key];
      }
      break;
    }
    default:
      throw new Error(`Unknown patch op: ${op}`);
  }
}

export function validateStyleSchemaPatch(patches: StyleSchemaPatch[]): StyleSchemaPatchValidationResult {
  const errors: string[] = [];
  for (const patch of patches) {
    if (!patch.path || typeof patch.path !== 'string') {
      errors.push('Patch missing valid path.');
      continue;
    }
    if (!['set', 'replace', 'append', 'remove'].includes(patch.op)) {
      errors.push(`Invalid op '${patch.op}' for path '${patch.path}'.`);
      continue;
    }
    if (!isJsonSafe(patch.value)) {
      errors.push(`Value for path '${patch.path}' is not JSON-safe.`);
    }
    try {
      assertAllowedPath(patch.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `Path '${patch.path}' is not allowed.`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function applyStyleSchemaPatch<T>(schema: T, patches: StyleSchemaPatch[]): T {
  const root = cloneJson(schema);
  if (!isRecord(root)) throw new Error('Schema must be a JSON object.');
  for (const patch of patches) {
    applyOnePatch(root, patch);
  }
  return root as T;
}
