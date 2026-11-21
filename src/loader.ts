import fs from 'node:fs';
import YAML from 'yaml';
import { validateDocumentGraph } from './ref-resolver.js';
import { hasOwn, isObjectRecord, sanitizeStructure } from './safe-object.js';
import {
  MAX_SPEC_BYTES,
  MAX_YAML_ALIASES,
  type ParsedSpec,
  SchemaGuardError,
  type SpecFormat
} from './types.js';

const JSON_SCHEMA_ROOT_KEYWORDS = new Set<string>([
  '$schema',
  '$id',
  '$defs',
  'definitions',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'prefixItems',
  'enum',
  'const',
  'allOf',
  'oneOf',
  'anyOf',
  'not',
  '$ref',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
  'uniqueItems',
  'multipleOf'
]);

function isMcpToolLike(item: unknown): boolean {
  if (!isObjectRecord(item)) return false;
  if (typeof item['name'] !== 'string' || item['name'].trim().length === 0) {
    return false;
  }
  if (hasOwn(item, 'inputSchema')) {
    const schema = item['inputSchema'];
    if (typeof schema !== 'boolean' && !isObjectRecord(schema)) {
      return false;
    }
  }
  return true;
}

/**
 * Auto-detects whether a parsed document is an OpenAPI 3.0/3.1 specification,
 * an MCP `tools/list` contract, or a JSON Schema (Draft 7 / 2020-12).
 */
export function detectSpecFormat(doc: unknown): SpecFormat {
  if (Array.isArray(doc)) {
    if (doc.every((item) => isMcpToolLike(item))) {
      return 'mcp-tools';
    }
    throw new SchemaGuardError(
      'UNSUPPORTED_FORMAT',
      'Array root document is not a valid MCP tools/list array (each element must have a string "name").'
    );
  }

  if (!isObjectRecord(doc)) {
    throw new SchemaGuardError(
      'UNSUPPORTED_FORMAT',
      'Specification root must be a JSON/YAML object or MCP tools array.'
    );
  }

  // 1. OpenAPI 3.0 / 3.1 check
  if (typeof doc['openapi'] === 'string') {
    const version = doc['openapi'].trim();
    if (version.startsWith('3.0') || version.startsWith('3.1')) {
      return 'openapi';
    }
    throw new SchemaGuardError(
      'UNSUPPORTED_FORMAT',
      `Unsupported OpenAPI version "${version}". Only OpenAPI 3.0.x and 3.1.x are supported.`
    );
  }

  if (typeof doc['swagger'] === 'string') {
    throw new SchemaGuardError(
      'UNSUPPORTED_FORMAT',
      `Swagger ${doc['swagger']} is not supported. Upgrade to OpenAPI 3.0 or 3.1.`
    );
  }

  // 2. MCP tools/list envelope: { tools: [...] } or JSON-RPC { result: { tools: [...] } }
  if (!hasOwn(doc, '$schema') && Array.isArray(doc['tools'])) {
    const tools = doc['tools'];
    if (tools.every((item) => isMcpToolLike(item))) {
      return 'mcp-tools';
    }
    throw new SchemaGuardError(
      'UNSUPPORTED_FORMAT',
      'Document contains a "tools" array, but elements are not valid MCP tool definitions.'
    );
  }

  if (
    !hasOwn(doc, '$schema') &&
    isObjectRecord(doc['result']) &&
    Array.isArray(doc['result']['tools']) &&
    (doc['result']['tools'] as unknown[]).every((item) => isMcpToolLike(item))
  ) {
    return 'mcp-tools';
  }

  // 3. JSON Schema check
  for (const key of Object.keys(doc)) {
    if (hasOwn(doc, key) && JSON_SCHEMA_ROOT_KEYWORDS.has(key)) {
      return 'json-schema';
    }
  }

  throw new SchemaGuardError(
    'UNSUPPORTED_FORMAT',
    'Could not auto-detect specification format. Expected OpenAPI 3.0/3.1, MCP tools/list, or JSON Schema.'
  );
}

/**
 * Parses raw string/Buffer content as JSON or YAML (with alias-bomb protection),
 * enforces the 5 MB file size limit, sanitizes prototypes, auto-detects format,
 * and validates internal `$ref` / recursion depth safety.
 */
export function parseSpecContent(content: string | Buffer, source?: string): ParsedSpec {
  const byteLength =
    typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;

  if (byteLength > MAX_SPEC_BYTES) {
    throw new SchemaGuardError(
      'FILE_TOO_LARGE',
      `Specification${source ? ` "${source}"` : ''} is ${byteLength} bytes, exceeding the 5 MB (${MAX_SPEC_BYTES} bytes) maximum limit.`
    );
  }

  const rawText = typeof content === 'string' ? content : content.toString('utf8');
  const text = rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText;
  if (text.trim().length === 0) {
    throw new SchemaGuardError(
      'PARSE_ERROR',
      `Specification${source ? ` "${source}"` : ''} is empty.`
    );
  }

  let rawParsed: unknown;
  const trimmed = text.trimStart();

  // Fast-path strict JSON if file ends with .json; otherwise try JSON first if starting with { or [, falling back to YAML
  const forceJson = source !== undefined && source.toLowerCase().endsWith('.json');

  if (forceJson) {
    try {
      rawParsed = JSON.parse(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new SchemaGuardError(
        'PARSE_ERROR',
        `Failed to parse JSON specification${source ? ` "${source}"` : ''}: ${msg}`,
        { cause: err }
      );
    }
  } else {
    let parsedViaJson = false;
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        rawParsed = JSON.parse(text);
        parsedViaJson = true;
      } catch {
        // Might be YAML flow mapping/sequence; fall through to YAML parser
      }
    }

    if (!parsedViaJson) {
      try {
        rawParsed = YAML.parse(text, {
          maxAliasCount: MAX_YAML_ALIASES,
          uniqueKeys: false
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Excessive alias count')) {
          throw new SchemaGuardError(
            'YAML_ALIAS_LIMIT',
            `YAML alias expansion limit (${MAX_YAML_ALIASES}) exceeded${source ? ` in "${source}"` : ''}: potential YAML bomb rejected.`,
            { cause: err }
          );
        }
        throw new SchemaGuardError(
          'PARSE_ERROR',
          `Failed to parse specification${source ? ` "${source}"` : ''}: ${msg}`,
          { cause: err }
        );
      }
    }
  }

  const document = sanitizeStructure(rawParsed);
  const format = detectSpecFormat(document);
  validateDocumentGraph(document);

  return {
    format,
    document,
    source
  };
}

/**
 * Safely reads a specification file from disk, enforcing `<= 5 MB` before and after reading.
 */
export function loadSpecFromFile(filePath: string): ParsedSpec {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaGuardError('FILE_READ_ERROR', `Cannot access file "${filePath}": ${msg}`, {
      cause: err
    });
  }

  if (!stats.isFile()) {
    throw new SchemaGuardError('FILE_READ_ERROR', `Path "${filePath}" is not a regular file.`);
  }

  if (stats.size > MAX_SPEC_BYTES) {
    throw new SchemaGuardError(
      'FILE_TOO_LARGE',
      `Specification "${filePath}" is ${stats.size} bytes, exceeding the 5 MB (${MAX_SPEC_BYTES} bytes) limit.`
    );
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaGuardError('FILE_READ_ERROR', `Failed to read "${filePath}": ${msg}`, {
      cause: err
    });
  }

  return parseSpecContent(buffer, filePath);
}
