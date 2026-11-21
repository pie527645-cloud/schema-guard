import { MAX_SCHEMA_DEPTH, SchemaGuardError } from './types.js';

/**
 * Creates a null-prototype dictionary immune to prototype pollution keys
 * such as __proto__, constructor, and toString.
 */
export function createNullRecord<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Safe wrapper around Object.hasOwn.
 */
export function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.hasOwn(obj, key);
}

/**
 * Checks whether a value is a non-null, non-array plain object or null-prototype object.
 */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deterministically compares two ASCII/UTF-16 strings without locale variance.
 */
export function compareStringsLex(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Converts any parsed JSON/YAML structure into null-prototype objects recursively,
 * enforcing bounded depth to prevent stack overflows on adversarial inputs.
 */
export function sanitizeStructure(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCHEMA_DEPTH + 16) {
    throw new SchemaGuardError(
      'MAX_DEPTH_EXCEEDED',
      `Document nesting exceeds maximum allowed depth (${MAX_SCHEMA_DEPTH}).`
    );
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeStructure(item, depth + 1));
  }
  const out = createNullRecord<unknown>();
  for (const key of Object.keys(value)) {
    if (!hasOwn(value, key)) continue;
    out[key] = sanitizeStructure((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

/**
 * Produces a deterministic, recursively key-sorted structure suitable for
 * canonical JSON serialization.
 */
export function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > MAX_SCHEMA_DEPTH + 16) {
    throw new SchemaGuardError(
      'MAX_DEPTH_EXCEEDED',
      `Value exceeds maximum canonicalization depth (${MAX_SCHEMA_DEPTH}).`
    );
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort(compareStringsLex);
  const out = createNullRecord<unknown>();
  for (const key of sortedKeys) {
    if (!hasOwn(record, key)) continue;
    const propVal = record[key];
    if (propVal === undefined) continue;
    if (key === 'required' && Array.isArray(propVal) && propVal.every((x) => typeof x === 'string')) {
      const uniqueSorted = Array.from(new Set(propVal as string[])).sort(compareStringsLex);
      out[key] = uniqueSorted;
    } else {
      out[key] = canonicalize(propVal, depth + 1);
    }
  }
  return out;
}

/**
 * Structural deep equality with bounded recursion depth and key-order independence.
 */
export function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (depth > MAX_SCHEMA_DEPTH + 16) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i], depth + 1)) return false;
    }
    return true;
  }
  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;
  const keysA = Object.keys(recA).filter((k) => hasOwn(recA, k) && recA[k] !== undefined);
  const keysB = Object.keys(recB).filter((k) => hasOwn(recB, k) && recB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!hasOwn(recB, key)) return false;
    if (!deepEqual(recA[key], recB[key], depth + 1)) return false;
  }
  return true;
}

/**
 *Deterministic JSON string representation for fingerprinting enum values and union variants.
 */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
