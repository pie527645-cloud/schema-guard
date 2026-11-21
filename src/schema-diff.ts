import { encodePointerSegment, joinPointer, resolveSchemaNode } from './ref-resolver.js';
import {
  canonicalJsonString,
  createNullRecord,
  deepEqual,
  hasOwn,
  isObjectRecord
} from './safe-object.js';
import {
  type ChangeItem,
  MAX_SCHEMA_DEPTH,
  type SchemaDirection,
  SchemaGuardError
} from './types.js';

export interface SchemaDiffContext {
  oldRoot: unknown;
  newRoot: unknown;
  direction: SchemaDirection;
  path: string;
  depth: number;
  oldActiveRefs: ReadonlySet<string>;
  newActiveRefs: ReadonlySet<string>;
  changes: ChangeItem[];
}

interface NumericBound {
  value: number;
  exclusive: boolean;
}

function isRequestLike(direction: SchemaDirection): boolean {
  return direction === 'request' || direction === 'standalone';
}

/**
 * Merges `allOf` subschemas into an effective object schema view (properties, required)
 * while keeping non-merged keywords intact on the base node.
 */
function flattenAllOfObjectView(
  schema: Record<string, unknown>,
  rootDoc: unknown,
  activeRefs: ReadonlySet<string>,
  depth: number
): Record<string, unknown> {
  if (!Array.isArray(schema['allOf']) || schema['allOf'].length === 0) {
    return schema;
  }

  const merged = createNullRecord<unknown>();
  const mergedProperties = createNullRecord<unknown>();
  const mergedRequired = new Set<string>();
  let hasProperties = false;
  let hasRequired = false;

  // Copy top-level keys first (excluding allOf)
  for (const k of Object.keys(schema)) {
    if (k === 'allOf' || !hasOwn(schema, k)) continue;
    merged[k] = schema[k];
  }

  if (isObjectRecord(schema['properties'])) {
    hasProperties = true;
    const props = schema['properties'];
    for (const pk of Object.keys(props)) {
      if (hasOwn(props, pk)) {
        mergedProperties[pk] = props[pk];
      }
    }
  }
  if (Array.isArray(schema['required'])) {
    hasRequired = true;
    for (const r of schema['required']) {
      if (typeof r === 'string') mergedRequired.add(r);
    }
  }

  for (const branch of schema['allOf']) {
    const resolvedBranch = resolveSchemaNode(branch, rootDoc, activeRefs, depth + 1);
    if (!isObjectRecord(resolvedBranch.value)) continue;
    const flatBranch = flattenAllOfObjectView(
      resolvedBranch.value,
      rootDoc,
      resolvedBranch.activeRefs,
      depth + 1
    );

    if (isObjectRecord(flatBranch['properties'])) {
      hasProperties = true;
      const bProps = flatBranch['properties'];
      for (const pk of Object.keys(bProps)) {
        if (hasOwn(bProps, pk)) {
          mergedProperties[pk] = bProps[pk];
        }
      }
    }
    if (Array.isArray(flatBranch['required'])) {
      hasRequired = true;
      for (const r of flatBranch['required']) {
        if (typeof r === 'string') mergedRequired.add(r);
      }
    }
    if (!hasOwn(merged, 'type') && typeof flatBranch['type'] === 'string') {
      merged['type'] = flatBranch['type'];
    }
    if (!hasOwn(merged, 'additionalProperties') && hasOwn(flatBranch, 'additionalProperties')) {
      merged['additionalProperties'] = flatBranch['additionalProperties'];
    }
  }

  if (hasProperties) {
    merged['properties'] = mergedProperties;
  }
  if (hasRequired) {
    merged['required'] = Array.from(mergedRequired);
  }

  return merged;
}

function extractTypeSet(schema: Record<string, unknown>): Set<string> | null {
  const rawType = schema['type'];
  const types = new Set<string>();

  if (typeof rawType === 'string') {
    types.add(rawType);
  } else if (Array.isArray(rawType)) {
    for (const item of rawType) {
      if (typeof item === 'string') {
        types.add(item);
      }
    }
  }

  if (types.size === 0) {
    return null;
  }

  if (schema['nullable'] === true) {
    types.add('null');
  }

  return types;
}

function isTypeAcceptedBy(candidate: string, allowedSet: ReadonlySet<string>): boolean {
  if (allowedSet.has(candidate)) return true;
  if (candidate === 'integer' && allowedSet.has('number')) return true;
  return false;
}

function extractMinBound(schema: Record<string, unknown>): NumericBound | null {
  if (typeof schema['exclusiveMinimum'] === 'number') {
    return { value: schema['exclusiveMinimum'], exclusive: true };
  }
  if (typeof schema['minimum'] === 'number') {
    return {
      value: schema['minimum'],
      exclusive: schema['exclusiveMinimum'] === true
    };
  }
  return null;
}

function extractMaxBound(schema: Record<string, unknown>): NumericBound | null {
  if (typeof schema['exclusiveMaximum'] === 'number') {
    return { value: schema['exclusiveMaximum'], exclusive: true };
  }
  if (typeof schema['maximum'] === 'number') {
    return {
      value: schema['maximum'],
      exclusive: schema['exclusiveMaximum'] === true
    };
  }
  return null;
}

