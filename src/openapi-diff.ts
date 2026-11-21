import { joinPointer, resolveSchemaNode } from './ref-resolver.js';
import { diffSchemaNodes } from './schema-diff.js';
import {
  compareStringsLex,
  createNullRecord,
  hasOwn,
  isObjectRecord
} from './safe-object.js';
import { type ChangeItem, SchemaGuardError } from './types.js';

const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace'
] as const;

interface ResolvedParameter {
  key: string;
  name: string;
  location: string;
  required: boolean;
  deprecated: boolean;
  description?: string;
  schema: unknown;
  activeRefs: ReadonlySet<string>;
}

function collectOperationParameters(
  pathItem: Record<string, unknown>,
  operation: Record<string, unknown>,
  rootDoc: unknown
): Record<string, ResolvedParameter> {
  const map = createNullRecord<ResolvedParameter>();

  const sources: unknown[] = [];
  if (Array.isArray(pathItem['parameters'])) {
    sources.push(...(pathItem['parameters'] as unknown[]));
  }
  if (Array.isArray(operation['parameters'])) {
    sources.push(...(operation['parameters'] as unknown[]));
  }

  for (const rawParam of sources) {
    const resolved = resolveSchemaNode(rawParam, rootDoc, new Set<string>(), 1);
    if (!isObjectRecord(resolved.value)) continue;
    const paramObj = resolved.value;
    const name = typeof paramObj['name'] === 'string' ? paramObj['name'] : '';
    const location = typeof paramObj['in'] === 'string' ? paramObj['in'] : 'query';
    if (!name) continue;

    const key = `${location}:${name}`;
    const required = location === 'path' ? true : paramObj['required'] === true;
    const deprecated = paramObj['deprecated'] === true;
    const description =
      typeof paramObj['description'] === 'string' ? paramObj['description'] : undefined;
    const schema = hasOwn(paramObj, 'schema') ? paramObj['schema'] : {};

    // Operation-level parameters override path-level parameters with the same in+name
    map[key] = {
      key,
      name,
      location,
      required,
      deprecated,
      description,
      schema,
      activeRefs: resolved.activeRefs
    };
  }

  return map;
}

function hasDefaultInSchema(
  schema: unknown,
  rootDoc: unknown,
  activeRefs: ReadonlySet<string>
): boolean {
  const res = resolveSchemaNode(schema, rootDoc, activeRefs, 2);
  return isObjectRecord(res.value) && hasOwn(res.value, 'default');
}

