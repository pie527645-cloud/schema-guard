import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNullRecord, hasOwn } from './safe-object.js';
import {
  type ChangeSeverity,
  type DiffReport,
  INFORMATION_URI,
  type OutputFormat,
  PACKAGE_NAME,
  PACKAGE_VERSION
} from './types.js';

export type SarifLevel = 'error' | 'warning' | 'note';

export interface SarifReportingDescriptor {
  id: string;
  shortDescription: { text: string };
  defaultConfiguration: { level: SarifLevel };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex: number;
  level: SarifLevel;
  message: { text: string };
  locations: Array<{
    physicalLocation: {
      artifactLocation: { uri: string };
      region: { startLine: number; startColumn: number };
    };
    logicalLocations: Array<{
      fullyQualifiedName: string;
      kind: string;
    }>;
  }>;
}

export interface SarifLog {
  $schema: string;
  version: '2.1.0';
  runs: Array<{
    tool: {
      driver: {
        name: string;
        fullName: string;
        version: string;
        informationUri: string;
        rules: SarifReportingDescriptor[];
      };
    };
    results: SarifResult[];
  }>;
}

function severityToSarifLevel(severity: ChangeSeverity): SarifLevel {
  switch (severity) {
    case 'BREAKING':
      return 'error';
    case 'DANGEROUS':
      return 'warning';
    case 'NON_BREAKING':
      return 'note';
  }
}

function toSarifArtifactUri(sourcePath?: string): string {
  if (!sourcePath || sourcePath.trim().length === 0) {
    return 'contract.json';
  }
  const cwd = process.cwd();
  const abs = path.resolve(cwd, sourcePath);
  const rel = path.relative(cwd, abs);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel.split(path.sep).join('/');
  }
  if (!path.isAbsolute(sourcePath)) {
    return sourcePath.split('\\').join('/');
  }
  return pathToFileURL(abs).href;
}

export function buildSarifObject(report: DiffReport): SarifLog {
  const rules: SarifReportingDescriptor[] = [];
  const ruleIndexById = createNullRecord<number>();
  const artifactUri = toSarifArtifactUri(report.newSource ?? report.oldSource);

  const results: SarifResult[] = report.changes.map((change) => {
    let ruleIndex: number;
    if (hasOwn(ruleIndexById, change.id)) {
      ruleIndex = ruleIndexById[change.id]!;
    } else {
      ruleIndex = rules.length;
      ruleIndexById[change.id] = ruleIndex;
      rules.push({
        id: change.id,
        shortDescription: {
          text: `${change.id} (${change.severity})`
        },
        defaultConfiguration: {
          level: severityToSarifLevel(change.severity)
        }
      });
    }

    return {
      ruleId: change.id,
      ruleIndex,
      level: severityToSarifLevel(change.severity),
      message: {
        text: `[${change.severity}] ${change.path}: ${change.message}`
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: artifactUri },
            region: { startLine: 1, startColumn: 1 }
          },
          logicalLocations: [
            {
              fullyQualifiedName: change.path,
              kind: 'member'
            }
          ]
        }
      ]
    };
  });

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'schema-guard',
            fullName: PACKAGE_NAME,
            version: PACKAGE_VERSION,
            informationUri: INFORMATION_URI,
            rules
          }
        },
        results
      }
    ]
  };
}

export function formatSarif(report: DiffReport): string {
  return `${JSON.stringify(buildSarifObject(report), null, 2)}\n`;
}

export function formatJson(report: DiffReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatPretty(report: DiffReport): string {
  const lines: string[] = [];
  lines.push(`Schema Guard Contract Diff (${report.format})`);
  if (report.oldSource || report.newSource) {
    lines.push(`  Baseline : ${report.oldSource ?? '<inline>'}`);
    lines.push(`  Candidate: ${report.newSource ?? '<inline>'}`);
  }
  lines.push(
    `  Summary  : ${report.summary.breaking} breaking, ${report.summary.dangerous} dangerous, ${report.summary.nonBreaking} non-breaking (${report.summary.total} total)`
  );

  if (report.changes.length === 0) {
    lines.push('');
    lines.push('No contract changes detected.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  for (const item of report.changes) {
    const badge =
      item.severity === 'BREAKING'
        ? '[BREAKING]    '
        : item.severity === 'DANGEROUS'
          ? '[DANGEROUS]   '
          : '[NON_BREAKING]';
    lines.push(`${badge} ${item.path} (${item.id})`);
    lines.push(`               ${item.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function escapeMarkdownCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function formatMarkdown(report: DiffReport): string {
  const lines: string[] = [];
  lines.push('## Schema Guard Contract Diff');
  lines.push('');
  lines.push(`- **Format:** \`${report.format}\``);
  if (report.oldSource) {
    lines.push(`- **Baseline:** \`${report.oldSource}\``);
  }
  if (report.newSource) {
    lines.push(`- **Candidate:** \`${report.newSource}\``);
  }
  lines.push(
    `- **Summary:** **${report.summary.breaking}** breaking, **${report.summary.dangerous}** dangerous, **${report.summary.nonBreaking}** non-breaking (${report.summary.total} total)`
  );
  lines.push('');

  if (report.changes.length === 0) {
    lines.push('No contract changes detected.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('| Severity | Path | Rule | Details |');
  lines.push('| --- | --- | --- | --- |');
  for (const item of report.changes) {
    lines.push(
      `| \`${item.severity}\` | \`${escapeMarkdownCell(item.path)}\` | \`${item.id}\` | ${escapeMarkdownCell(item.message)} |`
    );
  }

  return `${lines.join('\n')}\n`;
}

export function formatReport(report: DiffReport, format: OutputFormat): string {
  switch (format) {
    case 'pretty':
      return formatPretty(report);
    case 'json':
      return formatJson(report);
    case 'markdown':
      return formatMarkdown(report);
    case 'sarif':
      return formatSarif(report);
  }
}