function compareMinBounds(oldMin: NumericBound | null, newMin: NumericBound | null): 'same' | 'tightened' | 'loosened' {
  if (oldMin === null && newMin === null) return 'same';
  if (oldMin === null && newMin !== null) return 'tightened';
  if (oldMin !== null && newMin === null) return 'loosened';
  const a = oldMin!;
  const b = newMin!;
  if (b.value > a.value) return 'tightened';
  if (b.value < a.value) return 'loosened';
  if (b.exclusive && !a.exclusive) return 'tightened';
  if (!b.exclusive && a.exclusive) return 'loosened';
  return 'same';
}

function compareMaxBounds(oldMax: NumericBound | null, newMax: NumericBound | null): 'same' | 'tightened' | 'loosened' {
  if (oldMax === null && newMax === null) return 'same';
  if (oldMax === null && newMax !== null) return 'tightened';
  if (oldMax !== null && newMax === null) return 'loosened';
  const a = oldMax!;
  const b = newMax!;
  if (b.value < a.value) return 'tightened';
  if (b.value > a.value) return 'loosened';
  if (b.exclusive && !a.exclusive) return 'tightened';
  if (!b.exclusive && a.exclusive) return 'loosened';
  return 'same';
}

function diffNonNegativeFloor(
  keyword: 'minLength' | 'minItems' | 'minProperties',
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  ctx: SchemaDiffContext
): void {
  const oldVal = typeof oldSchema[keyword] === 'number' ? (oldSchema[keyword] as number) : 0;
  const newVal = typeof newSchema[keyword] === 'number' ? (newSchema[keyword] as number) : 0;
  if (oldVal === newVal) return;

  const rawOld = hasOwn(oldSchema, keyword) ? oldSchema[keyword] : undefined;
  const rawNew = hasOwn(newSchema, keyword) ? newSchema[keyword] : undefined;

  if (newVal > oldVal) {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_TIGHTENED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, keyword),
      message: `${keyword} increased from ${rawOld ?? 0} to ${newVal}.`,
      before: rawOld,
      after: rawNew
    });
  } else {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_LOOSENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, keyword),
      message: `${keyword} decreased from ${oldVal} to ${rawNew ?? 0}.`,
      before: rawOld,
      after: rawNew
    });
  }
}

function diffCeilingBound(
  keyword: 'maxLength' | 'maxItems' | 'maxProperties',
  oldSchema: Record<string, unknown>,
  newSchema: Record<string, unknown>,
  ctx: SchemaDiffContext
): void {
  const oldVal = typeof oldSchema[keyword] === 'number' ? (oldSchema[keyword] as number) : undefined;
  const newVal = typeof newSchema[keyword] === 'number' ? (newSchema[keyword] as number) : undefined;
  if (oldVal === newVal) return;

  const tightened =
    (oldVal === undefined && newVal !== undefined) ||
    (oldVal !== undefined && newVal !== undefined && newVal < oldVal);

  if (tightened) {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_TIGHTENED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, keyword),
      message:
        oldVal === undefined
          ? `${keyword} added (${newVal}), tightening maximum bound.`
          : `${keyword} decreased from ${oldVal} to ${newVal}.`,
      before: oldVal,
      after: newVal
    });
  } else {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_LOOSENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, keyword),
      message:
        newVal === undefined
          ? `${keyword} (${oldVal}) removed, loosening validation.`
          : `${keyword} increased from ${oldVal} to ${newVal}.`,
      before: oldVal,
      after: newVal
    });
  }
}

function variantIdentityKey(rawVariant: unknown, resolvedVariant: unknown): string | null {
  if (isObjectRecord(rawVariant) && typeof rawVariant['$ref'] === 'string') {
    return `ref:${rawVariant['$ref']}`;
  }
  if (!isObjectRecord(resolvedVariant)) return null;
  if (hasOwn(resolvedVariant, 'const')) {
    return `const:${canonicalJsonString(resolvedVariant['const'])}`;
  }
  if (typeof resolvedVariant['title'] === 'string' && resolvedVariant['title'].length > 0) {
    return `title:${resolvedVariant['title']}`;
  }
  if (typeof resolvedVariant['type'] === 'string') {
    return `type:${resolvedVariant['type']}`;
  }
  return null;
}