function diffParameters(
  oldParams: Record<string, ResolvedParameter>,
  newParams: Record<string, ResolvedParameter>,
  oldRoot: unknown,
  newRoot: unknown,
  opPath: string,
  changes: ChangeItem[]
): void {
  const paramsBase = joinPointer(opPath, 'parameters');
  const keys = Array.from(new Set([...Object.keys(oldParams), ...Object.keys(newParams)])).sort(
    compareStringsLex
  );

  for (const key of keys) {
    const paramPath = joinPointer(paramsBase, key);
    const hasOld = hasOwn(oldParams, key);
    const hasNew = hasOwn(newParams, key);

    if (hasOld && !hasNew) {
      const p = oldParams[key]!;
      changes.push({
        id: 'OAPI_PARAMETER_REMOVED',
        severity: 'BREAKING',
        path: paramPath,
        message: `Removed ${p.location} parameter "${p.name}".`,
        before: { name: p.name, in: p.location, required: p.required }
      });
      continue;
    }

    if (!hasOld && hasNew) {
      const p = newParams[key]!;
      const hasDefault = hasDefaultInSchema(p.schema, newRoot, p.activeRefs);
      if (p.required && !hasDefault) {
        changes.push({
          id: 'OAPI_REQUIRED_PARAMETER_ADDED',
          severity: 'BREAKING',
          path: paramPath,
          message: `Added required ${p.location} parameter "${p.name}" without default.`,
          after: { name: p.name, in: p.location, required: true }
        });
      } else if (p.required && hasDefault) {
        changes.push({
          id: 'OAPI_REQUIRED_PARAMETER_WITH_DEFAULT_ADDED',
          severity: 'DANGEROUS',
          path: paramPath,
          message: `Added required ${p.location} parameter "${p.name}" with default.`,
          after: { name: p.name, in: p.location, required: true }
        });
      } else if (!p.required && hasDefault) {
        changes.push({
          id: 'OAPI_OPTIONAL_PARAMETER_WITH_DEFAULT_ADDED',
          severity: 'NON_BREAKING',
          path: paramPath,
          message: `Added optional ${p.location} parameter "${p.name}" with default.`,
          after: { name: p.name, in: p.location, required: false }
        });
      } else {
        changes.push({
          id: 'OAPI_OPTIONAL_PARAMETER_ADDED',
          severity: 'DANGEROUS',
          path: paramPath,
          message: `Added optional ${p.location} parameter "${p.name}" without default.`,
          after: { name: p.name, in: p.location, required: false }
        });
      }
      continue;
    }

    const oldP = oldParams[key]!;
    const newP = newParams[key]!;

    if (!oldP.required && newP.required) {
      const hasDefault = hasDefaultInSchema(newP.schema, newRoot, newP.activeRefs);
      changes.push({
        id: 'OAPI_PARAMETER_MADE_REQUIRED',
        severity: hasDefault ? 'DANGEROUS' : 'BREAKING',
        path: joinPointer(paramPath, 'required'),
        message: `${newP.location} parameter "${newP.name}" changed from optional to required.`,
        before: false,
        after: true
      });
    } else if (oldP.required && !newP.required) {
      changes.push({
        id: 'OAPI_PARAMETER_MADE_OPTIONAL',
        severity: 'NON_BREAKING',
        path: joinPointer(paramPath, 'required'),
        message: `${newP.location} parameter "${newP.name}" changed from required to optional.`,
        before: true,
        after: false
      });
    }

    if (!oldP.deprecated && newP.deprecated) {
      changes.push({
        id: 'SCHEMA_DEPRECATED_ADDED',
        severity: 'DANGEROUS',
        path: joinPointer(paramPath, 'deprecated'),
        message: `${newP.location} parameter "${newP.name}" marked deprecated.`,
        before: false,
        after: true
      });
    }

    if (
      oldP.description !== newP.description &&
      (oldP.description !== undefined || newP.description !== undefined)
    ) {
      changes.push({
        id: 'DESCRIPTION_CHANGED',
        severity: 'NON_BREAKING',
        path: joinPointer(paramPath, 'description'),
        message: `Updated description of ${newP.location} parameter "${newP.name}".`,
        before: oldP.description,
        after: newP.description
      });
    }

    diffSchemaNodes(oldP.schema, newP.schema, {
      oldRoot,
      newRoot,
      direction: 'request',
      path: joinPointer(paramPath, 'schema'),
      depth: 2,
      oldActiveRefs: oldP.activeRefs,
      newActiveRefs: newP.activeRefs,
      changes
    });
  }
}

function diffMediaTypeContent(
  oldContent: unknown,
  newContent: unknown,
  direction: 'request' | 'response',
  oldRoot: unknown,
  newRoot: unknown,
  oldRefs: ReadonlySet<string>,
  newRefs: ReadonlySet<string>,
  basePath: string,
  changes: ChangeItem[]
): void {
  const oldMap = createNullRecord<unknown>();
  if (isObjectRecord(oldContent)) {
    for (const mt of Object.keys(oldContent)) {
      if (hasOwn(oldContent, mt)) oldMap[mt] = oldContent[mt];
    }
  }
  const newMap = createNullRecord<unknown>();
  if (isObjectRecord(newContent)) {
    for (const mt of Object.keys(newContent)) {
      if (hasOwn(newContent, mt)) newMap[mt] = newContent[mt];
    }
  }

  const mediaTypes = Array.from(new Set([...Object.keys(oldMap), ...Object.keys(newMap)])).sort(
    compareStringsLex
  );

  for (const mt of mediaTypes) {
    const mtPath = joinPointer(basePath, mt);
    const hasOld = hasOwn(oldMap, mt);
    const hasNew = hasOwn(newMap, mt);

    if (hasOld && !hasNew) {
      changes.push({
        id:
          direction === 'request'
            ? 'OAPI_REQUEST_MEDIA_TYPE_REMOVED'
            : 'OAPI_RESPONSE_MEDIA_TYPE_REMOVED',
        severity: 'BREAKING',
        path: mtPath,
        message: `Removed ${direction} media type "${mt}".`,
        before: mt
      });
      continue;
    }

    if (!hasOld && hasNew) {
      changes.push({
        id:
          direction === 'request'
            ? 'OAPI_REQUEST_MEDIA_TYPE_ADDED'
            : 'OAPI_RESPONSE_MEDIA_TYPE_ADDED',
        severity: 'NON_BREAKING',
        path: mtPath,
        message: `Added ${direction} media type "${mt}".`,
        after: mt
      });
      continue;
    }

    const oldMedia = isObjectRecord(oldMap[mt]) ? (oldMap[mt] as Record<string, unknown>) : {};
    const newMedia = isObjectRecord(newMap[mt]) ? (newMap[mt] as Record<string, unknown>) : {};

    if (hasOwn(oldMedia, 'schema') || hasOwn(newMedia, 'schema')) {
      diffSchemaNodes(oldMedia['schema'] ?? {}, newMedia['schema'] ?? {}, {
        oldRoot,
        newRoot,
        direction,
        path: joinPointer(mtPath, 'schema'),
        depth: 3,
        oldActiveRefs: oldRefs,
        newActiveRefs: newRefs,
        changes
      });
    }
  }
}

