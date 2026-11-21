import { createNullRecord, hasOwn, isObjectRecord } from './safe-object.js';
import { MAX_SCHEMA_DEPTH, SchemaGuardError } from './types.js';

/**
 * Decodes a single RFC 6901 JSON Pointer segment (~1 -> /, ~0 -> ~).
 */
export function decodePointerSegment(segment: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Keep raw segment if invalid URI escape sequence
  }
  return decoded.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Encodes a single key as an RFC 6901 JSON Pointer segment.
 */
export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Formats a logical path by appending a segment.
 */
export function joinPointer(base: string, segment: string | number): string {
  const encoded = encodePointerSegment(String(segment));
  if (!base || base === '#') {
    return `#/${encoded}`;
  }
  return `${base}/${encoded}`;
}

export interface ResolvedNode {
  value: unknown;
  activeRefs: Set<string>;
}

/**
 * Resolves a local JSON Pointer (`#` or `#/path/to/target`) within `rootDoc`.
 */
export function lookupJsonPointer(rootDoc: unknown, pointer: string): unknown {
  if (pointer === '#') {
    return rootDoc;
  }
  if (!pointer.startsWith('#/')) {
    throw new SchemaGuardError(
      'EXTERNAL_REF_FORBIDDEN',
      `Unsupported or external $ref "${pointer}". Only local document pointers starting with "#/" are allowed.`
    );
  }

  const rawSegments = pointer.slice(2).split('/');
  if (rawSegments.length > MAX_SCHEMA_DEPTH) {
    throw new SchemaGuardError(
      'MAX_DEPTH_EXCEEDED',
      `$ref pointer "${pointer}" exceeds maximum depth (${MAX_SCHEMA_DEPTH}).`
    );
  }

  let current: unknown = rootDoc;
  for (const rawSeg of rawSegments) {
    const key = decodePointerSegment(rawSeg);
    if (Array.isArray(current)) {
      const idx = Number(key);
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) {
        throw new SchemaGuardError('PARSE_ERROR', `Unresolvable $ref "${pointer}": array index "${key}" out of bounds.`);
      }
      current = current[idx];
    } else if (isObjectRecord(current)) {
      if (!hasOwn(current, key)) {
        throw new SchemaGuardError('PARSE_ERROR', `Unresolvable $ref "${pointer}": property "${key}" not found.`);
      }
      current = current[key];
    } else {
      throw new SchemaGuardError('PARSE_ERROR', `Unresolvable $ref "${pointer}": cannot traverse non-object segment "${key}".`);
    }
  }
  return current;
}

/**
 * Resolves chained `$ref`s on `node` against `rootDoc`, tracking active references
 * to detect circular `$ref` chains and enforcing bounded recursion depth (<= 32).
 * Preserves sibling keywords (Draft 2020-12 / OpenAPI 3.1) over the resolved target.
 */
export function resolveSchemaNode(
  node: unknown,
  rootDoc: unknown,
  inheritedRefs: ReadonlySet<string>,
  depth: number
): ResolvedNode {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new SchemaGuardError(
      'MAX_DEPTH_EXCEEDED',
      `Schema traversal exceeded maximum recursion depth (${MAX_SCHEMA_DEPTH}).`
    );
  }

  if (!isObjectRecord(node) || typeof node['$ref'] !== 'string') {
    return { value: node, activeRefs: new Set(inheritedRefs) };
  }

  const activeRefs = new Set(inheritedRefs);
  let current: unknown = node;
  let hopCount = 0;

  while (isObjectRecord(current) && typeof current['$ref'] === 'string') {
    const refTarget = current['$ref'];
    if (!refTarget.startsWith('#')) {
      throw new SchemaGuardError(
        'EXTERNAL_REF_FORBIDDEN',
        `External $ref "${refTarget}" is not allowed; only internal "#/" references are supported.`
      );
    }

    if (activeRefs.has(refTarget)) {
      const chain = [...activeRefs, refTarget].join(' -> ');
      throw new SchemaGuardError('CIRCULAR_REF', `Circular $ref chain detected: ${chain}`);
    }

    hopCount += 1;
    if (depth + hopCount > MAX_SCHEMA_DEPTH) {
      throw new SchemaGuardError(
        'MAX_DEPTH_EXCEEDED',
        `$ref resolution exceeded maximum depth (${MAX_SCHEMA_DEPTH}).`
      );
    }

    activeRefs.add(refTarget);
    const resolvedTarget = lookupJsonPointer(rootDoc, refTarget);

    // Check if current object had sibling overrides alongside $ref
    const siblingKeys = Object.keys(current).filter((k) => k !== '$ref' && hasOwn(current as object, k));
    if (siblingKeys.length > 0 && isObjectRecord(resolvedTarget)) {
      const merged = createNullRecord<unknown>();
      for (const k of Object.keys(resolvedTarget)) {
        if (hasOwn(resolvedTarget, k)) {
          merged[k] = resolvedTarget[k];
        }
      }
      for (const k of siblingKeys) {
        merged[k] = (current as Record<string, unknown>)[k];
      }
      // If resolvedTarget itself had a $ref, preserve it unless overridden
      if (typeof resolvedTarget['$ref'] === 'string') {
        merged['$ref'] = resolvedTarget['$ref'];
      }
      current = merged;
    } else {
      current = resolvedTarget;
    }
  }

  return { value: current, activeRefs };
}

/**
 * Validates an entire document eagerly for circular `$ref` chains and excessive depth,
 * ensuring unused definitions with cycles or overly deep schemas are caught cleanly.
 */
export function validateDocumentGraph(rootDoc: unknown): void {
  function walk(node: unknown, activeRefs: ReadonlySet<string>, depth: number): void {
    if (depth > MAX_SCHEMA_DEPTH) {
      throw new SchemaGuardError(
        'MAX_DEPTH_EXCEEDED',
        `Schema nesting exceeded maximum allowed depth (${MAX_SCHEMA_DEPTH}).`
      );
    }
    if (node === null || typeof node !== 'object') {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item, activeRefs, depth + 1);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (typeof record['$ref'] === 'string') {
      const resolved = resolveSchemaNode(record, rootDoc, activeRefs, depth);
      walk(resolved.value, resolved.activeRefs, depth + 1);
      // Also inspect any non-$ref sibling subtrees
      for (const key of Object.keys(record)) {
        if (key === '$ref' || !hasOwn(record, key)) continue;
        walk(record[key], activeRefs, depth + 1);
      }
      return;
    }

    for (const key of Object.keys(record)) {
      if (!hasOwn(record, key)) continue;
      walk(record[key], activeRefs, depth + 1);
    }
  }

  walk(rootDoc, new Set<string>(), 0);
}
