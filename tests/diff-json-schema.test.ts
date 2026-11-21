import assert from 'node:assert/strict';
import test from 'node:test';
import { diffContents } from '../src/index.js';

test('JSON Schema: classifies tightened bounds, enum removal, additionalProperties false, and incompatible types as BREAKING', () => {
  const oldSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      username: { type: 'string', minLength: 2, maxLength: 32 },
      age: { type: 'number', minimum: 0, maximum: 150 },
      tags: { type: 'array', minItems: 0, maxItems: 20, items: { type: 'string' } },
      tier: { type: 'string', enum: ['free', 'pro', 'enterprise'] },
      code: { type: 'string' },
      version: { const: 1 },
      payload: {
        oneOf: [
          { type: 'string' },
          { type: 'integer' }
        ]
      }
    }
  });

  const newSchema = JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      username: { type: 'string', minLength: 4, maxLength: 16 },
      age: { type: 'number', minimum: 18, maximum: 120 },
      tags: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string' } },
      tier: { type: 'string', enum: ['pro', 'enterprise'] },
      code: { type: 'integer' },
      version: { const: 2 },
      payload: {
        oneOf: [
          { type: 'string' }
        ]
      }
    }
  });

  const report = diffContents(oldSchema, newSchema);
  assert.equal(report.format, 'json-schema');
  assert.equal(report.hasBreaking, true);

  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_ADDITIONAL_PROPS_RESTRICTED' && c.severity === 'BREAKING'
    )
  );
  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_ENUM_VALUE_REMOVED' && c.severity === 'BREAKING' && c.before === 'free'
    )
  );
  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_TYPE_CHANGED' && c.severity === 'BREAKING' && c.path.endsWith('/code/type')
    )
  );
  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_CONST_CHANGED' && c.severity === 'BREAKING'
    )
  );
  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_UNION_VARIANT_REMOVED' && c.severity === 'BREAKING'
    )
  );

  const tightenedBounds = report.changes.filter(
    (c) => c.id === 'SCHEMA_BOUND_TIGHTENED' && c.severity === 'BREAKING'
  );
  // minLength, maxLength, minimum, maximum, minItems, maxItems, uniqueItems = 7 tightened bounds
  assert.equal(tightenedBounds.length, 7);
});

test('JSON Schema: classifies dangerous vs non-breaking changes and handles __proto__/constructor keys safely', () => {
  const oldSchema = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: true,
    properties: {
      ['__proto__']: { type: 'string', default: 'v1', format: 'hostname' },
      constructor: { type: 'integer', minimum: 10, maximum: 20 },
      legacyFlag: { type: 'boolean', description: 'Old description' }
    }
  });

  const newSchema = JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      ['__proto__']: { type: 'string', default: 'v2', format: 'uri' },
      constructor: { type: 'integer', minimum: 1, maximum: 100 },
      legacyFlag: { type: 'boolean', deprecated: true, description: 'Updated description' },
      withDefault: { type: 'string', default: 'standard' },
      withoutDefault: { type: 'string' }
    }
  });

  const report = diffContents(oldSchema, newSchema);
  assert.equal(report.hasBreaking, true); // additionalProperties true -> false
  assert.equal(report.hasDangerous, true);

  assert.ok(
    report.changes.some(
      (c) => c.id === 'SCHEMA_ADDITIONAL_PROPS_RESTRICTED' && c.severity === 'BREAKING'
    )
  );

  const dangerousIds = report.changes.filter((c) => c.severity === 'DANGEROUS').map((c) => c.id);
  assert.ok(dangerousIds.includes('SCHEMA_DEFAULT_CHANGED'));
  assert.ok(dangerousIds.includes('SCHEMA_FORMAT_CHANGED'));
  assert.ok(dangerousIds.includes('SCHEMA_DEPRECATED_ADDED'));
  assert.ok(dangerousIds.includes('SCHEMA_OPTIONAL_PROPERTY_ADDED'));

  const nonBreakingIds = report.changes.filter((c) => c.severity === 'NON_BREAKING').map((c) => c.id);
  assert.ok(nonBreakingIds.includes('SCHEMA_BOUND_LOOSENED'));
  assert.ok(nonBreakingIds.includes('DESCRIPTION_CHANGED'));
  assert.ok(nonBreakingIds.includes('SCHEMA_OPTIONAL_WITH_DEFAULT_ADDED'));

  assert.equal(({} as Record<string, unknown>)['default'], undefined);
});
