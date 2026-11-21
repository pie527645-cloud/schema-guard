import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

function fail(msg) {
  process.stderr.write(`[lint] ERROR: ${msg}\n`);
  process.exit(1);
}

function runTsc(projectFile) {
  const result = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', projectFile], {
    cwd: rootDir,
    shell: false,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    fail(`TypeScript check failed for ${projectFile}`);
  }
}

function walkFiles(dir, collected = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'dist-test' ||
      entry.name === '.git'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, collected);
    } else {
      collected.push(full);
    }
  }
  return collected;
}

// 1. TypeScript strict typecheck for both prod and test configs
runTsc('tsconfig.json');
runTsc('tsconfig.test.json');

// 2. Source & security hygiene checks
const forbiddenRegexToken = '[' + '\\s\\S]*?';
const allFiles = walkFiles(rootDir);

for (const filePath of allFiles) {
  const rel = path.relative(rootDir, filePath).split(path.sep).join('/');
  if (rel === 'package-lock.json') continue;
  const ext = path.extname(filePath);
  if (!['.ts', '.mjs', '.js', '.md', '.yml', '.yaml'].includes(ext)) continue;

  const content = fs.readFileSync(filePath, 'utf8');
  if (content.includes(forbiddenRegexToken)) {
    fail(`Forbidden backtracking regex pattern found in ${rel}`);
  }
  if ((rel.startsWith('src/') || rel.startsWith('tests/')) && /shell\s*:\s*true/.test(content)) {
    fail(`Forbidden "shell: true" found in ${rel}`);
  }
}

// 3. CLI entrypoint shebang + realpathSync check
const cliSource = fs.readFileSync(path.join(rootDir, 'src', 'cli.ts'), 'utf8');
if (!cliSource.startsWith('#!/usr/bin/env node\n') && !cliSource.startsWith('#!/usr/bin/env node\r\n')) {
  fail('src/cli.ts must start with #!/usr/bin/env node shebang');
}
if (!cliSource.includes('realpathSync')) {
  fail('src/cli.ts must use fs.realpathSync for canonical main-module detection');
}

// 4. Explicit test list check (zero globs, every tests/*.test.ts included)
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const testScript = pkg.scripts?.test ?? '';
if (testScript.includes('*')) {
  fail(`package.json "test" script must not contain wildcard globs: ${testScript}`);
}

const testsDir = path.join(rootDir, 'tests');
if (fs.existsSync(testsDir)) {
  const testFiles = fs
    .readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.ts'))
    .sort();
  for (const tf of testFiles) {
    const compiledRel = `dist-test/tests/${tf.replace(/\.ts$/, '.js')}`;
    if (!testScript.includes(compiledRel)) {
      fail(`Compiled test file "${compiledRel}" is missing from package.json "test" script`);
    }
  }
}

process.stdout.write('[lint] All TypeScript and security hygiene checks passed.\n');
