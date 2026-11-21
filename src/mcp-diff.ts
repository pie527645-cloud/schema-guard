import { joinPointer } from './ref-resolver.js';
import { diffSchemaNodes } from './schema-diff.js';
import {
  compareStringsLex,
  createNullRecord,
  hasOwn,
  isObjectRecord
} from './safe-object.js';
import { type ChangeItem, type McpToolDefinition, SchemaGuardError } from './types.js';

export function extractMcpTools(doc: unknown): McpToolDefinition[] {
  let rawTools: unknown[];
  if (Array.isArray(doc)) {
    rawTools = doc;
  } else if (isObjectRecord(doc) && Array.isArray(doc['tools'])) {
    rawTools = doc['tools'];
  } else if (
    isObjectRecord(doc) &&
    isObjectRecord(doc['result']) &&
    Array.isArray(doc['result']['tools'])
  ) {
    rawTools = doc['result']['tools'] as unknown[];
  } else {
    throw new SchemaGuardError(
      'PARSE_ERROR',
      'Invalid MCP tools contract: expected { tools: [...] } or an array of tool definitions.'
    );
  }

  return rawTools.map((item, idx) => {
    if (!isObjectRecord(item) || typeof item['name'] !== 'string' || item['name'].trim() === '') {
      throw new SchemaGuardError(
        'PARSE_ERROR',
        `Invalid MCP tool at index ${idx}: missing non-empty string "name".`
      );
    }
    return item as McpToolDefinition;
  });
}

export function diffMcpSpecs(oldDoc: unknown, newDoc: unknown): ChangeItem[] {
  const oldList = extractMcpTools(oldDoc);
  const newList = extractMcpTools(newDoc);

  const oldMap = createNullRecord<McpToolDefinition>();
  for (const tool of oldList) {
    oldMap[tool.name] = tool;
  }

  const newMap = createNullRecord<McpToolDefinition>();
  for (const tool of newList) {
    newMap[tool.name] = tool;
  }

  const changes: ChangeItem[] = [];
  const allNames = Array.from(new Set([...Object.keys(oldMap), ...Object.keys(newMap)])).sort(
    compareStringsLex
  );

  for (const name of allNames) {
    const toolPath = joinPointer('#/tools', name);
    const hasOld = hasOwn(oldMap, name);
    const hasNew = hasOwn(newMap, name);

    if (hasOld && !hasNew) {
      changes.push({
        id: 'MCP_TOOL_REMOVED',
        severity: 'BREAKING',
        path: toolPath,
        message: `Removed MCP tool "${name}".`,
        before: oldMap[name]
      });
      continue;
    }

    if (!hasOld && hasNew) {
      changes.push({
        id: 'MCP_TOOL_ADDED',
        severity: 'NON_BREAKING',
        path: toolPath,
        message: `Added MCP tool "${name}".`,
        after: newMap[name]
      });
      continue;
    }

    const oldTool = oldMap[name]!;
    const newTool = newMap[name]!;

    // Tool-level description change
    const oldDesc = typeof oldTool.description === 'string' ? oldTool.description : undefined;
    const newDesc = typeof newTool.description === 'string' ? newTool.description : undefined;
    if (oldDesc !== newDesc && (oldDesc !== undefined || newDesc !== undefined)) {
      changes.push({
        id: 'DESCRIPTION_CHANGED',
        severity: 'NON_BREAKING',
        path: joinPointer(toolPath, 'description'),
        message: `Updated description for MCP tool "${name}".`,
        before: oldDesc,
        after: newDesc
      });
    }

    // Tool annotations/deprecation
    const oldDepr =
      oldTool['deprecated'] === true ||
      (isObjectRecord(oldTool.annotations) && oldTool.annotations['deprecated'] === true);
    const newDepr =
      newTool['deprecated'] === true ||
      (isObjectRecord(newTool.annotations) && newTool.annotations['deprecated'] === true);
    if (!oldDepr && newDepr) {
      changes.push({
        id: 'MCP_TOOL_DEPRECATED',
        severity: 'DANGEROUS',
        path: joinPointer(toolPath, 'deprecated'),
        message: `MCP tool "${name}" marked deprecated.`,
        before: false,
        after: true
      });
    }

    // Diff inputSchema (request direction)
    const oldInput = hasOwn(oldTool, 'inputSchema') ? oldTool.inputSchema : { type: 'object' };
    const newInput = hasOwn(newTool, 'inputSchema') ? newTool.inputSchema : { type: 'object' };

    diffSchemaNodes(oldInput, newInput, {
      oldRoot: isObjectRecord(oldInput) ? oldInput : oldDoc,
      newRoot: isObjectRecord(newInput) ? newInput : newDoc,
      direction: 'request',
      path: joinPointer(toolPath, 'inputSchema'),
      depth: 1,
      oldActiveRefs: new Set<string>(),
      newActiveRefs: new Set<string>(),
      changes
    });

    // Diff optional outputSchema (response direction)
    const oldHasOutput = hasOwn(oldTool, 'outputSchema') && oldTool.outputSchema !== undefined;
    const newHasOutput = hasOwn(newTool, 'outputSchema') && newTool.outputSchema !== undefined;
    if (oldHasOutput && newHasOutput) {
      const oldOut = oldTool.outputSchema;
      const newOut = newTool.outputSchema;
      diffSchemaNodes(oldOut, newOut, {
        oldRoot: isObjectRecord(oldOut) ? oldOut : oldDoc,
        newRoot: isObjectRecord(newOut) ? newOut : newDoc,
        direction: 'response',
        path: joinPointer(toolPath, 'outputSchema'),
        depth: 1,
        oldActiveRefs: new Set<string>(),
        newActiveRefs: new Set<string>(),
        changes
      });
    } else if (oldHasOutput && !newHasOutput) {
      changes.push({
        id: 'MCP_OUTPUT_SCHEMA_REMOVED',
        severity: 'DANGEROUS',
        path: joinPointer(toolPath, 'outputSchema'),
        message: `Output schema removed from MCP tool "${name}".`,
        before: oldTool.outputSchema
      });
    } else if (!oldHasOutput && newHasOutput) {
      changes.push({
        id: 'MCP_OUTPUT_SCHEMA_ADDED',
        severity: 'NON_BREAKING',
        path: joinPointer(toolPath, 'outputSchema'),
        message: `Output schema added to MCP tool "${name}".`,
        after: newTool.outputSchema
      });
    }
  }

  return changes;
}
