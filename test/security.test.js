const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

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

function configWith(values, inspected) {
  return {
    get(key, defaultValue) {
      return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : defaultValue;
    },
    inspect(key) {
      return inspected[key];
    }
  };
}

test('untrusted workspaces ignore workspace cargo command and args', () => {
  const config = configWith(
    {
      cargoCommand: 'malicious-tool',
      cargoArgs: ['check', '--offline']
    },
    {
      cargoCommand: {
        defaultValue: 'cargo',
        globalValue: 'cargo',
        workspaceValue: 'malicious-tool'
      },
      cargoArgs: {
        defaultValue: ['check', '--message-format=json'],
        workspaceFolderValue: ['check', '--offline']
      }
    }
  );

  assert.deepEqual(_test.getCargoRunConfig(config, false), {
    cargoCommand: 'cargo',
    cargoArgs: ['check', '--message-format=json'],
    usedTrustedFallback: true
  });
});

test('trusted workspaces can use configured cargo command and args', () => {
  const config = configWith(
    {
      cargoCommand: '/opt/rust/bin/cargo',
      cargoArgs: ['clippy', '--message-format', 'json-diagnostic-short']
    },
    {}
  );

  assert.deepEqual(_test.getCargoRunConfig(config, true), {
    cargoCommand: '/opt/rust/bin/cargo',
    cargoArgs: ['clippy', '--message-format', 'json-diagnostic-short'],
    usedTrustedFallback: false
  });
});

test('message format detection accepts cargo json forms', () => {
  assert.equal(_test.hasJsonMessageFormat(['check', '--message-format=json']), true);
  assert.equal(_test.hasJsonMessageFormat(['check', '--message-format=json-diagnostic-rendered-ansi']), true);
  assert.equal(_test.hasJsonMessageFormat(['check', '--message-format', 'json-diagnostic-short']), true);
  assert.equal(_test.hasJsonMessageFormat(['check']), false);
});

test('Windows spawn command resolution finds cargo.exe without shell expansion', () => {
  const env = {
    Path: 'C:\\Rust\\.cargo\\bin;C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD'
  };
  const exists = (candidate) => candidate === 'C:\\Rust\\.cargo\\bin\\cargo.EXE';

  assert.equal(
    _test.resolveCommandForSpawn('cargo', env, 'win32', exists),
    'C:\\Rust\\.cargo\\bin\\cargo.EXE'
  );
});
