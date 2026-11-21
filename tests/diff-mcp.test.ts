import assert from 'node:assert/strict';
import test from 'node:test';
import { diffContents } from '../src/index.js';

test('MCP tools/list: detects removed tool as BREAKING and added tool as NON_BREAKING', () => {
  const oldSpec = JSON.stringify({
    tools: [
      {
        name: 'read_file',
        description: 'Read file contents',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      },
      {
        name: 'delete_file',
        description: 'Delete a file',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path']
        }
      }
    ]
  });

  const newSpec = JSON.stringify({
    tools: [
      {
        name: 'read_file',
        description: 'Read UTF-8 file contents from disk',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            encoding: { type: 'string', default: 'utf-8' }
          },
          required: ['path']
        }
      },
      {
        name: 'list_dir',
        description: 'List directory entries',
        inputSchema: {
          type: 'object',
          properties: {
            dir: { type: 'string' }
          }
        }
      }
    ]
  });

  const report = diffContents(oldSpec, newSpec);
  assert.equal(report.format, 'mcp-tools');
  assert.equal(report.hasBreaking, true);
  assert.equal(report.summary.breaking, 1);
  assert.equal(report.summary.dangerous, 0);
  assert.equal(report.summary.nonBreaking, 3);

  const removed = report.changes.find((c) => c.id === 'MCP_TOOL_REMOVED');
  assert.ok(removed);
  assert.equal(removed.severity, 'BREAKING');
  assert.equal(removed.path, '#/tools/delete_file');

  const added = report.changes.find((c) => c.id === 'MCP_TOOL_ADDED');
  assert.ok(added);
  assert.equal(added.severity, 'NON_BREAKING');
  assert.equal(added.path, '#/tools/list_dir');

  const optWithDefault = report.changes.find((c) => c.id === 'SCHEMA_OPTIONAL_WITH_DEFAULT_ADDED');
  assert.ok(optWithDefault);
  assert.equal(optWithDefault.severity, 'NON_BREAKING');
});

test('MCP raw tool array: detects added required input property without default as BREAKING and optional without default as DANGEROUS', () => {
  const oldSpec = JSON.stringify([
    {
      name: 'search_docs',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 200 }
        },
        required: ['query']
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'partial'] },
          total: { type: 'integer' }
        },
        required: ['status', 'total']
      }
    }
  ]);

  const newSpec = JSON.stringify([
    {
      name: 'search_docs',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 100 },
          tenantId: { type: 'string' },
          cursor: { type: 'string' }
        },
        required: ['query', 'tenantId']
      },
      outputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'partial', 'rate_limited'] }
        },
        required: ['status']
      }
    }
  ]);

  const report = diffContents(oldSpec, newSpec);
  assert.equal(report.format, 'mcp-tools');

  const breakingIds = report.changes.filter((c) => c.severity === 'BREAKING').map((c) => c.id);
  assert.ok(breakingIds.includes('SCHEMA_BOUND_TIGHTENED'));
  assert.ok(breakingIds.includes('SCHEMA_REQUIRED_PROPERTY_ADDED'));
  assert.ok(breakingIds.includes('SCHEMA_PROPERTY_REMOVED'));

  const dangerousIds = report.changes.filter((c) => c.severity === 'DANGEROUS').map((c) => c.id);
  assert.ok(dangerousIds.includes('SCHEMA_OPTIONAL_PROPERTY_ADDED'));
  assert.ok(dangerousIds.includes('SCHEMA_ENUM_VALUE_ADDED'));
});

test('MCP tools/list: detects optional-to-required transition as BREAKING and tool deprecation as DANGEROUS', () => {
  const oldSpec = JSON.stringify({
    tools: [
      {
        name: 'run_query',
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            timeoutMs: { type: 'integer' }
          },
          required: ['sql']
        }
      }
    ]
  });

  const newSpec = JSON.stringify({
    tools: [
      {
        name: 'run_query',
        annotations: { deprecated: true },
        inputSchema: {
          type: 'object',
          properties: {
            sql: { type: 'string' },
            timeoutMs: { type: 'integer' }
          },
          required: ['sql', 'timeoutMs']
        }
      }
    ]
  });

  const report = diffContents(oldSpec, newSpec);
  assert.equal(report.summary.breaking, 1);
  assert.equal(report.summary.dangerous, 1);
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_REQUIRED_ADDED' && c.severity === 'BREAKING'));
  assert.ok(report.changes.some((c) => c.id === 'MCP_TOOL_DEPRECATED' && c.severity === 'DANGEROUS'));
});
