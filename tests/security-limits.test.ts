import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  diffContents,
  loadSpecFromFile,
  MAX_SPEC_BYTES,
  parseSpecContent,
  SchemaGuardError
} from '../src/index.js';

test('Ref resolution: resolves escaped ~1/~0 internal #/$defs pointers with sibling overrides and rejects circular $ref chains', () => {
  const validOld = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { $ref: '#/$defs/v1~1user~0id', description: 'Primary user ID' }
    },
    $defs: {
      'v1/user~id': { type: 'string', maxLength: 64 }
    }
  });

  const validNew = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      id: { $ref: '#/$defs/v1~1user~0id', deprecated: true, description: 'Primary user ID' }
    },
    $defs: {
      'v1/user~id': { type: 'string', maxLength: 32 }
    }
  });

  const report = diffContents(validOld, validNew);
  assert.equal(report.summary.breaking, 1);
  assert.equal(report.summary.dangerous, 1);
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_BOUND_TIGHTENED'));
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_DEPRECATED_ADDED'));

  // Mutual circular $ref chain: NodeA -> NodeB -> NodeA
  const cyclicDoc = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: '#/$defs/NodeA',
    $defs: {
      NodeA: { $ref: '#/$defs/NodeB' },
      NodeB: { $ref: '#/$defs/NodeA' }
    }
  });

  assert.throws(
    () => parseSpecContent(cyclicDoc),
    (err: unknown) =>
      err instanceof SchemaGuardError && err.code === 'CIRCULAR_REF' && err.exitCode === 2
  );
});

test('Security limits: rejects external $ref, schema depth > 32, YAML alias bombs, format mismatches, and files > 5 MB', () => {
  // 1. External $ref rejected
  const externalRefDoc = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    properties: {
      remote: { $ref: 'https://example.com/schema.json#/User' }
    }
  });
  assert.throws(
    () => parseSpecContent(externalRefDoc),
    (err: unknown) => err instanceof SchemaGuardError && err.code === 'EXTERNAL_REF_FORBIDDEN'
  );

  // 2. Depth > 32 rejected
  let deepSchema: Record<string, unknown> = { type: 'string' };
  for (let i = 0; i < 36; i++) {
    deepSchema = { type: 'object', properties: { child: deepSchema } };
  }
  deepSchema['$schema'] = 'https://json-schema.org/draft/2020-12/schema';

  assert.throws(
    () => parseSpecContent(JSON.stringify(deepSchema)),
    (err: unknown) => err instanceof SchemaGuardError && err.code === 'MAX_DEPTH_EXCEEDED'
  );

  // 3. YAML alias bomb rejected via maxAliasCount
  const yamlBomb = [
    'openapi: 3.0.3',
    'info: { title: Bomb, version: 1.0.0 }',
    'x-a: &a ["x", "x", "x", "x", "x", "x", "x", "x", "x", "x"]',
    'x-b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]',
    'x-c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]',
    'paths: {}'
  ].join('\n');

  assert.throws(
    () => parseSpecContent(yamlBomb, 'bomb.yaml'),
    (err: unknown) => err instanceof SchemaGuardError && err.code === 'YAML_ALIAS_LIMIT'
  );

  // 4. Format mismatch rejected
  assert.throws(
    () =>
      diffContents(
        JSON.stringify({ tools: [{ name: 'ping' }] }),
        JSON.stringify({ openapi: '3.1.0', info: { title: 'X', version: '1.0' }, paths: {} })
      ),
    (err: unknown) => err instanceof SchemaGuardError && err.code === 'FORMAT_MISMATCH'
  );

  // 5. UTF-8 BOM (.json written by Windows PowerShell 5.1) parsed cleanly
  const bomSpec = parseSpecContent(
    `\uFEFF${JSON.stringify({ tools: [{ name: 'bom_tool', inputSchema: { type: 'object' } }] })}`,
    'bom.json'
  );
  assert.equal(bomSpec.format, 'mcp-tools');

  // 6. File size > 5 MB rejected cleanly
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-limit-'));
  try {
    const oversizedPath = path.join(tmpDir, 'oversized.json');
    const filler = 'a'.repeat(MAX_SPEC_BYTES + 1024);
    fs.writeFileSync(
      oversizedPath,
      `{"$schema":"https://json-schema.org/draft/2020-12/schema","description":"${filler}"}`
    );

    assert.throws(
      () => loadSpecFromFile(oversizedPath),
      (err: unknown) => err instanceof SchemaGuardError && err.code === 'FILE_TOO_LARGE'
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
