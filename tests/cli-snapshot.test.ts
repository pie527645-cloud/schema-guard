import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli, tokenizeCommand } from '../src/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const distCliPath = path.join(repoRoot, 'dist', 'cli.js');

test('CLI snapshot: spawns mock stdio MCP server, handles pagination, and writes deterministic sorted JSON', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-snap-'));
  try {
    const mockServerPath = path.join(tmpDir, 'mock-mcp-server.mjs');
    const snapshotOutPath = path.join(tmpDir, 'mcp-snapshot.json');

    const mockServerCode = `
import readline from 'node:readline';

let initializedNotified = false;
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const msg = JSON.parse(trimmed);

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-mcp', version: '0.1.0' }
      }
    }) + '\\n');
    return;
  }

  if (msg.method === 'notifications/initialized') {
    initializedNotified = true;
    return;
  }

  if (msg.method === 'tools/list') {
    if (!initializedNotified) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32002, message: 'notifications/initialized not received' }
      }) + '\\n');
      return;
    }

    if (!msg.params?.cursor) {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'zeta_tool',
              inputSchema: {
                required: ['z', 'a'],
                type: 'object',
                properties: { z: { type: 'string' }, a: { type: 'number' } }
              },
              description: 'Zeta tool'
            }
          ],
          nextCursor: 'page-2'
        }
      }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              description: 'Alpha tool',
              name: 'alpha_tool',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } } }
            }
          ]
        }
      }) + '\\n');
    }
  }
});

setInterval(() => {}, 10000);
`;
    fs.writeFileSync(mockServerPath, mockServerCode, 'utf8');

    const cmdString = `"${process.execPath}" "${mockServerPath}"`;
    let outMsg = '';
    const exitCode = await runCli(
      ['snapshot', '--stdio', cmdString, '--out', snapshotOutPath, '--timeout', '10000'],
      { stdout: (s) => (outMsg += s) }
    );

    assert.equal(exitCode, 0);
    assert.ok(outMsg.includes('2 tool(s)'));
    assert.ok(fs.existsSync(snapshotOutPath));

    const writtenRaw = fs.readFileSync(snapshotOutPath, 'utf8');
    const parsed = JSON.parse(writtenRaw) as {
      tools: Array<{ name: string; inputSchema: { required?: string[] } }>;
    };
    assert.equal(parsed.tools.length, 2);
    assert.equal(parsed.tools[0]?.name, 'alpha_tool');
    assert.equal(parsed.tools[1]?.name, 'zeta_tool');
    assert.deepEqual(parsed.tools[1]?.inputSchema.required, ['a', 'z']);
    assert.deepEqual(Object.keys(parsed.tools[1]!), ['description', 'inputSchema', 'name']);

    // Hang server timeout test: exits 2 and reaps hung server
    const hangServerPath = path.join(tmpDir, 'hang-server.mjs');
    fs.writeFileSync(hangServerPath, 'setInterval(() => {}, 10000);\n', 'utf8');
    let errMsg = '';
    const hangCode = await runCli(
      [
        'snapshot',
        '--stdio',
        `"${process.execPath}" "${hangServerPath}"`,
        '--out',
        path.join(tmpDir, 'never.json'),
        '--timeout',
        '250'
      ],
      { stderr: (s) => (errMsg += s) }
    );
    assert.equal(hangCode, 2);
    assert.ok(errMsg.includes('timed out'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tokenizeCommand & CLI symlink entrypoint: preserves Windows paths and runs via symlink/junction (--help)', () => {
  const tokenized = tokenizeCommand(
    '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\dev\\server.js --label \'two words\''
  );
  assert.equal(tokenized.executable, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(tokenized.args, ['C:\\Users\\dev\\server.js', '--label', 'two words']);

  assert.ok(fs.existsSync(distCliPath), 'Expected dist/cli.js to exist from build step');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-link-'));
  try {
    let linkedCliPath: string;
    const directSymlink = path.join(tmpDir, 'schema-guard-link.js');

    try {
      fs.symlinkSync(distCliPath, directSymlink, 'file');
      linkedCliPath = directSymlink;
    } catch {
      const junctionDir = path.join(tmpDir, 'dist-junction');
      fs.symlinkSync(path.dirname(distCliPath), junctionDir, 'junction');
      linkedCliPath = path.join(junctionDir, 'cli.js');
    }

    const output = execFileSync(process.execPath, [linkedCliPath, '--help'], {
      encoding: 'utf8',
      windowsHide: true
    });

    assert.ok(output.includes('@pie527645-cloud/schema-guard'));
    assert.ok(output.includes('schema-guard diff'));
    assert.ok(output.includes('schema-guard snapshot'));
    assert.ok(output.includes('schema-guard git-diff'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI snapshot: preserves multi-byte UTF-8 across split stdout and stderr pipe chunks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-utf8-'));
  try {
    const mockServerPath = path.join(tmpDir, 'split-utf8-mcp.mjs');
    const snapshotOutPath = path.join(tmpDir, 'utf8-snapshot.json');

    const mockServerCode = `
import readline from 'node:readline';

const mode = process.argv[2];
if (mode === 'stderr-fail') {
  const errBytes = Buffer.from('致命的エラー🚀発生\\n', 'utf8');
  const rocketIdx = errBytes.indexOf(0xf0);
  process.stderr.write(errBytes.subarray(0, rocketIdx + 2));
  setTimeout(() => {
    process.stderr.write(errBytes.subarray(rocketIdx + 2), () => {
      process.exit(1);
    });
  }, 25);
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const msg = JSON.parse(trimmed);

    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'utf8-mcp', version: '0.1.0' }
        }
      }) + '\\n');
      return;
    }

    if (msg.method === 'tools/list') {
      const frame = Buffer.from(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'utf8_contract_tool',
              description: '契約スナップショット🚀検証',
              inputSchema: { type: 'object', properties: { note: { type: 'string' } } }
            }
          ]
        }
      }), 'utf8');
      const rocketIdx = frame.indexOf(0xf0);
      process.stdout.write(frame.subarray(0, rocketIdx + 2));
      setTimeout(() => {
        process.stdout.write(frame.subarray(rocketIdx + 2), () => {
          process.exit(0);
        });
      }, 25);
    }
  });
  setInterval(() => {}, 10000);
}
`;
    fs.writeFileSync(mockServerPath, mockServerCode, 'utf8');

    const okCmd = `"${process.execPath}" "${mockServerPath}" stdout-ok`;
    const okExit = await runCli([
      'snapshot',
      '--stdio',
      okCmd,
      '--out',
      snapshotOutPath,
      '--timeout',
      '10000'
    ]);
    assert.equal(okExit, 0);
    const writtenRaw = fs.readFileSync(snapshotOutPath, 'utf8');
    assert.equal(writtenRaw.includes('\uFFFD'), false);
    const parsed = JSON.parse(writtenRaw) as {
      tools: Array<{ name: string; description?: string }>;
    };
    assert.equal(parsed.tools.length, 1);
    assert.equal(parsed.tools[0]?.description, '契約スナップショット🚀検証');

    const failCmd = `"${process.execPath}" "${mockServerPath}" stderr-fail`;
    let errMsg = '';
    const failExit = await runCli(
      ['snapshot', '--stdio', failCmd, '--out', path.join(tmpDir, 'unused.json'), '--timeout', '5000'],
      { stderr: (s) => (errMsg += s) }
    );
    assert.equal(failExit, 2);
    assert.ok(errMsg.includes('致命的エラー🚀発生'), `Unexpected stderr message: ${errMsg}`);
    assert.equal(errMsg.includes('\uFFFD'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
