const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
const match = workflow.match(/notes="\$\(awk -v v="\$VERSION" '([\s\S]*?)' CHANGELOG\.md\)"/);
assert.ok(match, 'release workflow must contain the notes extraction program');
const notes = (input, version) => execFileSync('awk', ['-v', `v=${version}`, match[1]], {
  input,
  encoding: 'utf8',
}).trim();

test('release workflow reads existing plain version headings', () => {
  assert.equal(notes('## Unreleased\nfuture\n## 0.2.0 - 2026-09-24\nshipped\n## 0.1.0\nolder\n', '0.2.0'), 'shipped');
});

test('release workflow reads bracketed Keep a Changelog headings', () => {
  assert.equal(notes('## [0.2.1] - 2026-10-24\nsecurity update\n## 0.2.0\nolder\n', '0.2.1'), 'security update');
});

test('release workflow matches version dots literally and leaves missing notes empty', () => {
  assert.equal(notes('## 0x2x1\nwrong version\n', '0.2.1'), '');
});

test('the released v0.2.1 changelog yields its security notes', () => {
  const input = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  assert.match(notes(input, '0.2.1'), /reviewed dependencies/);
});
