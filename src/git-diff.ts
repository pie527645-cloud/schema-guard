import fs from 'node:fs';
import path from 'node:path';
import { diffSpecs } from './diff.js';
import { loadSpecFromFile, parseSpecContent } from './loader.js';
import { runCommandBounded } from './process-utils.js';
import { type DiffReport, MAX_SPEC_BYTES, SchemaGuardError } from './types.js';

export interface GitDiffOptions {
  file: string;
  base?: string;
  repo?: string;
  timeoutMs?: number;
}

/**
 * Strict Git ref validator allowing standard refs like `HEAD`, `main`, `origin/main`,
 * `v1.2.0`, `HEAD~1`, `HEAD^`, commit SHAs, while blocking leading `-`, NUL/newlines,
 * whitespace, `:`, and control chars.
 */
export function assertSafeGitBaseRef(base: string): string {
  if (typeof base !== 'string' || base.trim().length === 0) {
    throw new SchemaGuardError('INVALID_USAGE', 'Git --base ref must be a non-empty string.');
  }
  if (base.startsWith('-')) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Unsafe Git --base ref "${base}": leading "-" is forbidden (flag injection guard).`
    );
  }
  if (/[\x00-\x20\x7f:\\]/.test(base)) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Unsafe Git --base ref "${base}": must not contain whitespace, colons, backslashes, NUL, or control characters.`
    );
  }
  return base;
}

/**
 * Validates and normalizes a repository-relative file path, rejecting absolute paths,
 * Windows drive prefixes, leading dashes, NUL/newlines, `..` traversal segments,
 * and symlinks escaping `repoDir`.
 */
export function resolveSafeRepoFile(
  repoDir: string,
  rawFile: string
): { repoRealPath: string; posixRelPath: string; absoluteFilePath: string } {
  if (typeof rawFile !== 'string' || rawFile.trim().length === 0) {
    throw new SchemaGuardError('INVALID_USAGE', '--file must be a non-empty repository-relative path.');
  }
  if (/[\x00\r\n]/.test(rawFile)) {
    throw new SchemaGuardError('INVALID_USAGE', '--file must not contain NUL or newline characters.');
  }
  if (rawFile.startsWith('-')) {
    throw new SchemaGuardError('INVALID_USAGE', `Unsafe --file "${rawFile}": must not start with "-".`);
  }
  if (
    rawFile.startsWith('/') ||
    rawFile.startsWith('\\') ||
    /^[a-zA-Z]:/.test(rawFile) ||
    path.isAbsolute(rawFile)
  ) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Unsafe --file "${rawFile}": path must be relative to the repository root, not absolute.`
    );
  }

  let repoRealPath: string;
  try {
    repoRealPath = fs.realpathSync(path.resolve(repoDir));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaGuardError('GIT_ERROR', `Cannot resolve repository directory "${repoDir}": ${msg}`, {
      cause: err
    });
  }

  // Normalize slashes and strip leading "./"
  const rawSegments = rawFile.replace(/\\/g, '/').split('/');
  const cleanSegments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i]!;
    if (seg === '' || seg === '.') {
      if (i === 0 && seg === '.') continue;
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Invalid --file "${rawFile}": contains empty or "." path segments.`
      );
    }
    if (seg === '..') {
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Unsafe --file "${rawFile}": parent directory traversal ("..") is forbidden.`
      );
    }
    cleanSegments.push(seg);
  }

  if (cleanSegments.length === 0) {
    throw new SchemaGuardError('INVALID_USAGE', `--file "${rawFile}" does not name a file.`);
  }

  const posixRelPath = cleanSegments.join('/');
  const absoluteFilePath = path.resolve(repoRealPath, ...cleanSegments);
  const relCheck = path.relative(repoRealPath, absoluteFilePath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Unsafe --file "${rawFile}": resolves outside repository root.`
    );
  }

  // Also ensure realpath of existing target file does not escape repo via symlink
  if (fs.existsSync(absoluteFilePath)) {
    const targetReal = fs.realpathSync(absoluteFilePath);
    const realRel = path.relative(repoRealPath, targetReal);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new SchemaGuardError(
        'INVALID_USAGE',
        `Unsafe --file "${rawFile}": symlink resolves outside repository root.`
      );
    }
  }

  return {
    repoRealPath,
    posixRelPath,
    absoluteFilePath
  };
}

/**
 * Fetches `<base>:<file>` via `git show` (`shell: false`) and diffs it against the
 * current working tree copy of `<file>`.
 */
export async function gitDiffSpec(options: GitDiffOptions): Promise<DiffReport> {
  const base = assertSafeGitBaseRef(options.base ?? 'HEAD');
  const repoDir = options.repo ?? '.';
  const timeoutMs = options.timeoutMs ?? 15_000;

  const { repoRealPath, posixRelPath, absoluteFilePath } = resolveSafeRepoFile(
    repoDir,
    options.file
  );

  const objectSpec = `${base}:${posixRelPath}`;
  let gitResult;
  try {
    gitResult = await runCommandBounded('git', ['--no-pager', 'show', objectSpec], {
      cwd: repoRealPath,
      maxBytes: MAX_SPEC_BYTES,
      timeoutMs
    });
  } catch (err) {
    if (err instanceof SchemaGuardError) {
      throw err;
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new SchemaGuardError('GIT_ERROR', `Failed to execute git: ${msg}`, { cause: err });
  }

  if (gitResult.exitCode !== 0) {
    const detail = gitResult.stderr.trim() || `git show exited with code ${String(gitResult.exitCode)}`;
    throw new SchemaGuardError(
      'GIT_ERROR',
      `Failed to read baseline "${objectSpec}" from git: ${detail}`
    );
  }

  const oldSpec = parseSpecContent(gitResult.stdout, objectSpec);
  const newSpec = loadSpecFromFile(absoluteFilePath);
  newSpec.source = posixRelPath;

  return diffSpecs(oldSpec, newSpec);
}
