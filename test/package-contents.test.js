const assert = require('node:assert/strict');
const test = require('node:test');

const { REQUIRED_FILES, checkPackageFiles } = require('../scripts/check-vsix-contents');

test('the shipped file set passes the VSIX allowlist', () => {
  const files = [
    ...REQUIRED_FILES,
    'README.ja.md',
    'media/icon.svg',
    'docs/DESIGN.md',
    'docs/DESIGN.ja.md',
    'docs/COMPARISON.md',
    'docs/COMPARISON.ja.md'
  ];
  assert.deepEqual(checkPackageFiles(files), { unexpected: [], missing: [] });
});

test('repository tooling files are rejected from the VSIX', () => {
  const result = checkPackageFiles([
    ...REQUIRED_FILES,
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/CLAUDE.md',
    'graphify-out/graph.json',
    'examples/Cargo.toml',
    'test/fixtures/e0382.json'
  ]);
  assert.deepEqual(result.unexpected, [
    'AGENTS.md',
    'CLAUDE.md',
    '.claude/CLAUDE.md',
    'graphify-out/graph.json',
    'examples/Cargo.toml',
    'test/fixtures/e0382.json'
  ]);
  assert.deepEqual(result.missing, []);
});

test('missing runtime files are reported', () => {
  const result = checkPackageFiles(['package.json', 'README.md']);
  assert.deepEqual(result.unexpected, []);
  assert.deepEqual(result.missing, ['extension.js', 'bin/rust-lens.js', 'CHANGELOG.md', 'LICENSE', 'media/icon.png']);
});
