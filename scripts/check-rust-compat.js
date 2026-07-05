'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const Module = require('node:module');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {},
      window: {},
      StatusBarAlignment: { Left: 1 }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require('../extension');
Module._load = originalLoad;

function run(command, args, options = {}) {
  return cp.spawnSync(command, args, {
    cwd: options.cwd || repoRoot,
    encoding: 'utf8',
    env: Object.assign({}, process.env, options.env || {}),
    shell: false
  });
}

function checkRustupOverride() {
  if (process.env.RUST_LENS_SKIP_RUSTUP_OVERRIDE === '1') return;
  if (process.env.RUSTUP_TOOLCHAIN) {
    console.log(`rustup override: skipped because RUSTUP_TOOLCHAIN=${process.env.RUSTUP_TOOLCHAIN} is set`);
    return;
  }

  const fixtureDir = path.join(repoRoot, 'fixtures', 'toolchain-override');
  const result = run('rustup', ['show', 'active-toolchain'], { cwd: fixtureDir });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^stable-/);
  assert.match(result.stdout, /rust-toolchain\.toml/);
  console.log(`rustup override: ${result.stdout.trim()}`);
}

function checkIteratorMoveJson() {
  const manifestPath = path.join(repoRoot, 'examples', 'Cargo.toml');
  const result = run('cargo', [
    'check',
    '--manifest-path',
    manifestPath,
    '--bin',
    'iterator-move',
    '--message-format=json'
  ], {
    env: { CARGO_TERM_COLOR: 'never' }
  });

  assert.notEqual(result.status, 0, 'iterator-move example should fail with E0382');
  const raw = `${result.stdout}\n${result.stderr}`;

  const messages = _test.parseCargoJsonMessages(raw);
  const diagnostics = _test.extractDiagnostics(messages, false);
  const iteratorMove = diagnostics.find((diagnostic) => _test.isForLoopIteratorMoveDiagnostic(diagnostic));

  assert.ok(iteratorMove, 'expected a parsed E0382 for-loop iterator move diagnostic');

  const report = _test.buildReport([iteratorMove], {
    cwd: repoRoot,
    exitCode: result.status,
    command: 'cargo check --manifest-path examples/Cargo.toml --bin iterator-move --message-format=json',
    rawMessageCount: messages.length,
    includeWarnings: false
  }).text;

  assert.match(report, /The for loop moved users by calling `\.into_iter\(\)`/);
  assert.match(report, /for user in &users/);
  assert.match(report, /for user in &mut users/);
  console.log(`rustc JSON diagnostics: ${diagnostics.length} parsed, iterator move explained`);
}

checkRustupOverride();
checkIteratorMoveJson();
