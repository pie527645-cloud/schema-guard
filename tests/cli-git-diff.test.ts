import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/index.js';

function gitExec(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true
  });
}

test('CLI git-diff: diffs working tree file against HEAD in a real git repo and blocks unsafe --base / --file', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-git-'));
  try {
    gitExec(tmpRepo, ['init']);
    gitExec(tmpRepo, ['config', 'user.name', 'Schema Guard Test']);
    gitExec(tmpRepo, ['config', 'user.email', 'none']);

    const specsDir = path.join(tmpRepo, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    const specFile = path.join(specsDir, 'contract.json');

    fs.writeFileSync(
      specFile,
      JSON.stringify(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['active', 'paused'] }
          }
        },
        null,
        2
      )
    );

    gitExec(tmpRepo, ['add', 'specs/contract.json']);
    gitExec(tmpRepo, ['commit', '-m', 'Initial contract']);

    // 1. Modify with non-breaking change (also test Windows backslash normalization in --file) -> exit 0
    fs.writeFileSync(
      specFile,
      JSON.stringify(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['active', 'paused', 'archived'] },
            limit: { type: 'integer', default: 50 }
          }
        },
        null,
        2
      )
    );

    let outJson = '';
    const passCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', 'specs\\contract.json', '--base', 'HEAD', '--format', 'json'],
      { stdout: (s) => (outJson += s) }
    );
    assert.equal(passCode, 0);
    const passReport = JSON.parse(outJson) as { summary: { breaking: number; nonBreaking: number } };
    assert.equal(passReport.summary.breaking, 0);
    assert.equal(passReport.summary.nonBreaking, 2);

    // 2. Modify with breaking change (remove enum value "paused") -> exit 1
    fs.writeFileSync(
      specFile,
      JSON.stringify(
        {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string' },
            status: { type: 'string', enum: ['active'] }
          }
        },
        null,
        2
      )
    );

    let breakOut = '';
    const failCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', 'specs/contract.json', '--base', 'HEAD', '--format', 'pretty'],
      { stdout: (s) => (breakOut += s) }
    );
    assert.equal(failCode, 1);
    assert.ok(breakOut.includes('[BREAKING]'));

    // 3. Flag injection guard: reject leading-dash --base
    let errOut = '';
    const dashBaseCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', 'specs/contract.json', '--base=-p'],
      { stderr: (s) => (errOut += s) }
    );
    assert.equal(dashBaseCode, 2);
    assert.ok(errOut.includes('leading "-" is forbidden'));

    // 4. Reject newline/colon in --base
    errOut = '';
    const colonBaseCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', 'specs/contract.json', '--base', 'HEAD:evil'],
      { stderr: (s) => (errOut += s) }
    );
    assert.equal(colonBaseCode, 2);

    // 5. Path traversal guard: reject "../" and absolute path in --file
    errOut = '';
    const traversalCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', '../escape.json', '--base', 'HEAD'],
      { stderr: (s) => (errOut += s) }
    );
    assert.equal(traversalCode, 2);
    assert.ok(errOut.includes('..'));

    errOut = '';
    const absCode = await runCli(
      ['git-diff', '--repo', tmpRepo, '--file', specFile, '--base', 'HEAD'],
      { stderr: (s) => (errOut += s) }
    );
    assert.equal(absCode, 2);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
