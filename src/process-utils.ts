import { type ChildProcess, spawn } from 'node:child_process';
import { SchemaGuardError } from './types.js';

/**
 * Tokenizes a command line string into `[executable, ...args]` without invoking a shell.
 * Supports single quotes ('...'), double quotes ("..." with \" and \\" escaping while
 * preserving literal backslashes in Windows paths such as C:\Users\...), and rejects
 * control characters or unclosed quotes.
 */
export function tokenizeCommand(commandLine: string): { executable: string; args: string[] } {
  if (/[\x00\r\n]/.test(commandLine)) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      'Command string must not contain NUL or newline characters.'
    );
  }

  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < commandLine.length; i++) {
    const ch = commandLine[i]!;

    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === '"') {
      if (ch === '\\') {
        const next = commandLine[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i += 1;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    // Unquoted state
    if (ch === ' ' || ch === '\t') {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }

    inToken = true;
    current += ch;
  }

  if (quote !== null) {
    throw new SchemaGuardError(
      'INVALID_USAGE',
      `Unclosed ${quote} quote in command string: ${commandLine}`
    );
  }

  if (inToken) {
    tokens.push(current);
  }

  if (tokens.length === 0 || tokens[0]!.trim().length === 0) {
    throw new SchemaGuardError('INVALID_USAGE', 'Command string must not be empty.');
  }

  return {
    executable: tokens[0]!,
    args: tokens.slice(1)
  };
}

/**
 * Cleanly terminates a child process and its entire descendant tree across Windows and Linux/macOS.
 */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }

  if (child.exitCode !== null && child.signalCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          stdio: 'ignore',
          windowsHide: true
        });
        const fallbackTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore if already exited
          }
          resolve();
        }, 2500);
        fallbackTimer.unref();

        killer.once('error', () => {
          clearTimeout(fallbackTimer);
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
          resolve();
        });
        killer.once('close', () => {
          clearTimeout(fallbackTimer);
          resolve();
        });
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore
        }
        resolve();
      }
    });
    return;
  }

  // POSIX: kill negative PID process group if spawned detached, plus direct child kill
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Process group might not exist or already exited
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited
  }

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1000);
      t.unref();
      child.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

export interface BoundedCommandResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

/**
 * Executes a binary with `shell: false`, enforcing a maximum stdout byte cap and timeout,
 * and reaping the process tree on timeout or overflow.
 */
export async function runCommandBounded(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    maxBytes: number;
    timeoutMs: number;
  }
): Promise<BoundedCommandResult> {
  return await new Promise<BoundedCommandResult>((resolve, reject) => {
    let settled = false;
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;

    let child: ChildProcess;
    try {
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      });
    } catch (err) {
      reject(err);
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void killProcessTree(child).finally(() => {
        reject(
          new SchemaGuardError(
            'GIT_ERROR',
            `Command "${executable}" timed out after ${options.timeoutMs} ms.`
          )
        );
      });
    }, options.timeoutMs);
    timer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.maxBytes) {
        settled = true;
        clearTimeout(timer);
        void killProcessTree(child).finally(() => {
          reject(
            new SchemaGuardError(
              'FILE_TOO_LARGE',
              `Command output exceeded the ${options.maxBytes} byte maximum limit.`
            )
          );
        });
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (stderrBytes < 64 * 1024) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.byteLength;
      }
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void killProcessTree(child).finally(() => {
        reject(err);
      });
    });

    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8')
      });
    });
  });
}
