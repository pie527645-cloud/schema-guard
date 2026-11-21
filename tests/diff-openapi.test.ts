import assert from 'node:assert/strict';
import test from 'node:test';
import { diffContents } from '../src/index.js';

test('OpenAPI 3.0 YAML: detects endpoint removal, required parameter, response property removal, and response enum addition', () => {
  const oldYaml = `
openapi: 3.0.3
info:
  title: Orders API
  version: 1.0.0
paths:
  /orders:
    get:
      summary: List orders
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [pending, shipped]
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderList'
    delete:
      summary: Purge orders
      responses:
        '204':
          description: Deleted
  /legacy:
    get:
      responses:
        '200':
          description: Legacy endpoint
components:
  schemas:
    OrderList:
      type: object
      required: [items, nextCursor]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Order'
        nextCursor:
          type: string
    Order:
      type: object
      required: [id, state]
      properties:
        id:
          type: string
          maxLength: 36
        state:
          type: string
          enum: [pending, shipped]
`;

  const newYaml = `
openapi: 3.0.3
info:
  title: Orders API
  version: 2.0.0
paths:
  /orders:
    get:
      summary: Retrieve orders list
      deprecated: true
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
            enum: [pending, shipped, archived]
        - name: organizationId
          in: header
          required: true
          schema:
            type: string
        - name: limit
          in: query
          required: false
          schema:
            type: integer
            default: 25
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/OrderList'
  /health:
    get:
      summary: Health check
      responses:
        '200':
          description: Healthy
components:
  schemas:
    OrderList:
      type: object
      required: [items]
      properties:
        items:
          type: array
          items:
            $ref: '#/components/schemas/Order'
    Order:
      type: object
      required: [id, state]
      properties:
        id:
          type: string
          maxLength: 64
        state:
          type: string
          enum: [pending, shipped, cancelled]
`;

  const report = diffContents(oldYaml, newYaml);
  assert.equal(report.format, 'openapi');

  const breaking = report.changes.filter((c) => c.severity === 'BREAKING');
  assert.ok(breaking.some((c) => c.id === 'OAPI_PATH_REMOVED' && c.path === '#/paths/~1legacy'));
  assert.ok(breaking.some((c) => c.id === 'OAPI_OPERATION_REMOVED' && c.path === '#/paths/~1orders/delete'));
  assert.ok(breaking.some((c) => c.id === 'OAPI_REQUIRED_PARAMETER_ADDED'));
  assert.ok(breaking.some((c) => c.id === 'SCHEMA_PROPERTY_REMOVED' && c.path.endsWith('/properties/nextCursor')));

  const dangerous = report.changes.filter((c) => c.severity === 'DANGEROUS');
  assert.ok(dangerous.some((c) => c.id === 'OAPI_OPERATION_DEPRECATED'));
  assert.ok(dangerous.some((c) => c.id === 'SCHEMA_BOUND_LOOSENED' && c.path.endsWith('/maxLength')));
  assert.ok(dangerous.some((c) => c.id === 'SCHEMA_ENUM_VALUE_ADDED' && c.path.endsWith('/state/enum')));

  const nonBreaking = report.changes.filter((c) => c.severity === 'NON_BREAKING');
  assert.ok(nonBreaking.some((c) => c.id === 'OAPI_PATH_ADDED' && c.path === '#/paths/~1health'));
  assert.ok(nonBreaking.some((c) => c.id === 'SCHEMA_ENUM_VALUE_ADDED' && c.path.includes('query:status')));
  assert.ok(nonBreaking.some((c) => c.id === 'OAPI_OPTIONAL_PARAMETER_WITH_DEFAULT_ADDED'));
});

test('OpenAPI 3.1 JSON: handles allOf composition and type array narrowing', () => {
  const oldJson = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Users', version: '1.0.0' },
    paths: {
      '/users': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/BaseUser' },
                    {
                      type: 'object',
                      properties: {
                        nickname: { type: ['string', 'null'] }
                      }
                    }
                  ]
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                      id: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        BaseUser: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string' }
          }
        }
      }
    }
  });

  const newJson = JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Users', version: '1.1.0' },
    paths: {
      '/users': {
        post: {
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  allOf: [
                    { $ref: '#/components/schemas/BaseUser' },
                    {
                      type: 'object',
                      properties: {
                        nickname: { type: 'string' }
                      }
                    }
                  ]
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['id'],
                    properties: {
                      id: { type: ['string', 'null'] }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    components: {
      schemas: {
        BaseUser: {
          type: 'object',
          required: ['email', 'role'],
          properties: {
            email: { type: 'string' },
            role: { type: 'string' }
          }
        }
      }
    }
  });

  const report = diffContents(oldJson, newJson);
  assert.equal(report.format, 'openapi');
  assert.equal(report.summary.breaking, 3);
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_TYPE_NARROWED' && c.severity === 'BREAKING'));
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_REQUIRED_PROPERTY_ADDED' && c.severity === 'BREAKING'));
  assert.ok(report.changes.some((c) => c.id === 'SCHEMA_TYPE_WIDENED' && c.severity === 'BREAKING'));
});