function diffOperation(
  oldPathItem: Record<string, unknown>,
  newPathItem: Record<string, unknown>,
  oldOp: Record<string, unknown>,
  newOp: Record<string, unknown>,
  oldRoot: unknown,
  newRoot: unknown,
  opPath: string,
  method: string,
  routePath: string,
  changes: ChangeItem[]
): void {
  // Deprecated transition
  if (oldOp['deprecated'] !== true && newOp['deprecated'] === true) {
    changes.push({
      id: 'OAPI_OPERATION_DEPRECATED',
      severity: 'DANGEROUS',
      path: joinPointer(opPath, 'deprecated'),
      message: `Operation ${method.toUpperCase()} ${routePath} marked deprecated.`,
      before: false,
      after: true
    });
  }

  // Summary / description
  for (const descKey of ['summary', 'description'] as const) {
    const oldText = typeof oldOp[descKey] === 'string' ? (oldOp[descKey] as string) : undefined;
    const newText = typeof newOp[descKey] === 'string' ? (newOp[descKey] as string) : undefined;
    if (oldText !== newText && (oldText !== undefined || newText !== undefined)) {
      changes.push({
        id: 'DESCRIPTION_CHANGED',
        severity: 'NON_BREAKING',
        path: joinPointer(opPath, descKey),
        message: `Updated ${descKey} on ${method.toUpperCase()} ${routePath}.`,
        before: oldText,
        after: newText
      });
    }
  }

  // Parameters
  const oldParams = collectOperationParameters(oldPathItem, oldOp, oldRoot);
  const newParams = collectOperationParameters(newPathItem, newOp, newRoot);
  diffParameters(oldParams, newParams, oldRoot, newRoot, opPath, changes);

  // requestBody
  const oldHasBody = hasOwn(oldOp, 'requestBody') && oldOp['requestBody'] !== undefined;
  const newHasBody = hasOwn(newOp, 'requestBody') && newOp['requestBody'] !== undefined;
  const reqBodyPath = joinPointer(opPath, 'requestBody');

  if (oldHasBody && !newHasBody) {
    changes.push({
      id: 'OAPI_REQUEST_BODY_REMOVED',
      severity: 'BREAKING',
      path: reqBodyPath,
      message: `Removed requestBody from ${method.toUpperCase()} ${routePath}.`
    });
  } else if (!oldHasBody && newHasBody) {
    const resolvedNewBody = resolveSchemaNode(newOp['requestBody'], newRoot, new Set<string>(), 2);
    const reqRequired =
      isObjectRecord(resolvedNewBody.value) && resolvedNewBody.value['required'] === true;
    changes.push({
      id: reqRequired ? 'OAPI_REQUEST_BODY_REQUIRED_ADDED' : 'OAPI_REQUEST_BODY_OPTIONAL_ADDED',
      severity: reqRequired ? 'BREAKING' : 'DANGEROUS',
      path: reqBodyPath,
      message: reqRequired
        ? `Added required requestBody to ${method.toUpperCase()} ${routePath}.`
        : `Added optional requestBody to ${method.toUpperCase()} ${routePath}.`
    });
  } else if (oldHasBody && newHasBody) {
    const oldBodyRes = resolveSchemaNode(oldOp['requestBody'], oldRoot, new Set<string>(), 2);
    const newBodyRes = resolveSchemaNode(newOp['requestBody'], newRoot, new Set<string>(), 2);

    if (isObjectRecord(oldBodyRes.value) && isObjectRecord(newBodyRes.value)) {
      const oldReq = oldBodyRes.value['required'] === true;
      const newReq = newBodyRes.value['required'] === true;
      if (!oldReq && newReq) {
        changes.push({
          id: 'OAPI_REQUEST_BODY_MADE_REQUIRED',
          severity: 'BREAKING',
          path: joinPointer(reqBodyPath, 'required'),
          message: `requestBody on ${method.toUpperCase()} ${routePath} changed from optional to required.`,
          before: false,
          after: true
        });
      } else if (oldReq && !newReq) {
        changes.push({
          id: 'OAPI_REQUEST_BODY_MADE_OPTIONAL',
          severity: 'NON_BREAKING',
          path: joinPointer(reqBodyPath, 'required'),
          message: `requestBody on ${method.toUpperCase()} ${routePath} changed from required to optional.`,
          before: true,
          after: false
        });
      }

      diffMediaTypeContent(
        oldBodyRes.value['content'],
        newBodyRes.value['content'],
        'request',
        oldRoot,
        newRoot,
        oldBodyRes.activeRefs,
        newBodyRes.activeRefs,
        joinPointer(reqBodyPath, 'content'),
        changes
      );
    }
  }

  // responses
  const responsesPath = joinPointer(opPath, 'responses');
  const oldRespMap = createNullRecord<unknown>();
  if (isObjectRecord(oldOp['responses'])) {
    const rawR = oldOp['responses'];
    for (const status of Object.keys(rawR)) {
      if (hasOwn(rawR, status)) oldRespMap[status] = rawR[status];
    }
  }
  const newRespMap = createNullRecord<unknown>();
  if (isObjectRecord(newOp['responses'])) {
    const rawR = newOp['responses'];
    for (const status of Object.keys(rawR)) {
      if (hasOwn(rawR, status)) newRespMap[status] = rawR[status];
    }
  }

  const statuses = Array.from(
    new Set([...Object.keys(oldRespMap), ...Object.keys(newRespMap)])
  ).sort(compareStringsLex);

  for (const status of statuses) {
    const statusPath = joinPointer(responsesPath, status);
    const hasOld = hasOwn(oldRespMap, status);
    const hasNew = hasOwn(newRespMap, status);

    if (hasOld && !hasNew) {
      changes.push({
        id: 'OAPI_RESPONSE_REMOVED',
        severity: 'BREAKING',
        path: statusPath,
        message: `Removed response status "${status}" from ${method.toUpperCase()} ${routePath}.`,
        before: status
      });
      continue;
    }

    if (!hasOld && hasNew) {
      changes.push({
        id: 'OAPI_RESPONSE_ADDED',
        severity: 'NON_BREAKING',
        path: statusPath,
        message: `Added response status "${status}" to ${method.toUpperCase()} ${routePath}.`,
        after: status
      });
      continue;
    }

    const oldRespRes = resolveSchemaNode(oldRespMap[status], oldRoot, new Set<string>(), 2);
    const newRespRes = resolveSchemaNode(newRespMap[status], newRoot, new Set<string>(), 2);

    if (isObjectRecord(oldRespRes.value) && isObjectRecord(newRespRes.value)) {
      const oldDesc =
        typeof oldRespRes.value['description'] === 'string'
          ? oldRespRes.value['description']
          : undefined;
      const newDesc =
        typeof newRespRes.value['description'] === 'string'
          ? newRespRes.value['description']
          : undefined;
      if (oldDesc !== newDesc && (oldDesc !== undefined || newDesc !== undefined)) {
        changes.push({
          id: 'DESCRIPTION_CHANGED',
          severity: 'NON_BREAKING',
          path: joinPointer(statusPath, 'description'),
          message: `Updated description for response "${status}" on ${method.toUpperCase()} ${routePath}.`,
          before: oldDesc,
          after: newDesc
        });
      }

      diffMediaTypeContent(
        oldRespRes.value['content'],
        newRespRes.value['content'],
        'response',
        oldRoot,
        newRoot,
        oldRespRes.activeRefs,
        newRespRes.activeRefs,
        joinPointer(statusPath, 'content'),
        changes
      );
    }
  }
}

