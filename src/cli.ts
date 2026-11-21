#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffFiles, evaluateThreshold } from './diff.js';
import { formatReport } from './formatters.js';
import { gitDiffSpec } from './git-diff.js';
import { captureMcpSnapshot } from './snapshot.js';
import {
  type FailThreshold,
  type OutputFormat,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SchemaGuardError
} from './types.js';

const VALID_FORMATS = new Set<OutputFormat>(['pretty', 'json', 'markdown', 'sarif']);
const VALID_FAIL_ON = new Set<FailThreshold>(['breaking', 'dangerous', 'none']);

function buildHelpText(): string {
  return `${PACKAGE_NAME} v${PACKAGE_VERSION}
Breaking Change Detector & Contract Snapshot Diff CLI for OpenAPI 3.0/3.1, JSON Schema, and MCP tools/list.

Usage:
  schema-guard diff <oldPath> <newPath> [--format pretty|json|markdown|sarif] [--fail-on breaking|dangerous|none]
  schema-guard snapshot --stdio "<cmd>" --out <file> [--timeout <ms>]
  schema-guard git-diff --file <repo-relative-path> [--base HEAD] [--repo .] [--format pretty|json|markdown|sarif] [--fail-on breaking|dangerous|none]

Commands:
  diff       Compare two contract specification files (OpenAPI, JSON Schema, or MCP tools/list).
  snapshot   Spawn a live stdio MCP server and write a deterministic canonical tools/list snapshot.
  git-diff   Compare a tracked contract specification file against a Git baseline revision.

Global Options:
  -h, --help      Show help information and exit.
  -v, --version   Show package version and exit.

Exit Codes:
  0  Pass (no changes at or above --fail-on threshold, or snapshot written)
  1  Threshold hit (breaking or dangerous changes >= --fail-on threshold)
  2  Invalid usage, unreadable specification, or parse/validation failure
`;
}

function parseOutputFormat(raw: string | undefined): OutputFormat {
  if (raw === undefined) return 'pretty';
  if (VALID_FORMATS.has(raw as OutputFormat)) {
    return raw as OutputFormat;
  }
  throw new SchemaGuardError(
    'INVALID_USAGE',
    `Invalid --format "${raw}". Expected one of: pretty, json, markdown, sarif.`
  );
}

function parseFailOn(raw: string | undefined): FailThreshold {
  if (raw === undefined) return 'breaking';
  if (VALID_FAIL_ON.has(raw as FailThreshold)) {
    return raw as FailThreshold;
  }
  throw new SchemaGuardError(
    'INVALID_USAGE',
    `Invalid --fail-on "${raw}". Expected one of: breaking, dangerous, none.`
  );
}

function consumeFlagValue(argv: readonly string[], index: number, flagName: string): string {
  const next = argv[index + 1];
  if (next === undefined || next === '') {
    throw new SchemaGuardError('INVALID_USAGE', `Missing value for option ${flagName}.`);
  }
  return next;
}

async function handleDiffCommand(args: readonly string[], writeOut: (s: string) => void): Promise<number> {
  const positionals: string[] = [];
  let formatRaw: string | undefined;
  let failOnRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      writeOut(buildHelpText());
      return 0;
    }
    if (arg === '--format') {
      formatRaw = consumeFlagValue(args, i, '--format');
      i += 1;
    } else if (arg.startsWith('--format=')) {
      formatRaw = arg.slice('--format='.length);
    } else if (arg === '--fail-on') {
      failOnRaw = consumeFlagValue(args, i, '--fail-on');
      i += 1;
    } else if (arg.startsWith('--fail-on=')) {
      failOnRaw = arg.slice('--fail-on='.length);
    } else if (arg.startsWith('-')) {
      throw new SchemaGuardError('INVALID_USAGE', `Unknown option "${arg}" for "diff" command.`);
    } else {
      positionals.push(arg);
    }
  }

  if (positionals.length !== 2) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      'Usage: schema-guard diff <oldPath> <newPath> [--format pretty|json|markdown|sarif] [--fail-on breaking|dangerous|none]'
    );
  }

  const format = parseOutputFormat(formatRaw);
  const failOn = parseFailOn(failOnRaw);
  const report = diffFiles(positionals[0]!, positionals[1]!);
  writeOut(formatReport(report, format));
  return evaluateThreshold(report, failOn);
}

