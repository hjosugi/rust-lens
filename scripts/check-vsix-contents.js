#!/usr/bin/env node
'use strict';

// Checks the files `vsce package` would ship against an allowlist, so that
// repository tooling (agent instructions, graph caches, fixtures, examples)
// never reaches the Marketplace and nothing the extension needs goes missing.

const path = require('node:path');

const REQUIRED_FILES = [
  'package.json',
  'extension.js',
  'bin/rust-lens.js',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  'media/icon.png'
];

const ALLOWED_PATTERNS = [
  /^package\.json$/,
  /^extension\.js$/,
  /^bin\/rust-lens\.js$/,
  /^README(\.ja)?\.md$/,
  /^CHANGELOG\.md$/,
  /^LICENSE$/,
  /^media\/icon\.(png|svg)$/,
  /^docs\/[A-Z]+(\.ja)?\.md$/
];

function checkPackageFiles(files) {
  const normalized = files.map((file) => file.split(path.sep).join('/'));
  return {
    unexpected: normalized.filter((file) => !ALLOWED_PATTERNS.some((pattern) => pattern.test(file))),
    missing: REQUIRED_FILES.filter((file) => !normalized.includes(file))
  };
}

async function listPackageFiles(cwd) {
  const { listFiles, PackageManager } = require('@vscode/vsce');
  return listFiles({ cwd, packageManager: PackageManager.Npm });
}

async function main() {
  const root = path.resolve(__dirname, '..');
  const files = await listPackageFiles(root);
  const { unexpected, missing } = checkPackageFiles(files);
  for (const file of unexpected) {
    console.error(`unexpected file in VSIX: ${file} (exclude it in .vscodeignore or allow it in scripts/check-vsix-contents.js)`);
  }
  for (const file of missing) {
    console.error(`required file missing from VSIX: ${file}`);
  }
  if (unexpected.length > 0 || missing.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(`VSIX contents OK (${files.length} files)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { ALLOWED_PATTERNS, REQUIRED_FILES, checkPackageFiles };
