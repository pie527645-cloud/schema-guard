export type SpecFormat = 'mcp-tools' | 'openapi' | 'json-schema';

export type ChangeSeverity = 'BREAKING' | 'DANGEROUS' | 'NON_BREAKING';

export type FailThreshold = 'breaking' | 'dangerous' | 'none';

export type OutputFormat = 'pretty' | 'json' | 'markdown' | 'sarif';

export type SchemaDirection = 'request' | 'response' | 'standalone';

export type SchemaGuardErrorCode =
  | 'INVALID_USAGE'
  | 'FILE_READ_ERROR'
  | 'FILE_TOO_LARGE'
  | 'PARSE_ERROR'
  | 'YAML_ALIAS_LIMIT'
  | 'UNSUPPORTED_FORMAT'
  | 'FORMAT_MISMATCH'
  | 'CIRCULAR_REF'
  | 'MAX_DEPTH_EXCEEDED'
  | 'EXTERNAL_REF_FORBIDDEN'
  | 'SNAPSHOT_ERROR'
  | 'GIT_ERROR';

export class SchemaGuardError extends Error {
  public readonly code: SchemaGuardErrorCode;
  public readonly exitCode = 2 as const;

  constructor(code: SchemaGuardErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SchemaGuardError';
    this.code = code;
  }
}

export interface ChangeItem {
  id: string;
  severity: ChangeSeverity;
  path: string;
  message: string;
  before?: unknown;
  after?: unknown;
}

export interface DiffSummary {
  breaking: number;
  dangerous: number;
  nonBreaking: number;
  total: number;
}

export interface DiffReport {
  format: SpecFormat;
  oldSource?: string;
  newSource?: string;
  summary: DiffSummary;
  changes: ChangeItem[];
  hasBreaking: boolean;
  hasDangerous: boolean;
}

export interface ParsedSpec {
  format: SpecFormat;
  document: unknown;
  source?: string;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown> | boolean;
  outputSchema?: Record<string, unknown> | boolean;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpSnapshotDocument {
  tools: McpToolDefinition[];
}

export const MAX_SPEC_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_YAML_ALIASES = 50;
export const PACKAGE_NAME = '@pie527645-cloud/schema-guard';
export const PACKAGE_VERSION = '1.0.0';
export const INFORMATION_URI = 'https://github.com/pie527645-cloud/schema-guard';