function diffPathContainer(
  containerKey: 'paths' | 'webhooks',
  oldDoc: Record<string, unknown>,
  newDoc: Record<string, unknown>,
  changes: ChangeItem[]
): void {
  const oldPaths = createNullRecord<unknown>();
  if (isObjectRecord(oldDoc[containerKey])) {
    const raw = oldDoc[containerKey] as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (hasOwn(raw, k)) oldPaths[k] = raw[k];
    }
  }

  const newPaths = createNullRecord<unknown>();
  if (isObjectRecord(newDoc[containerKey])) {
    const raw = newDoc[containerKey] as Record<string, unknown>;
    for (const k of Object.keys(raw)) {
      if (hasOwn(raw, k)) newPaths[k] = raw[k];
    }
  }

  const routeNames = Array.from(new Set([...Object.keys(oldPaths), ...Object.keys(newPaths)])).sort(
    compareStringsLex
  );

  const basePointer = `#/${containerKey}`;

  for (const route of routeNames) {
    const routePointer = joinPointer(basePointer, route);
    const hasOld = hasOwn(oldPaths, route);
    const hasNew = hasOwn(newPaths, route);

    if (hasOld && !hasNew) {
      changes.push({
        id: 'OAPI_PATH_REMOVED',
        severity: 'BREAKING',
        path: routePointer,
        message: `Removed OpenAPI ${containerKey === 'webhooks' ? 'webhook' : 'path'} "${route}".`,
        before: route
      });
      continue;
    }

    if (!hasOld && hasNew) {
      changes.push({
        id: 'OAPI_PATH_ADDED',
        severity: 'NON_BREAKING',
        path: routePointer,
        message: `Added OpenAPI ${containerKey === 'webhooks' ? 'webhook' : 'path'} "${route}".`,
        after: route
      });
      continue;
    }

    const oldItemRes = resolveSchemaNode(oldPaths[route], oldDoc, new Set<string>(), 1);
    const newItemRes = resolveSchemaNode(newPaths[route], newDoc, new Set<string>(), 1);
    if (!isObjectRecord(oldItemRes.value) || !isObjectRecord(newItemRes.value)) {
      continue;
    }

    const oldPathItem = oldItemRes.value;
    const newPathItem = newItemRes.value;

    for (const method of HTTP_METHODS) {
      const hasOldOp = hasOwn(oldPathItem, method) && isObjectRecord(oldPathItem[method]);
      const hasNewOp = hasOwn(newPathItem, method) && isObjectRecord(newPathItem[method]);
      const opPointer = joinPointer(routePointer, method);

      if (hasOldOp && !hasNewOp) {
        changes.push({
          id: 'OAPI_OPERATION_REMOVED',
          severity: 'BREAKING',
          path: opPointer,
          message: `Removed operation ${method.toUpperCase()} ${route}.`,
          before: `${method.toUpperCase()} ${route}`
        });
        continue;
      }

      if (!hasOldOp && hasNewOp) {
        changes.push({
          id: 'OAPI_OPERATION_ADDED',
          severity: 'NON_BREAKING',
          path: opPointer,
          message: `Added operation ${method.toUpperCase()} ${route}.`,
          after: `${method.toUpperCase()} ${route}`
        });
        continue;
      }

      if (hasOldOp && hasNewOp) {
        diffOperation(
          oldPathItem,
          newPathItem,
          oldPathItem[method] as Record<string, unknown>,
          newPathItem[method] as Record<string, unknown>,
          oldDoc,
          newDoc,
          opPointer,
          method,
          route,
          changes
        );
      }
    }
  }
}

export function diffOpenApiSpecs(oldDoc: unknown, newDoc: unknown): ChangeItem[] {
  if (!isObjectRecord(oldDoc) || !isObjectRecord(newDoc)) {
    throw new SchemaGuardError('PARSE_ERROR', 'OpenAPI specifications must be JSON/YAML objects.');
  }

  const changes: ChangeItem[] = [];
  diffPathContainer('paths', oldDoc, newDoc, changes);
  if (hasOwn(oldDoc, 'webhooks') || hasOwn(newDoc, 'webhooks')) {
    diffPathContainer('webhooks', oldDoc, newDoc, changes);
  }
  return changes;
}
