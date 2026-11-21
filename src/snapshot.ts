import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { killProcessTree, tokenizeCommand } from './process-utils.js';
import {
  canonicalize,
  compareStringsLex,
  hasOwn,
  isObjectRecord,
  sanitizeStructure
} from './safe-object.js';
import {
  MAX_SPEC_BYTES,
  type McpSnapshotDocument,
  type McpToolDefinition,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SchemaGuardError
} from './types.js';

export interface SnapshotOptions {
  stdioCommand: string;
  outPath?: string;
  timeoutMs?: number;
  cwd?: string;
}

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;
const MAX_PAGINATION_PAGES = 100;

/**
 * Produces a canonical, deterministically sorted MCP snapshot object:
 * - `tools` sorted lexicographically by `name`
 * - all nested keys sorted lexicographically
 */
export function canonicalizeMcpSnapshot(rawTools: readonly unknown[]): McpSnapshotDocument {
  const sanitizedTools: McpToolDefinition[] = rawTools.map((raw, idx) => {
    const clean = sanitizeStructure(raw);
    if (!isObjectRecord(clean) || typeof clean['name'] !== 'string' || clean['name'].trim() === '') {
      throw new SchemaGuardError(
        'SNAPSHOT_ERROR',
        `MCP server returned an invalid tool definition at index ${idx} (missing string "name").`
      );
    }
    return canonicalize(clean) as McpToolDefinition;
  });

  sanitizedTools.sort((a, b) => compareStringsLex(a.name, b.name));

  return {
    tools: sanitizedTools
  };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: unknown;
}

/**
 * Spawns a live stdio MCP server (`shell: false`), executes the standard
 * `initialize` -> `notifications/initialized` -> `tools/list` handshake,
 * cleanly reaps the child process tree on Windows/Linux, and optionally
 * writes the deterministic canonical JSON snapshot to `outPath`.
 */
