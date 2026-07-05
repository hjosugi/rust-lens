#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      workspace: {},
      window: {},
      languages: {},
      commands: {},
      StatusBarAlignment: { Left: 1 }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { _test } = require('../extension');
Module._load = originalLoad;

function usage(exitCode) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write([
    'Usage:',
    '  rust-lens explain [--json] [cargo-output.jsonl ...]',
    '',
    'Reads cargo/rustc JSON diagnostics from files or stdin and writes a Rust Ownership Lens report.',
    ''
  ].join('\n'));
  process.exit(exitCode);
}

function readInput(files) {
  if (files.length === 0) return fs.readFileSync(0, 'utf8');
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') usage(command ? 0 : 1);
  if (command !== 'explain') usage(1);

  const json = rest.includes('--json');
  const files = rest.filter((arg) => arg !== '--json');
  const raw = readInput(files);
  const messages = _test.parseCargoJsonMessages(raw);
  const diagnostics = _test.prioritizeDiagnostics(
    _test.deduplicateDiagnostics(_test.extractDiagnostics(messages, true)),
    200
  );
  const report = _test.buildReport(diagnostics, {
    cwd: process.cwd(),
    exitCode: 'input',
    command: files.length > 0 ? `rust-lens explain ${files.map((file) => path.relative(process.cwd(), file)).join(' ')}` : 'rust-lens explain < stdin',
    rawMessageCount: messages.length,
    includeWarnings: true,
    mode: 'CLI'
  });

  if (json) {
    process.stdout.write(`${JSON.stringify({ diagnostics, report: report.text }, null, 2)}\n`);
  } else {
    process.stdout.write(`${report.text}\n`);
  }
}

main(process.argv.slice(2));
