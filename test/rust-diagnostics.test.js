const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
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

function buildReportFor(diagnostic) {
  return _test.buildReport([diagnostic], {
    cwd: '/tmp/rust-lens',
    exitCode: 101,
    command: 'cargo check --message-format=json',
    rawMessageCount: 1,
    includeWarnings: false
  }).text;
}

function buildReportFromFixture(name) {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
  const messages = _test.parseCargoJsonMessages(raw);
  const diagnostics = _test.extractDiagnostics(messages, false);
  return _test.buildReport(diagnostics, {
    cwd: '/tmp/rust-lens',
    exitCode: 101,
    command: 'cargo check --message-format=json',
    rawMessageCount: messages.length,
    includeWarnings: false
  }).text;
}

function span(fileName, line, column, label, text, isPrimary = false) {
  return {
    file_name: fileName,
    line_start: line,
    column_start: column,
    is_primary: isPrimary,
    label,
    text: [{ line_start: line, text }]
  };
}

function diagnostic(code, message, spans, children = []) {
  return {
    level: 'error',
    code: { code },
    message,
    spans,
    children
  };
}

function diagnosticDeduper() {
  return _test.deduplicateDiagnostics
    || _test.dedupeDiagnostics
    || _test.uniqueDiagnostics;
}

function dedupeIfExported(diagnostics) {
  const dedupe = diagnosticDeduper();
  if (!dedupe) {
    // TODO: Replace this helper with the extension's exported diagnostic de-duplication function when one exists.
    return diagnostics;
  }
  return dedupe(diagnostics);
}

const diagnostics = [
  {
    code: 'E0373',
    diagnostic: diagnostic(
      'E0373',
      'closure may outlive the current function, but it borrows `name`',
      [
        span(
          'examples/e0373.rs',
          4,
          24,
          'may outlive borrowed value `name`',
          '    std::thread::spawn(|| {',
          true
        )
      ],
      [
        {
          level: 'help',
          message: 'to force the closure to take ownership of `name`, use the `move` keyword',
          spans: [
            span(
              'examples/e0373.rs',
              4,
              24,
              'use `move` here',
              '    std::thread::spawn(move || {'
            )
          ]
        }
      ]
    )
  },
  {
    code: 'E0277',
    diagnostic: diagnostic(
      'E0277',
      '`T` doesn\'t implement `Debug`',
      [
        span(
          'examples/e0277.rs',
          2,
          22,
          '`T` cannot be formatted using `{:?}` because it does not implement `Debug`',
          '    println!("{:?}", value);',
          true
        )
      ],
      [
        {
          level: 'help',
          message: 'consider restricting type parameter `T` with trait `Debug`',
          spans: [
            span(
              'examples/e0277.rs',
              1,
              17,
              'required bound can be added here',
              'fn print_debug<T: std::fmt::Debug>(value: T) {'
            )
          ]
        }
      ]
    )
  },
  {
    code: 'E0106',
    diagnostic: diagnostic(
      'E0106',
      'missing lifetime specifier',
      [
        span(
          'examples/e0106.rs',
          1,
          16,
          'expected named lifetime parameter',
          'fn label() -> &str {',
          true
        )
      ],
      [
        {
          level: 'help',
          message: 'consider using the `static` lifetime',
          spans: [
            span(
              'examples/e0106.rs',
              1,
              16,
              'lifetime could be added here',
              'fn label() -> &str {'
            )
          ]
        }
      ]
    )
  },
  {
    code: 'E0499',
    diagnostic: diagnostic(
      'E0499',
      'cannot borrow `count` as mutable more than once at a time',
      [
        span(
          'examples/e0499.rs',
          4,
          18,
          'second mutable borrow occurs here',
          '    let second = &mut count;',
          true
        ),
        span(
          'examples/e0499.rs',
          3,
          17,
          'first mutable borrow occurs here',
          '    let first = &mut count;'
        ),
        span(
          'examples/e0499.rs',
          5,
          6,
          'first borrow later used here',
          '    *first += 1;'
        )
      ]
    )
  },
  {
    code: 'E0505',
    diagnostic: diagnostic(
      'E0505',
      'cannot move out of `name` because it is borrowed',
      [
        span(
          'examples/e0505.rs',
          4,
          17,
          'move out of `name` occurs here',
          '    let moved = name;',
          true
        ),
        span(
          'examples/e0505.rs',
          3,
          20,
          'borrow of `name` occurs here',
          '    let borrowed = &name;'
        ),
        span(
          'examples/e0505.rs',
          5,
          20,
          'borrow later used here',
          '    println!("{}", borrowed);'
        )
      ]
    )
  },
  {
    code: 'E0597',
    diagnostic: diagnostic(
      'E0597',
      '`value` does not live long enough',
      [
        span(
          'examples/e0597.rs',
          7,
          5,
          '`value` dropped here while still borrowed',
          '    }',
          true
        ),
        span(
          'examples/e0597.rs',
          6,
          20,
          'borrowed value does not live long enough',
          '        borrowed = &value;'
        ),
        span(
          'examples/e0597.rs',
          9,
          20,
          'borrow later used here',
          '    println!("{}", borrowed);'
        )
      ]
    )
  },
  {
    code: 'E0716',
    diagnostic: diagnostic(
      'E0716',
      'temporary value dropped while borrowed',
      [
        span(
          'examples/e0716.rs',
          2,
          20,
          'creates a temporary value which is freed while still in use',
          '    let borrowed = String::from("temporary").as_str();',
          true
        ),
        span(
          'examples/e0716.rs',
          3,
          20,
          'borrow later used here',
          '    println!("{}", borrowed);'
        )
      ]
    )
  }
];

test('known ownership diagnostics include ASCII timelines and best fixes', () => {
  for (const { code, diagnostic: rustDiagnostic } of diagnostics) {
    const report = buildReportFor(rustDiagnostic);

    assert.match(report, new RegExp(`Issue 1: error\\[${code}\\]`));
    assert.match(report, /ASCII:/);
    assert.match(report, /Timeline from rustc spans:/);
    assert.match(report, /Best fixes:/);
  }
});

test('cargo JSON fixture reports include the timeline and fix guidance', () => {
  const report = buildReportFromFixture('e0502.jsonl');

  assert.match(report, /Issue 1: error\[E0502\]/);
  assert.match(report, /Borrow ASCII:/);
  assert.match(report, /Timeline from rustc spans:/);
  assert.match(report, /examples\/e0502\.rs:4:5/);
  assert.match(report, /Best fixes:/);
});

test('duplicate diagnostics can be deduplicated when an export exists', () => {
  const duplicate = diagnostics.find((entry) => entry.code === 'E0499').diagnostic;
  const input = [duplicate, duplicate];
  const output = dedupeIfExported(input);

  if (diagnosticDeduper()) {
    assert.equal(output.length, 1);
  } else {
    assert.equal(output.length, 2);
  }
});