function diffUnionKeyword(
  keyword: 'oneOf' | 'anyOf',
  oldList: unknown[],
  newList: unknown[],
  ctx: SchemaDiffContext
): void {
  const unionPath = joinPointer(ctx.path, keyword);

  const oldResolved = oldList.map((item) => {
    const res = resolveSchemaNode(item, ctx.oldRoot, ctx.oldActiveRefs, ctx.depth + 1);
    return {
      raw: item,
      value: res.value,
      refs: res.activeRefs,
      fingerprint: canonicalJsonString(res.value),
      identity: variantIdentityKey(item, res.value)
    };
  });

  const newResolved = newList.map((item) => {
    const res = resolveSchemaNode(item, ctx.newRoot, ctx.newActiveRefs, ctx.depth + 1);
    return {
      raw: item,
      value: res.value,
      refs: res.activeRefs,
      fingerprint: canonicalJsonString(res.value),
      identity: variantIdentityKey(item, res.value)
    };
  });

  const matchedOld = new Set<number>();
  const matchedNew = new Set<number>();

  // Pass 1: exact structural match
  for (let i = 0; i < oldResolved.length; i++) {
    const o = oldResolved[i]!;
    for (let j = 0; j < newResolved.length; j++) {
      if (matchedNew.has(j)) continue;
      const n = newResolved[j]!;
      if (o.fingerprint === n.fingerprint) {
        matchedOld.add(i);
        matchedNew.add(j);
        break;
      }
    }
  }

  // Pass 2: unique identity match ($ref, const, title, or unique type) -> recurse
  for (let i = 0; i < oldResolved.length; i++) {
    if (matchedOld.has(i)) continue;
    const o = oldResolved[i]!;
    if (!o.identity) continue;

    const oldSameId = oldResolved.filter((cand, idx) => !matchedOld.has(idx) && cand.identity === o.identity);
    const newSameIdIndices: number[] = [];
    for (let j = 0; j < newResolved.length; j++) {
      if (!matchedNew.has(j) && newResolved[j]!.identity === o.identity) {
        newSameIdIndices.push(j);
      }
    }

    if (oldSameId.length === 1 && newSameIdIndices.length === 1) {
      const j = newSameIdIndices[0]!;
      const n = newResolved[j]!;
      matchedOld.add(i);
      matchedNew.add(j);
      diffSchemaNodes(o.value, n.value, {
        ...ctx,
        path: joinPointer(unionPath, j),
        depth: ctx.depth + 1,
        oldActiveRefs: o.refs,
        newActiveRefs: n.refs
      });
    }
  }

  for (let i = 0; i < oldResolved.length; i++) {
    if (!matchedOld.has(i)) {
      ctx.changes.push({
        id: 'SCHEMA_UNION_VARIANT_REMOVED',
        severity: 'BREAKING',
        path: joinPointer(unionPath, i),
        message: `Removed variant at ${keyword}[${i}].`,
        before: oldResolved[i]!.value
      });
    }
  }

  for (let j = 0; j < newResolved.length; j++) {
    if (!matchedNew.has(j)) {
      ctx.changes.push({
        id: 'SCHEMA_UNION_VARIANT_ADDED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: joinPointer(unionPath, j),
        message: `Added variant at ${keyword}[${j}].`,
        after: newResolved[j]!.value
      });
    }
  }
}

/**
 * Recursively compares two JSON Schema nodes (Draft 7 / 2020-12 / OpenAPI 3.0 / 3.1).
 */