export async function captureMcpSnapshot(options: SnapshotOptions): Promise<McpSnapshotDocument> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Invalid --timeout "${String(options.timeoutMs)}": must be an integer between 1 and 300000 ms.`
    );
  }

  const { executable, args } = tokenizeCommand(options.stdioCommand);

  let child: ChildProcess | null = null;
  let timeoutHandle: NodeJS.Timeout | null = null;
  let timedOut = false;

  try {
    child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });

    const proc = child;
    let totalStdoutBytes = 0;
    let lineBuffer = '';
    let stderrText = '';
    let spawnErr: Error | null = null;
    let closedEarly = false;
    let exitCode: number | null = null;

    const pendingWaiters = new Map<
      number,
      {
        resolve: (result: unknown) => void;
        reject: (err: Error) => void;
      }
    >();

    const failAllPending = (err: Error): void => {
      for (const [, waiter] of pendingWaiters) {
        waiter.reject(err);
      }
      pendingWaiters.clear();
    };

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      failAllPending(
        new SchemaGuardError(
          'SNAPSHOT_ERROR',
          `MCP stdio snapshot timed out after ${timeoutMs} ms.`
        )
      );
      void killProcessTree(proc);
    }, timeoutMs);
    timeoutHandle.unref();

    proc.once('error', (err) => {
      spawnErr = err;
      failAllPending(
        new SchemaGuardError(
          'SNAPSHOT_ERROR',
          `Failed to spawn MCP server "${executable}": ${err.message}`,
          { cause: err }
        )
      );
    });

    const stderrDecoder = new StringDecoder('utf8');
    const stdoutDecoder = new StringDecoder('utf8');
    let stderrFlushed = false;
    let stdoutFlushed = false;
    let stdoutLimitExceeded = false;

    const handleRawJsonRpcLine = (rawLine: string): void => {
      if (rawLine.length === 0) return;

      let parsed: JsonRpcResponse;
      try {
        parsed = JSON.parse(rawLine) as JsonRpcResponse;
      } catch {
        // Ignore non-JSON diagnostic lines if any; wait for JSON-RPC frames
        return;
      }

      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'number') {
        const waiter = pendingWaiters.get(parsed.id);
        if (waiter) {
          pendingWaiters.delete(parsed.id);
          if (hasOwn(parsed, 'error') && parsed.error !== undefined) {
            waiter.reject(
              new SchemaGuardError(
                'SNAPSHOT_ERROR',
                `MCP server returned JSON-RPC error for request #${parsed.id}: ${JSON.stringify(parsed.error)}`
              )
            );
          } else {
            waiter.resolve(parsed.result);
          }
        }
      }
    };

    const drainLineBuffer = (flushRemainder: boolean): void => {
      let newlineIdx = lineBuffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const rawLine = lineBuffer.slice(0, newlineIdx).trim();
        lineBuffer = lineBuffer.slice(newlineIdx + 1);
        newlineIdx = lineBuffer.indexOf('\n');
        handleRawJsonRpcLine(rawLine);
      }
      if (flushRemainder && lineBuffer.length > 0) {
        const trailingLine = lineBuffer.trim();
        lineBuffer = '';
        handleRawJsonRpcLine(trailingLine);
      }
    };

    const flushStderr = (): void => {
      if (stderrFlushed) return;
      stderrFlushed = true;
      if (stderrText.length < 16 * 1024) {
        stderrText += stderrDecoder.end();
      }
    };

    const flushStdout = (): void => {
      if (stdoutFlushed) return;
      stdoutFlushed = true;
      if (stdoutLimitExceeded) return;
      lineBuffer += stdoutDecoder.end();
      drainLineBuffer(true);
    };

    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderrText.length < 16 * 1024) {
        stderrText += stderrDecoder.write(chunk);
      }
    });

    proc.stderr?.once('end', flushStderr);

    proc.stdout?.on('data', (chunk: Buffer) => {
      totalStdoutBytes += chunk.byteLength;
      if (totalStdoutBytes > MAX_SPEC_BYTES) {
        stdoutLimitExceeded = true;
        failAllPending(
          new SchemaGuardError(
            'FILE_TOO_LARGE',
            `MCP server stdout exceeded the ${MAX_SPEC_BYTES} byte (5 MB) limit.`
          )
        );
        void killProcessTree(proc);
        return;
      }

      lineBuffer += stdoutDecoder.write(chunk);
      drainLineBuffer(false);
    });

    proc.stdout?.once('end', flushStdout);

    proc.once('close', (code) => {
      flushStderr();
      flushStdout();
      closedEarly = true;
      exitCode = code;
      if (!timedOut && pendingWaiters.size > 0) {
        const detail = stderrText.trim() ? ` Stderr: ${stderrText.trim()}` : '';
        failAllPending(
          new SchemaGuardError(
            'SNAPSHOT_ERROR',
            `MCP server exited prematurely (code ${String(code)}) before completing handshake.${detail}`
          )
        );
      }
    });

    const sendRequest = async (id: number, method: string, params: Record<string, unknown>): Promise<unknown> => {
      if (spawnErr) {
        throw new SchemaGuardError(
          'SNAPSHOT_ERROR',
          `Failed to spawn MCP server "${executable}": ${(spawnErr as Error).message}`,
          { cause: spawnErr }
        );
      }
      if (closedEarly) {
        const detail = stderrText.trim() ? ` Stderr: ${stderrText.trim()}` : '';
        throw new SchemaGuardError(
          'SNAPSHOT_ERROR',
          `MCP server already exited (code ${String(exitCode)}) before "${method}".${detail}`
        );
      }

      const payload = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
      return await new Promise<unknown>((resolve, reject) => {
        pendingWaiters.set(id, { resolve, reject });
        proc.stdin?.write(payload, 'utf8', (writeErr) => {
          if (writeErr) {
            pendingWaiters.delete(id);
            reject(
              new SchemaGuardError(
                'SNAPSHOT_ERROR',
                `Failed writing "${method}" to MCP server stdin: ${writeErr.message}`,
                { cause: writeErr }
              )
            );
          }
        });
      });
    };

    const sendNotification = async (method: string, params?: Record<string, unknown>): Promise<void> => {
      const frame: Record<string, unknown> = { jsonrpc: '2.0', method };
      if (params !== undefined) {
        frame['params'] = params;
      }
      const payload = `${JSON.stringify(frame)}\n`;
      await new Promise<void>((resolve, reject) => {
        proc.stdin?.write(payload, 'utf8', (writeErr) => {
          if (writeErr) {
            reject(
              new SchemaGuardError(
                'SNAPSHOT_ERROR',
                `Failed writing notification "${method}" to MCP server stdin: ${writeErr.message}`,
                { cause: writeErr }
              )
            );
            return;
          }
          resolve();
        });
      });
    };

    // Step 1: initialize
    await sendRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION
      }
    });

    // Step 2: notifications/initialized
    await sendNotification('notifications/initialized');

    // Step 3: tools/list (supporting pagination via nextCursor)
    const collectedTools: unknown[] = [];
    let cursor: string | undefined;
    let nextReqId = 2;

    for (let page = 0; page < MAX_PAGINATION_PAGES; page++) {
      const params: Record<string, unknown> = cursor !== undefined ? { cursor } : {};
      const result = await sendRequest(nextReqId++, 'tools/list', params);

      if (!isObjectRecord(result) || !Array.isArray(result['tools'])) {
        throw new SchemaGuardError(
          'SNAPSHOT_ERROR',
          'MCP server returned invalid tools/list result: missing "tools" array.'
        );
      }

      collectedTools.push(...(result['tools'] as unknown[]));

      const nextCursor = result['nextCursor'];
      if (typeof nextCursor === 'string' && nextCursor.length > 0) {
        cursor = nextCursor;
      } else {
        break;
      }
    }

    try {
      proc.stdin?.end();
    } catch {
      // Ignore stdin close errors
    }

    const snapshot = canonicalizeMcpSnapshot(collectedTools);
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

    if (Buffer.byteLength(serialized, 'utf8') > MAX_SPEC_BYTES) {
      throw new SchemaGuardError(
        'FILE_TOO_LARGE',
        `Serialized MCP snapshot exceeds the 5 MB (${MAX_SPEC_BYTES} bytes) limit.`
      );
    }

    if (options.outPath !== undefined) {
      const targetPath = path.resolve(options.outPath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, serialized, 'utf8');
    }

    return snapshot;
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
    if (child !== null) {
      await killProcessTree(child);
    }
  }
}