async function handleSnapshotCommand(
  args: readonly string[],
  writeOut: (s: string) => void
): Promise<number> {
  let stdioCmd: string | undefined;
  let outFile: string | undefined;
  let timeoutRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      writeOut(buildHelpText());
      return 0;
    }
    if (arg === '--stdio') {
      stdioCmd = consumeFlagValue(args, i, '--stdio');
      i += 1;
    } else if (arg.startsWith('--stdio=')) {
      stdioCmd = arg.slice('--stdio='.length);
    } else if (arg === '--out') {
      outFile = consumeFlagValue(args, i, '--out');
      i += 1;
    } else if (arg.startsWith('--out=')) {
      outFile = arg.slice('--out='.length);
    } else if (arg === '--timeout') {
      timeoutRaw = consumeFlagValue(args, i, '--timeout');
      i += 1;
    } else if (arg.startsWith('--timeout=')) {
      timeoutRaw = arg.slice('--timeout='.length);
    } else {
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Unexpected argument "${arg}" for "snapshot" command.`
      );
    }
  }

  if (!stdioCmd || stdioCmd.trim().length === 0 || !outFile || outFile.trim().length === 0) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      'Usage: schema-guard snapshot --stdio "<cmd>" --out <file> [--timeout <ms>]'
    );
  }

  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    if (!/^\d+$/.test(timeoutRaw)) {
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Invalid --timeout "${timeoutRaw}": must be a positive integer in milliseconds.`
      );
    }
    timeoutMs = Number(timeoutRaw);
  }

  const snapshot = await captureMcpSnapshot({
    stdioCommand: stdioCmd,
    outPath: outFile,
    timeoutMs
  });

  writeOut(`Wrote MCP snapshot (${snapshot.tools.length} tool(s)) to ${outFile}\n`);
  return 0;
}

async function handleGitDiffCommand(
  args: readonly string[],
  writeOut: (s: string) => void
): Promise<number> {
  let fileRaw: string | undefined;
  let baseRaw: string | undefined;
  let repoRaw: string | undefined;
  let formatRaw: string | undefined;
  let failOnRaw: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '-h' || arg === '--help') {
      writeOut(buildHelpText());
      return 0;
    }
    if (arg === '--file') {
      fileRaw = consumeFlagValue(args, i, '--file');
      i += 1;
    } else if (arg.startsWith('--file=')) {
      fileRaw = arg.slice('--file='.length);
    } else if (arg === '--base') {
      baseRaw = consumeFlagValue(args, i, '--base');
      i += 1;
    } else if (arg.startsWith('--base=')) {
      baseRaw = arg.slice('--base='.length);
    } else if (arg === '--repo') {
      repoRaw = consumeFlagValue(args, i, '--repo');
      i += 1;
    } else if (arg.startsWith('--repo=')) {
      repoRaw = arg.slice('--repo='.length);
    } else if (arg === '--format') {
      formatRaw = consumeFlagValue(args, i, '--format');
      i += 1;
    } else if (arg.startsWith('--format=')) {
      formatRaw = arg.slice('--format='.length);
    } else if (arg === '--fail-on') {
      failOnRaw = consumeFlagValue(args, i, '--fail-on');
      i += 1;
    } else if (arg.startsWith('--fail-on=')) {
      failOnRaw = arg.slice('--fail-on='.length);
    } else {
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Unexpected argument "${arg}" for "git-diff" command.`
      );
    }
  }

  if (!fileRaw || fileRaw.trim().length === 0) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      'Usage: schema-guard git-diff --file <repo-relative-path> [--base HEAD] [--repo .] [--format pretty|json|markdown|sarif] [--fail-on breaking|dangerous|none]'
    );
  }

  const format = parseOutputFormat(formatRaw);
  const failOn = parseFailOn(failOnRaw);
  const report = await gitDiffSpec({
    file: fileRaw,
    base: baseRaw,
    repo: repoRaw
  });

  writeOut(formatReport(report, format));
  return evaluateThreshold(report, failOn);
}

export async function runCli(
  argv: readonly string[],
  io: {
    stdout?: (s: string) => void;
    stderr?: (s: string) => void;
  } = {}
): Promise<number> {
  const writeOut = io.stdout ?? ((s: string) => process.stdout.write(s));
  const writeErr = io.stderr ?? ((s: string) => process.stderr.write(s));

  try {
    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
      writeOut(buildHelpText());
      return 0;
    }

    if (argv[0] === '-v' || argv[0] === '--version') {
      writeOut(`${PACKAGE_VERSION}\n`);
      return 0;
    }

    const command = argv[0];
    const subArgs = argv.slice(1);

    switch (command) {
      case 'diff':
        return await handleDiffCommand(subArgs, writeOut);
      case 'snapshot':
        return await handleSnapshotCommand(subArgs, writeOut);
      case 'git-diff':
        return await handleGitDiffCommand(subArgs, writeOut);
      default:
        throw new SchemaGuardError(
          'INVALID_USAGE',
          `Unknown command "${command}". Expected one of: diff, snapshot, git-diff.`
        );
    }
  } catch (err) {
    if (err instanceof SchemaGuardError) {
      writeErr(`Error [${err.code}]: ${err.message}\n`);
      return err.exitCode;
    }
    const msg = err instanceof Error ? err.message : String(err);
    writeErr(`Unexpected error: ${msg}\n`);
    return 2;
  }
}

function isMainModule(): boolean {
  const entryArg = process.argv[1];
  if (!entryArg) return false;
  try {
    const resolvedArg = fs.realpathSync(path.resolve(entryArg));
    const resolvedSelf = fs.realpathSync(fileURLToPath(import.meta.url));
    return resolvedArg === resolvedSelf;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal error: ${msg}\n`);
      process.exitCode = 2;
    });
}
