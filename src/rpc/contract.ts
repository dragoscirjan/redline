import { readFile } from 'node:fs/promises';
import { FRAME_LIMITS } from '../transport/framing.ts';

export const VERSION = '1.0';
export const LIMITS = Object.freeze({
  ...FRAME_LIMITS, batchSize: 16, historyRuns: 8, retainedBytes: 8 * 1024 * 1024,
  resultPageItems: 50, frameTimeoutMs: 10_000,
});
export const CODES = Object.freeze({
  parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603,
  initialize: -32000, version: -32001, busy: -32002, missing: -32003, limit: -32004,
  configuration: -32100, revision: -32101, model: -32102, timeout: -32103,
  cancellation: -32104, validation: -32105, capability: -32106,
});
export type Id = string | number;
export interface WireError { readonly code: number; readonly message: string }
export class RpcFault extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
export function fault(error: unknown): WireError {
  return error instanceof RpcFault ? { code: error.code, message: error.message } : { code: CODES.internal, message: 'Internal error' };
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type Schema = Record<string, unknown>;
const document = JSON.parse(await readFile(new URL('../../schemas/rpc/v1/protocol.schema.json', import.meta.url), 'utf8')) as { $defs: Record<string, Schema> };

const VOCABULARY = new Set(['$schema', '$id', '$defs', 'title', 'description', '$ref', 'type', 'const', 'enum',
  'allOf', 'anyOf', 'oneOf', 'not', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum',
  'minItems', 'maxItems', 'items', 'required', 'properties', 'additionalProperties', 'dependentRequired']);
/** Fail startup rather than silently ignore a future schema keyword the interpreter cannot enforce. */
export function assertSchemaVocabulary(schema: unknown): void {
  if (!object(schema) || Object.keys(schema).some(key => !VOCABULARY.has(key))) throw new Error('Unsupported protocol schema vocabulary');
  if (schema.type !== undefined && (typeof schema.type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type))) throw new Error('Unsupported schema type');
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') throw new Error('Unsupported additional-property schema');
  if (schema.$ref !== undefined && (typeof schema.$ref !== 'string' || !/^#\/\$defs\/[A-Za-z]+$/u.test(schema.$ref)
    || Object.keys(schema).some(key => !['$ref', 'title', 'description'].includes(key)))) throw new Error('Unsupported schema reference');
  for (const key of ['$defs', 'properties']) if (object(schema[key])) for (const child of Object.values(schema[key])) assertSchemaVocabulary(child);
  for (const key of ['allOf', 'anyOf', 'oneOf']) if (Array.isArray(schema[key])) for (const child of schema[key]) assertSchemaVocabulary(child);
  for (const key of ['items', 'not']) if (schema[key] !== undefined) assertSchemaVocabulary(schema[key]);
}
assertSchemaVocabulary(document);

/** Interpreter for the finite schema vocabulary used by our committed contract.
 * The schema is trusted package data; input values never select files or code. */
function matches(value: unknown, schema: Schema, depth = 0): boolean {
  if (depth > 64) return false;
  const reference = schema.$ref;
  if (typeof reference === 'string') {
    const target = document.$defs[reference.replace('#/$defs/', '')];
    return target !== undefined && matches(value, target, depth + 1);
  }
  for (const [key, predicate] of [
    ['allOf', (values: boolean[]) => values.every(Boolean)],
    ['anyOf', (values: boolean[]) => values.some(Boolean)],
    ['oneOf', (values: boolean[]) => values.filter(Boolean).length === 1],
  ] as const) {
    const alternatives = schema[key];
    if (Array.isArray(alternatives) && !predicate(alternatives.map(s => object(s) && matches(value, s, depth + 1)))) return false;
  }
  if (object(schema.not) && matches(value, schema.not, depth + 1)) return false;
  if ('const' in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'null' && value !== null) return false;
  if (schema.type === 'boolean' && typeof value !== 'boolean') return false;
  if (schema.type === 'string') {
    if (typeof value !== 'string') return false;
    let length = 0;
    for (const _character of value) length++;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isSafeInteger(value))) return false;
    if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
    if (object(schema.items) && !value.every(v => matches(v, schema.items as Schema, depth + 1))) return false;
  }
  if (schema.type === 'object' && !object(value)) return false;
  if (object(value)) {
    if (Array.isArray(schema.required) && schema.required.some(key => typeof key !== 'string' || !Object.hasOwn(value, key))) return false;
    const properties = object(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key) && object(child) && !matches(value[key], child, depth + 1)) return false;
    }
    if (object(schema.dependentRequired)) for (const [key, required] of Object.entries(schema.dependentRequired)) {
      if (Object.hasOwn(value, key) && Array.isArray(required) && required.some(k => typeof k !== 'string' || !Object.hasOwn(value, k))) return false;
    }
  }
  return true;
}
export function valid(name: string, value: unknown): boolean {
  const schema = document.$defs[name];
  return schema !== undefined && matches(value, schema);
}
export function params(name: string, value: unknown): Record<string, unknown> {
  if (!valid(name + 'Params', value) || !object(value)) throw new RpcFault(CODES.params, 'Invalid params');
  return value;
}