export function diffSchemaNodes(
  rawOld: unknown,
  rawNew: unknown,
  ctx: SchemaDiffContext
): void {
  if (ctx.depth > MAX_SCHEMA_DEPTH) {
    throw new SchemaGuardError(
      'MAX_DEPTH_EXCEEDED',
      `Schema comparison exceeded maximum recursion depth (${MAX_SCHEMA_DEPTH}) at "${ctx.path}".`
    );
  }

  const oldRes = resolveSchemaNode(rawOld, ctx.oldRoot, ctx.oldActiveRefs, ctx.depth);
  const newRes = resolveSchemaNode(rawNew, ctx.newRoot, ctx.newActiveRefs, ctx.depth);

  const oldVal = oldRes.value;
  const newVal = newRes.value;

  // Handle boolean schemas (true = unconstrained, false = reject all)
  if (typeof oldVal === 'boolean' || typeof newVal === 'boolean') {
    if (oldVal === newVal) return;
    if (newVal === false) {
      ctx.changes.push({
        id: 'SCHEMA_RESTRICTED_TO_FALSE',
        severity: 'BREAKING',
        path: ctx.path,
        message: 'Schema changed to boolean false (rejects all values).',
        before: oldVal,
        after: newVal
      });
      return;
    }
    if (oldVal === false) {
      ctx.changes.push({
        id: 'SCHEMA_OPENED_FROM_FALSE',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: ctx.path,
        message: 'Schema loosened from boolean false.',
        before: oldVal,
        after: newVal
      });
      return;
    }
    // One side is true (open) and the other is an object schema
    if (oldVal === true && isObjectRecord(newVal)) {
      if (Object.keys(newVal).length > 0) {
        ctx.changes.push({
          id: 'SCHEMA_CONSTRAINTS_ADDED',
          severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
          path: ctx.path,
          message: 'Schema changed from unconstrained boolean true to constrained object schema.',
          before: true,
          after: newVal
        });
      }
      return;
    }
    if (isObjectRecord(oldVal) && newVal === true) {
      if (Object.keys(oldVal).length > 0) {
        ctx.changes.push({
          id: 'SCHEMA_CONSTRAINTS_REMOVED',
          severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
          path: ctx.path,
          message: 'Schema loosened from constrained object schema to boolean true.',
          before: oldVal,
          after: true
        });
      }
      return;
    }
  }

  if (!isObjectRecord(oldVal) || !isObjectRecord(newVal)) {
    return;
  }

  const oldSchema = flattenAllOfObjectView(oldVal, ctx.oldRoot, oldRes.activeRefs, ctx.depth);
  const newSchema = flattenAllOfObjectView(newVal, ctx.newRoot, newRes.activeRefs, ctx.depth);

  const nextCtxBase: SchemaDiffContext = {
    ...ctx,
    oldActiveRefs: oldRes.activeRefs,
    newActiveRefs: newRes.activeRefs
  };

  // 1. Deprecated flag
  if (oldSchema['deprecated'] !== true && newSchema['deprecated'] === true) {
    ctx.changes.push({
      id: 'SCHEMA_DEPRECATED_ADDED',
      severity: 'DANGEROUS',
      path: joinPointer(ctx.path, 'deprecated'),
      message: 'Schema element marked deprecated.',
      before: oldSchema['deprecated'] ?? false,
      after: true
    });
  }

  // 2. Description change
  const oldDesc = typeof oldSchema['description'] === 'string' ? oldSchema['description'] : undefined;
  const newDesc = typeof newSchema['description'] === 'string' ? newSchema['description'] : undefined;
  if (oldDesc !== newDesc && (oldDesc !== undefined || newDesc !== undefined)) {
    ctx.changes.push({
      id: 'DESCRIPTION_CHANGED',
      severity: 'NON_BREAKING',
      path: joinPointer(ctx.path, 'description'),
      message: 'Description updated.',
      before: oldDesc,
      after: newDesc
    });
  }

  // 3. Default value change
  const oldHasDefault = hasOwn(oldSchema, 'default');
  const newHasDefault = hasOwn(newSchema, 'default');
  if (oldHasDefault || newHasDefault) {
    if (!oldHasDefault || !newHasDefault || !deepEqual(oldSchema['default'], newSchema['default'])) {
      ctx.changes.push({
        id: 'SCHEMA_DEFAULT_CHANGED',
        severity: 'DANGEROUS',
        path: joinPointer(ctx.path, 'default'),
        message: !oldHasDefault
          ? `Default value added (${JSON.stringify(newSchema['default'])}).`
          : !newHasDefault
            ? `Default value (${JSON.stringify(oldSchema['default'])}) removed.`
            : `Default value changed from ${JSON.stringify(oldSchema['default'])} to ${JSON.stringify(newSchema['default'])}.`,
        before: oldSchema['default'],
        after: newSchema['default']
      });
    }
  }

  // 4. Format change
  const oldFormat = typeof oldSchema['format'] === 'string' ? oldSchema['format'] : undefined;
  const newFormat = typeof newSchema['format'] === 'string' ? newSchema['format'] : undefined;
  if (oldFormat !== newFormat) {
    ctx.changes.push({
      id: 'SCHEMA_FORMAT_CHANGED',
      severity: 'DANGEROUS',
      path: joinPointer(ctx.path, 'format'),
      message:
        oldFormat === undefined
          ? `Format "${newFormat}" added.`
          : newFormat === undefined
            ? `Format "${oldFormat}" removed.`
            : `Format changed from "${oldFormat}" to "${newFormat}".`,
      before: oldFormat,
      after: newFormat
    });
  }

  // 5. Type / nullable comparison
  const oldTypes = extractTypeSet(oldSchema);
  const newTypes = extractTypeSet(newSchema);

  if (oldTypes !== null && newTypes !== null) {
    const removedTypes = [...oldTypes].filter((t) => !isTypeAcceptedBy(t, newTypes));
    const addedTypes = [...newTypes].filter((t) => !isTypeAcceptedBy(t, oldTypes));

    if (removedTypes.length > 0 && addedTypes.length > 0) {
      ctx.changes.push({
        id: 'SCHEMA_TYPE_CHANGED',
        severity: 'BREAKING',
        path: joinPointer(ctx.path, 'type'),
        message: `Type changed incompatibly from [${[...oldTypes].join(', ')}] to [${[...newTypes].join(', ')}].`,
        before: [...oldTypes],
        after: [...newTypes]
      });
      // Do not inspect type-specific sub-constraints when the fundamental type was replaced incompatibly
      return;
    } else if (removedTypes.length > 0) {
      ctx.changes.push({
        id: 'SCHEMA_TYPE_NARROWED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: joinPointer(ctx.path, 'type'),
        message: `Type narrowed from [${[...oldTypes].join(', ')}] to [${[...newTypes].join(', ')}].`,
        before: [...oldTypes],
        after: [...newTypes]
      });
    } else if (addedTypes.length > 0) {
      ctx.changes.push({
        id: 'SCHEMA_TYPE_WIDENED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'BREAKING',
        path: joinPointer(ctx.path, 'type'),
        message: `Type widened from [${[...oldTypes].join(', ')}] to [${[...newTypes].join(', ')}].`,
        before: [...oldTypes],
        after: [...newTypes]
      });
    }
  } else if (oldTypes === null && newTypes !== null) {
    const hadCombinator =
      Array.isArray(oldSchema['oneOf']) ||
      Array.isArray(oldSchema['anyOf']) ||
      hasOwn(oldSchema, 'enum') ||
      hasOwn(oldSchema, 'const');
    if (!hadCombinator) {
      ctx.changes.push({
        id: 'SCHEMA_TYPE_NARROWED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: joinPointer(ctx.path, 'type'),
        message: `Type constraint added: [${[...newTypes].join(', ')}].`,
        before: undefined,
        after: [...newTypes]
      });
    }
  } else if (oldTypes !== null && newTypes === null) {
    const hasNewCombinator =
      Array.isArray(newSchema['oneOf']) ||
      Array.isArray(newSchema['anyOf']) ||
      hasOwn(newSchema, 'enum') ||
      hasOwn(newSchema, 'const');
    if (!hasNewCombinator) {
      ctx.changes.push({
        id: 'SCHEMA_TYPE_WIDENED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: joinPointer(ctx.path, 'type'),
        message: `Type constraint [${[...oldTypes].join(', ')}] removed.`,
        before: [...oldTypes],
        after: undefined
      });
    }
  }

  // 6. Const comparison
  const oldHasConst = hasOwn(oldSchema, 'const');
  const newHasConst = hasOwn(newSchema, 'const');
  if (oldHasConst && newHasConst) {
    if (!deepEqual(oldSchema['const'], newSchema['const'])) {
      ctx.changes.push({
        id: 'SCHEMA_CONST_CHANGED',
        severity: 'BREAKING',
        path: joinPointer(ctx.path, 'const'),
        message: `Const value changed from ${JSON.stringify(oldSchema['const'])} to ${JSON.stringify(newSchema['const'])}.`,
        before: oldSchema['const'],
        after: newSchema['const']
      });
    }
  } else if (!oldHasConst && newHasConst) {
    ctx.changes.push({
      id: 'SCHEMA_CONST_ADDED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, 'const'),
      message: `Const constraint (${JSON.stringify(newSchema['const'])}) added.`,
      before: undefined,
      after: newSchema['const']
    });
  } else if (oldHasConst && !newHasConst) {
    ctx.changes.push({
      id: 'SCHEMA_CONST_REMOVED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, 'const'),
      message: `Const constraint (${JSON.stringify(oldSchema['const'])}) removed.`,
      before: oldSchema['const'],
      after: undefined
    });
  }

  // 7. Enum comparison
  const oldEnum = Array.isArray(oldSchema['enum']) ? (oldSchema['enum'] as unknown[]) : null;
  const newEnum = Array.isArray(newSchema['enum']) ? (newSchema['enum'] as unknown[]) : null;

  if (oldEnum !== null && newEnum !== null) {
    const oldMap = createNullRecord<unknown>();
    for (const v of oldEnum) {
      oldMap[canonicalJsonString(v)] = v;
    }
    const newMap = createNullRecord<unknown>();
    for (const v of newEnum) {
      newMap[canonicalJsonString(v)] = v;
    }

    for (const key of Object.keys(oldMap)) {
      if (!hasOwn(newMap, key)) {
        ctx.changes.push({
          id: 'SCHEMA_ENUM_VALUE_REMOVED',
          severity: 'BREAKING',
          path: joinPointer(ctx.path, 'enum'),
          message: `Removed enum value ${JSON.stringify(oldMap[key])}.`,
          before: oldMap[key]
        });
      }
    }

    for (const key of Object.keys(newMap)) {
      if (!hasOwn(oldMap, key)) {
        ctx.changes.push({
          id: 'SCHEMA_ENUM_VALUE_ADDED',
          severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
          path: joinPointer(ctx.path, 'enum'),
          message: `Added enum value ${JSON.stringify(newMap[key])}.`,
          after: newMap[key]
        });
      }
    }
  } else if (oldEnum === null && newEnum !== null) {
    ctx.changes.push({
      id: 'SCHEMA_ENUM_ADDED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, 'enum'),
      message: `Enum restriction added with ${newEnum.length} value(s).`,
      after: newEnum
    });
  } else if (oldEnum !== null && newEnum === null && !newHasConst) {
    ctx.changes.push({
      id: 'SCHEMA_ENUM_REMOVED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, 'enum'),
      message: 'Enum restriction removed.',
      before: oldEnum
    });
  }

  // 8. Numeric, string, and array bounds
  diffNonNegativeFloor('minLength', oldSchema, newSchema, nextCtxBase);
  diffCeilingBound('maxLength', oldSchema, newSchema, nextCtxBase);
  diffNonNegativeFloor('minItems', oldSchema, newSchema, nextCtxBase);
  diffCeilingBound('maxItems', oldSchema, newSchema, nextCtxBase);
  diffNonNegativeFloor('minProperties', oldSchema, newSchema, nextCtxBase);
  diffCeilingBound('maxProperties', oldSchema, newSchema, nextCtxBase);

  const oldMin = extractMinBound(oldSchema);
  const newMin = extractMinBound(newSchema);
  const minDiff = compareMinBounds(oldMin, newMin);
  if (minDiff === 'tightened') {
    const keyword = typeof newSchema['exclusiveMinimum'] === 'number' ? 'exclusiveMinimum' : 'minimum';
    ctx.changes.push({
      id: 'SCHEMA_BOUND_TIGHTENED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, keyword),
      message: `Minimum bound tightened from ${oldMin ? `${oldMin.exclusive ? '>' : '>='}${oldMin.value}` : 'unbounded'} to ${newMin!.exclusive ? '>' : '>='}${newMin!.value}.`,
      before: oldMin?.value,
      after: newMin?.value
    });
  } else if (minDiff === 'loosened') {
    const keyword = typeof oldSchema['exclusiveMinimum'] === 'number' ? 'exclusiveMinimum' : 'minimum';
    ctx.changes.push({
      id: 'SCHEMA_BOUND_LOOSENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, keyword),
      message: `Minimum bound loosened from ${oldMin!.exclusive ? '>' : '>='}${oldMin!.value} to ${newMin ? `${newMin.exclusive ? '>' : '>='}${newMin.value}` : 'unbounded'}.`,
      before: oldMin?.value,
      after: newMin?.value
    });
  }

  const oldMax = extractMaxBound(oldSchema);
  const newMax = extractMaxBound(newSchema);
  const maxDiff = compareMaxBounds(oldMax, newMax);
  if (maxDiff === 'tightened') {
    const keyword = typeof newSchema['exclusiveMaximum'] === 'number' ? 'exclusiveMaximum' : 'maximum';
    ctx.changes.push({
      id: 'SCHEMA_BOUND_TIGHTENED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, keyword),
      message: `Maximum bound tightened from ${oldMax ? `${oldMax.exclusive ? '<' : '<='}${oldMax.value}` : 'unbounded'} to ${newMax!.exclusive ? '<' : '<='}${newMax!.value}.`,
      before: oldMax?.value,
      after: newMax?.value
    });
  } else if (maxDiff === 'loosened') {
    const keyword = typeof oldSchema['exclusiveMaximum'] === 'number' ? 'exclusiveMaximum' : 'maximum';
    ctx.changes.push({
      id: 'SCHEMA_BOUND_LOOSENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, keyword),
      message: `Maximum bound loosened from ${oldMax!.exclusive ? '<' : '<='}${oldMax!.value} to ${newMax ? `${newMax.exclusive ? '<' : '<='}${newMax.value}` : 'unbounded'}.`,
      before: oldMax?.value,
      after: newMax?.value
    });
  }

  // Pattern
  const oldPattern = typeof oldSchema['pattern'] === 'string' ? oldSchema['pattern'] : undefined;
  const newPattern = typeof newSchema['pattern'] === 'string' ? newSchema['pattern'] : undefined;
  if (oldPattern !== newPattern) {
    if (oldPattern === undefined && newPattern !== undefined) {
      ctx.changes.push({
        id: 'SCHEMA_PATTERN_ADDED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: joinPointer(ctx.path, 'pattern'),
        message: `Regex pattern "${newPattern}" added.`,
        after: newPattern
      });
    } else if (oldPattern !== undefined && newPattern === undefined) {
      ctx.changes.push({
        id: 'SCHEMA_PATTERN_REMOVED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: joinPointer(ctx.path, 'pattern'),
        message: `Regex pattern "${oldPattern}" removed.`,
        before: oldPattern
      });
    } else {
      ctx.changes.push({
        id: 'SCHEMA_PATTERN_CHANGED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'DANGEROUS',
        path: joinPointer(ctx.path, 'pattern'),
        message: `Regex pattern changed from "${oldPattern}" to "${newPattern}".`,
        before: oldPattern,
        after: newPattern
      });
    }
  }

  // uniqueItems
  const oldUnique = oldSchema['uniqueItems'] === true;
  const newUnique = newSchema['uniqueItems'] === true;
  if (!oldUnique && newUnique) {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_TIGHTENED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, 'uniqueItems'),
      message: 'uniqueItems tightened from false to true.',
      before: false,
      after: true
    });
  } else if (oldUnique && !newUnique) {
    ctx.changes.push({
      id: 'SCHEMA_BOUND_LOOSENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, 'uniqueItems'),
      message: 'uniqueItems loosened from true to false.',
      before: true,
      after: false
    });
  }

  // multipleOf
  const oldMult = typeof oldSchema['multipleOf'] === 'number' ? (oldSchema['multipleOf'] as number) : undefined;
  const newMult = typeof newSchema['multipleOf'] === 'number' ? (newSchema['multipleOf'] as number) : undefined;
  if (oldMult !== newMult) {
    if (oldMult === undefined && newMult !== undefined) {
      ctx.changes.push({
        id: 'SCHEMA_BOUND_TIGHTENED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: joinPointer(ctx.path, 'multipleOf'),
        message: `multipleOf (${newMult}) added.`,
        after: newMult
      });
    } else if (oldMult !== undefined && newMult === undefined) {
      ctx.changes.push({
        id: 'SCHEMA_BOUND_LOOSENED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: joinPointer(ctx.path, 'multipleOf'),
        message: `multipleOf (${oldMult}) removed.`,
        before: oldMult
      });
    } else if (oldMult !== undefined && newMult !== undefined) {
      const widened = newMult > 0 && oldMult % newMult === 0;
      ctx.changes.push({
        id: widened ? 'SCHEMA_BOUND_LOOSENED' : 'SCHEMA_BOUND_TIGHTENED',
        severity: widened
          ? isRequestLike(ctx.direction)
            ? 'NON_BREAKING'
            : 'DANGEROUS'
          : isRequestLike(ctx.direction)
            ? 'BREAKING'
            : 'DANGEROUS',
        path: joinPointer(ctx.path, 'multipleOf'),
        message: `multipleOf changed from ${oldMult} to ${newMult}.`,
        before: oldMult,
        after: newMult
      });
    }
  }

  // 9. Object properties & required
  const oldProps = createNullRecord<unknown>();
  if (isObjectRecord(oldSchema['properties'])) {
    const rawP = oldSchema['properties'];
    for (const k of Object.keys(rawP)) {
      if (hasOwn(rawP, k)) oldProps[k] = rawP[k];
    }
  }

  const newProps = createNullRecord<unknown>();
  if (isObjectRecord(newSchema['properties'])) {
    const rawP = newSchema['properties'];
    for (const k of Object.keys(rawP)) {
      if (hasOwn(rawP, k)) newProps[k] = rawP[k];
    }
  }

  const oldReq = new Set<string>(
    Array.isArray(oldSchema['required'])
      ? (oldSchema['required'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  );
  const newReq = new Set<string>(
    Array.isArray(newSchema['required'])
      ? (newSchema['required'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : []
  );

  // Removed properties
  for (const propName of Object.keys(oldProps)) {
    if (!hasOwn(newProps, propName)) {
      ctx.changes.push({
        id: 'SCHEMA_PROPERTY_REMOVED',
        severity: 'BREAKING',
        path: joinPointer(joinPointer(ctx.path, 'properties'), propName),
        message: `Removed property "${propName}".`,
        before: oldProps[propName]
      });
    }
  }

  // Added properties
  for (const propName of Object.keys(newProps)) {
    if (!hasOwn(oldProps, propName)) {
      const propPath = joinPointer(joinPointer(ctx.path, 'properties'), propName);
      const isRequired = newReq.has(propName);
      const resolvedProp = resolveSchemaNode(
        newProps[propName],
        ctx.newRoot,
        newRes.activeRefs,
        ctx.depth + 1
      ).value;
      const hasDefault = isObjectRecord(resolvedProp) && hasOwn(resolvedProp, 'default');

      if (isRequestLike(ctx.direction)) {
        if (isRequired && !hasDefault) {
          ctx.changes.push({
            id: 'SCHEMA_REQUIRED_PROPERTY_ADDED',
            severity: 'BREAKING',
            path: propPath,
            message: `Added required property "${propName}" without a default value.`,
            after: resolvedProp
          });
        } else if (isRequired && hasDefault) {
          ctx.changes.push({
            id: 'SCHEMA_REQUIRED_WITH_DEFAULT_ADDED',
            severity: 'DANGEROUS',
            path: propPath,
            message: `Added required property "${propName}" with default value ${JSON.stringify(resolvedProp['default'])}.`,
            after: resolvedProp
          });
        } else if (!isRequired && hasDefault) {
          ctx.changes.push({
            id: 'SCHEMA_OPTIONAL_WITH_DEFAULT_ADDED',
            severity: 'NON_BREAKING',
            path: propPath,
            message: `Added optional property "${propName}" with default value ${JSON.stringify(resolvedProp['default'])}.`,
            after: resolvedProp
          });
        } else {
          ctx.changes.push({
            id: 'SCHEMA_OPTIONAL_PROPERTY_ADDED',
            severity: 'DANGEROUS',
            path: propPath,
            message: `Added optional property "${propName}" without default.`,
            after: resolvedProp
          });
        }
      } else {
        // Response direction
        if (isRequired) {
          ctx.changes.push({
            id: 'SCHEMA_RESPONSE_REQUIRED_PROPERTY_ADDED',
            severity: 'NON_BREAKING',
            path: propPath,
            message: `Added required response property "${propName}".`,
            after: resolvedProp
          });
        } else {
          ctx.changes.push({
            id: 'SCHEMA_OPTIONAL_PROPERTY_ADDED',
            severity: 'DANGEROUS',
            path: propPath,
            message: `Added optional response property "${propName}".`,
            after: resolvedProp
          });
        }
      }
    }
  }

  // Existing properties: required transition + recursive diff
  for (const propName of Object.keys(oldProps)) {
    if (!hasOwn(newProps, propName)) continue;

    const propPath = joinPointer(joinPointer(ctx.path, 'properties'), propName);
    const wasReq = oldReq.has(propName);
    const isReq = newReq.has(propName);

    if (!wasReq && isReq) {
      const resolvedProp = resolveSchemaNode(
        newProps[propName],
        ctx.newRoot,
        newRes.activeRefs,
        ctx.depth + 1
      ).value;
      const hasDefault = isObjectRecord(resolvedProp) && hasOwn(resolvedProp, 'default');

      if (isRequestLike(ctx.direction)) {
        ctx.changes.push({
          id: 'SCHEMA_REQUIRED_ADDED',
          severity: hasDefault ? 'DANGEROUS' : 'BREAKING',
          path: propPath,
          message: hasDefault
            ? `Property "${propName}" changed from optional to required (has default).`
            : `Property "${propName}" changed from optional to required without default.`,
          before: false,
          after: true
        });
      } else {
        ctx.changes.push({
          id: 'SCHEMA_RESPONSE_REQUIRED_ADDED',
          severity: 'NON_BREAKING',
          path: propPath,
          message: `Response property "${propName}" is now always required.`,
          before: false,
          after: true
        });
      }
    } else if (wasReq && !isReq) {
      ctx.changes.push({
        id: isRequestLike(ctx.direction)
          ? 'SCHEMA_REQUIRED_REMOVED'
          : 'SCHEMA_RESPONSE_REQUIRED_REMOVED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'BREAKING',
        path: propPath,
        message: isRequestLike(ctx.direction)
          ? `Property "${propName}" changed from required to optional.`
          : `Response property "${propName}" changed from required to optional.`,
        before: true,
        after: false
      });
    }

    diffSchemaNodes(oldProps[propName], newProps[propName], {
      ...nextCtxBase,
      path: propPath,
      depth: ctx.depth + 1
    });
  }

  // Required keys not declared in properties
  for (const reqKey of newReq) {
    if (!oldReq.has(reqKey) && !hasOwn(newProps, reqKey)) {
      ctx.changes.push({
        id: 'SCHEMA_REQUIRED_ADDED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: `${joinPointer(ctx.path, 'required')}/${encodePointerSegment(reqKey)}`,
        message: `Added required property "${reqKey}".`,
        after: reqKey
      });
    }
  }
  for (const reqKey of oldReq) {
    if (!newReq.has(reqKey) && !hasOwn(oldProps, reqKey)) {
      ctx.changes.push({
        id: isRequestLike(ctx.direction)
          ? 'SCHEMA_REQUIRED_REMOVED'
          : 'SCHEMA_RESPONSE_REQUIRED_REMOVED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'BREAKING',
        path: `${joinPointer(ctx.path, 'required')}/${encodePointerSegment(reqKey)}`,
        message: `Removed "${reqKey}" from required list.`,
        before: reqKey
      });
    }
  }

  // 10. additionalProperties
  const oldAdd = hasOwn(oldSchema, 'additionalProperties')
    ? oldSchema['additionalProperties']
    : undefined;
  const newAdd = hasOwn(newSchema, 'additionalProperties')
    ? newSchema['additionalProperties']
    : undefined;

  const oldIsOpenOrSchema = oldAdd === undefined || oldAdd === true || isObjectRecord(oldAdd);
  if (oldIsOpenOrSchema && newAdd === false) {
    ctx.changes.push({
      id: 'SCHEMA_ADDITIONAL_PROPS_RESTRICTED',
      severity: 'BREAKING',
      path: joinPointer(ctx.path, 'additionalProperties'),
      message: `additionalProperties changed from ${oldAdd === undefined ? 'open (default)' : oldAdd === true ? 'true' : 'schema'} to false.`,
      before: oldAdd ?? true,
      after: false
    });
  } else if ((oldAdd === undefined || oldAdd === true) && isObjectRecord(newAdd)) {
    ctx.changes.push({
      id: 'SCHEMA_ADDITIONAL_PROPS_CONSTRAINED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, 'additionalProperties'),
      message: 'additionalProperties restricted from open/true to typed schema.',
      before: oldAdd ?? true,
      after: newAdd
    });
  } else if (oldAdd === false && (newAdd === undefined || newAdd === true || isObjectRecord(newAdd))) {
    ctx.changes.push({
      id: 'SCHEMA_ADDITIONAL_PROPS_OPENED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, 'additionalProperties'),
      message: 'additionalProperties loosened from false.',
      before: false,
      after: newAdd ?? true
    });
  } else if (isObjectRecord(oldAdd) && isObjectRecord(newAdd)) {
    diffSchemaNodes(oldAdd, newAdd, {
      ...nextCtxBase,
      path: joinPointer(ctx.path, 'additionalProperties'),
      depth: ctx.depth + 1
    });
  }

  // 11. Array items & prefixItems
  if (hasOwn(oldSchema, 'items') && hasOwn(newSchema, 'items')) {
    const oldItems = oldSchema['items'];
    const newItems = newSchema['items'];
    if (Array.isArray(oldItems) && Array.isArray(newItems)) {
      const len = Math.min(oldItems.length, newItems.length);
      for (let i = 0; i < len; i++) {
        diffSchemaNodes(oldItems[i], newItems[i], {
          ...nextCtxBase,
          path: joinPointer(joinPointer(ctx.path, 'items'), i),
          depth: ctx.depth + 1
        });
      }
      if (newItems.length < oldItems.length) {
        ctx.changes.push({
          id: 'SCHEMA_TUPLE_ITEMS_REMOVED',
          severity: 'BREAKING',
          path: joinPointer(ctx.path, 'items'),
          message: `Tuple items shortened from ${oldItems.length} to ${newItems.length}.`,
          before: oldItems.length,
          after: newItems.length
        });
      }
    } else if (!Array.isArray(oldItems) && !Array.isArray(newItems)) {
      diffSchemaNodes(oldItems, newItems, {
        ...nextCtxBase,
        path: joinPointer(ctx.path, 'items'),
        depth: ctx.depth + 1
      });
    }
  } else if (!hasOwn(oldSchema, 'items') && hasOwn(newSchema, 'items')) {
    ctx.changes.push({
      id: 'SCHEMA_ITEMS_CONSTRAINED',
      severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
      path: joinPointer(ctx.path, 'items'),
      message: 'Array items constraint added.',
      after: newSchema['items']
    });
  } else if (hasOwn(oldSchema, 'items') && !hasOwn(newSchema, 'items')) {
    ctx.changes.push({
      id: 'SCHEMA_ITEMS_UNCONSTRAINED',
      severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
      path: joinPointer(ctx.path, 'items'),
      message: 'Array items constraint removed.',
      before: oldSchema['items']
    });
  }

  if (Array.isArray(oldSchema['prefixItems']) && Array.isArray(newSchema['prefixItems'])) {
    const oldPrefix = oldSchema['prefixItems'] as unknown[];
    const newPrefix = newSchema['prefixItems'] as unknown[];
    const len = Math.min(oldPrefix.length, newPrefix.length);
    for (let i = 0; i < len; i++) {
      diffSchemaNodes(oldPrefix[i], newPrefix[i], {
        ...nextCtxBase,
        path: joinPointer(joinPointer(ctx.path, 'prefixItems'), i),
        depth: ctx.depth + 1
      });
    }
  }

  // 12. Union combinators (oneOf / anyOf)
  for (const unionKey of ['oneOf', 'anyOf'] as const) {
    const oldU = Array.isArray(oldSchema[unionKey]) ? (oldSchema[unionKey] as unknown[]) : null;
    const newU = Array.isArray(newSchema[unionKey]) ? (newSchema[unionKey] as unknown[]) : null;
    if (oldU !== null && newU !== null) {
      diffUnionKeyword(unionKey, oldU, newU, nextCtxBase);
    } else if (oldU === null && newU !== null) {
      ctx.changes.push({
        id: 'SCHEMA_UNION_ADDED',
        severity: isRequestLike(ctx.direction) ? 'BREAKING' : 'NON_BREAKING',
        path: joinPointer(ctx.path, unionKey),
        message: `${unionKey} constraint added with ${newU.length} variant(s).`,
        after: newU
      });
    } else if (oldU !== null && newU === null) {
      ctx.changes.push({
        id: 'SCHEMA_UNION_REMOVED',
        severity: isRequestLike(ctx.direction) ? 'NON_BREAKING' : 'DANGEROUS',
        path: joinPointer(ctx.path, unionKey),
        message: `${unionKey} constraint removed.`,
        before: oldU
      });
    }
  }
}
