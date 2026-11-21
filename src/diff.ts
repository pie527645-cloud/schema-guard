import { loadSpecFromFile, parseSpecContent } from './loader.js';
import { diffMcpSpecs } from './mcp-diff.js';
import { diffOpenApiSpecs } from './openapi-diff.js';
import { diffSchemaNodes } from './schema-diff.js';
import {
  type ChangeItem,
  type DiffReport,
  type DiffSummary,
  type FailThreshold,
  type ParsedSpec,
  SchemaGuardError
} from './types.js';

function summarizeChanges(changes: readonly ChangeItem[]): DiffSummary {
  let breaking = 0;
  let dangerous = 0;
  let nonBreaking = 0;

  for (const item of changes) {
    if (item.severity === 'BREAKING') {
      breaking += 1;
    } else if (item.severity === 'DANGEROUS') {
      dangerous += 1;
    } else {
      nonBreaking += 1;
    }
  }

  return {
    breaking,
    dangerous,
    nonBreaking,
    total: changes.length
  };
}

/**
 * Compares two parsed specifications of the same contract format and produces
 * a structured DiffReport.
 */
export function diffSpecs(oldSpec: ParsedSpec, newSpec: ParsedSpec): DiffReport {
  if (oldSpec.format !== newSpec.format) {
    throw new SchemaGuardError(
      'FORMAT_MISMATCH',
      `Cannot diff incompatible contract formats: baseline is "${oldSpec.format}", candidate is "${newSpec.format}".`
    );
  }

  let changes: ChangeItem[];
  switch (oldSpec.format) {
    case 'mcp-tools':
      changes = diffMcpSpecs(oldSpec.document, newSpec.document);
      break;
    case 'openapi':
      changes = diffOpenApiSpecs(oldSpec.document, newSpec.document);
      break;
    case 'json-schema':
      changes = [];
      diffSchemaNodes(oldSpec.document, newSpec.document, {
        oldRoot: oldSpec.document,
        newRoot: newSpec.document,
        direction: 'standalone',
        path: '#',
        depth: 0,
        oldActiveRefs: new Set<string>(),
        newActiveRefs: new Set<string>(),
        changes
      });
      break;
  }

  const summary = summarizeChanges(changes);
  return {
    format: oldSpec.format,
    oldSource: oldSpec.source,
    newSource: newSpec.source,
    summary,
    changes,
    hasBreaking: summary.breaking > 0,
    hasDangerous: summary.dangerous > 0
  };
}

/**
 * Parses and diffs two in-memory specification strings or Buffers.
 */
export function diffContents(
  oldContent: string | Buffer,
  newContent: string | Buffer,
  options?: { oldSource?: string; newSource?: string }
): DiffReport {
  const oldSpec = parseSpecContent(oldContent, options?.oldSource);
  const newSpec = parseSpecContent(newContent, options?.newSource);
  return diffSpecs(oldSpec, newSpec);
}

/**
 * Loads two specification files from disk (each capped at <= 5 MB) and diffs them.
 */
export function diffFiles(oldPath: string, newPath: string): DiffReport {
  const oldSpec = loadSpecFromFile(oldPath);
  const newSpec = loadSpecFromFile(newPath);
  return diffSpecs(oldSpec, newSpec);
}

/**
 * Returns exit code `1` if the report meets or exceeds `failOn`, otherwise `0`.
 */
export function evaluateThreshold(report: DiffReport, failOn: FailThreshold): 0 | 1 {
  if (failOn === 'none') {
    return 0;
  }
  if (failOn === 'breaking') {
    return report.hasBreaking ? 1 : 0;
  }
  if (failOn === 'dangerous') {
    return report.hasBreaking || report.hasDangerous ? 1 : 0;
  }
  return 0;
}
