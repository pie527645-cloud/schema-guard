import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  INFORMATION_URI,
  runCli,
  type SarifLog
} from '../src/index.js';

test('CLI diff & formatters: emits valid SARIF 2.1.0, Markdown, JSON, Pretty and honors --fail-on exit codes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-sarif-'));
  try {
    const oldFile = path.join(tmpDir, 'old.json');
    const newFile = path.join(tmpDir, 'new.json');
    const dangerousOnlyFile = path.join(tmpDir, 'dangerous.json');

    fs.writeFileSync(
      oldFile,
      JSON.stringify({
        tools: [
          {
            name: 'calc',
            description: 'Calculator',
            inputSchema: {
              type: 'object',
              properties: {
                precision: { type: 'integer', maximum: 16 }
              }
            }
          }
        ]
      })
    );

    fs.writeFileSync(
      newFile,
      JSON.stringify({
        tools: [
          {
            name: 'calc',
            description: 'Scientific calculator',
            inputSchema: {
              type: 'object',
              properties: {
                precision: { type: 'integer', maximum: 8 },
                mode: { type: 'string' }
              }
            }
          }
        ]
      })
    );

    fs.writeFileSync(
      dangerousOnlyFile,
      JSON.stringify({
        tools: [
          {
            name: 'calc',
            description: 'Calculator',
            inputSchema: {
              type: 'object',
              properties: {
                precision: { type: 'integer', maximum: 16 },
                mode: { type: 'string' }
              }
            }
          }
        ]
      })
    );

    // 1. SARIF 2.1.0 output + exit code 1 on default --fail-on breaking
    let stdoutBuf = '';
    let stderrBuf = '';
    const codeBreaking = await runCli(
      ['diff', oldFile, newFile, '--format', 'sarif'],
      {
        stdout: (s) => {
          stdoutBuf += s;
        },
        stderr: (s) => {
          stderrBuf += s;
        }
      }
    );

    assert.equal(codeBreaking, 1);
    assert.equal(stderrBuf, '');

    const sarif = JSON.parse(stdoutBuf) as SarifLog;
    assert.equal(sarif.version, '2.1.0');
    assert.equal(sarif.$schema, 'https://json.schemastore.org/sarif-2.1.0.json');
    assert.equal(sarif.runs.length, 1);

    const run = sarif.runs[0]!;
    assert.equal(run.tool.driver.informationUri, INFORMATION_URI);
    assert.equal(run.tool.driver.informationUri, 'https://github.com/pie527645-cloud/schema-guard');
    assert.equal(run.results.length, 3);

    const levels = new Set(run.results.map((r) => r.level));
    assert.ok(levels.has('error'));
    assert.ok(levels.has('warning'));
    assert.ok(levels.has('note'));

    for (const res of run.results) {
      assert.ok(res.ruleIndex >= 0 && res.ruleIndex < run.tool.driver.rules.length);
      assert.equal(run.tool.driver.rules[res.ruleIndex]?.id, res.ruleId);
      assert.equal(res.locations[0]?.physicalLocation.region.startLine, 1);
    }

    // 2. Dangerous-only file passes --fail-on breaking (0) and fails --fail-on dangerous (1)
    assert.equal(
      await runCli(['diff', oldFile, dangerousOnlyFile, '--fail-on', 'breaking'], {
        stdout: () => {}
      }),
      0
    );
    assert.equal(
      await runCli(['diff', oldFile, dangerousOnlyFile, '--fail-on', 'dangerous'], {
        stdout: () => {}
      }),
      1
    );

    // 3. --fail-on none returns exit code 0 with Markdown formatting
    stdoutBuf = '';
    const codeNone = await runCli(
      ['diff', oldFile, newFile, '--format', 'markdown', '--fail-on', 'none'],
      { stdout: (s) => (stdoutBuf += s) }
    );
    assert.equal(codeNone, 0);
    assert.ok(stdoutBuf.includes('## Schema Guard Contract Diff'));
    assert.ok(stdoutBuf.includes('| `BREAKING` |'));

    // 4. Invalid usage / missing file returns exit code 2
    stderrBuf = '';
    const codeMissing = await runCli(
      ['diff', path.join(tmpDir, 'nonexistent.json'), newFile],
      { stderr: (s) => (stderrBuf += s) }
    );
    assert.equal(codeMissing, 2);
    assert.ok(stderrBuf.includes('FILE_READ_ERROR'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
