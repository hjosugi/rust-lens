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

test('E0382 for-loop iterator move gets dedicated explanation and quick fixes', () => {
  const diagnostic = {
    level: 'error',
    code: { code: 'E0382' },
    message: 'borrow of moved value: `users`',
    spans: [
      {
        file_name: 'examples/iterator-move.rs',
        line_start: 13,
        column_start: 22,
        is_primary: true,
        label: 'value borrowed here after move',
        text: [{ line_start: 13, text: '    println!("{:?}", users);' }]
      },
      {
        file_name: 'examples/iterator-move.rs',
        line_start: 9,
        column_start: 17,
        is_primary: false,
        label: '`users` moved due to this implicit call to `.into_iter()`',
        text: [{ line_start: 9, text: '    for user in users {' }]
      }
    ],
    children: [
      {
        level: 'note',
        message: '`into_iter` takes ownership of the receiver `self`, which moves `users`',
        spans: []
      },
      {
        level: 'help',
        message: 'consider iterating over a slice of the `Vec<User>` contents to avoid moving into the `for` loop',
        spans: [
          {
            file_name: 'examples/iterator-move.rs',
            line_start: 9,
            column_start: 17,
            is_primary: true,
            suggested_replacement: '&',
            text: [{ line_start: 9, text: '    for user in users {' }]
          }
        ]
      }
    ]
  };

  assert.equal(_test.isForLoopIteratorMoveDiagnostic(diagnostic), true);
  assert.deepEqual(_test.parseMovableForLoopLine('    for user in users {'), {
    item: 'user',
    collection: 'users',
    collectionStart: 16,
    collectionEnd: 21
  });

  const report = _test.buildReport([diagnostic], {
    cwd: '/tmp/rust-lens',
    exitCode: 101,
    command: 'cargo check --message-format=json',
    rawMessageCount: 1,
    includeWarnings: false
  }).text;

  assert.match(report, /The for loop moved users by calling `\.into_iter\(\)`/);
  assert.match(report, /for user in &users/);
  assert.match(report, /for user in &mut users/);
  assert.match(report, /iter\(\)/);
  assert.match(report, /iter_mut\(\)/);
  assert.match(report, /Quick Fix: change `for user in users` to `for user in &users`/);
  assert.doesNotMatch(report, /users was moved, then used again/);
});

test('plain E0382 keeps the generic moved-value explanation', () => {
  const diagnostic = {
    level: 'error',
    code: { code: 'E0382' },
    message: 'borrow of moved value: `name`',
    spans: [
      {
        file_name: 'src/main.rs',
        line_start: 4,
        column_start: 20,
        is_primary: true,
        label: 'value borrowed here after move',
        text: [{ line_start: 4, text: '    println!("{}", name);' }]
      },
      {
        file_name: 'src/main.rs',
        line_start: 3,
        column_start: 18,
        is_primary: false,
        label: 'value moved here',
        text: [{ line_start: 3, text: '    let other = name;' }]
      }
    ],
    children: []
  };

  assert.equal(_test.isForLoopIteratorMoveDiagnostic(diagnostic), false);

  const report = _test.buildReport([diagnostic], {
    cwd: '/tmp/rust-lens',
    exitCode: 101,
    command: 'cargo check --message-format=json',
    rawMessageCount: 1,
    includeWarnings: false
  }).text;

  assert.match(report, /name was moved, then used again/);
  assert.doesNotMatch(report, /Iterator choices/);
});
