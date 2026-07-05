'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const path = require('path');
const os = require('os');

const KNOWN_CODES = new Set([
  'E0106', // missing lifetime specifier
  'E0382', // use of moved value
  'E0499', // mutable borrow more than once
  'E0502', // mutable + immutable borrow overlap
  'E0505', // move out because borrowed
  'E0515', // return reference to local data
  'E0597', // borrowed value does not live long enough
  'E0716', // temporary value dropped while borrowed
]);

const SIMPLE_HINTS = [
  {
    name: '&mut',
    test: (line) => /&\s*mut\b/.test(line),
    markdown: [
      '**Rust Ownership Lens**',
      '',
      '`&mut T` means an exclusive mutable borrow.',
      '',
      'While this borrow is alive, other borrows of the same value usually cannot overlap.',
      '',
      'ASCII:',
      '```text',
      'value:  ---- mutable borrow ----+',
      'other:        borrow requested X |',
      '```'
    ].join('\n')
  },
  {
    name: '&',
    test: (line) => /(^|[^&])&[A-Za-z_][A-Za-z0-9_]*(\b|\[|\.)/.test(line),
    markdown: [
      '**Rust Ownership Lens**',
      '',
      '`&T` means an immutable borrow.',
      '',
      'You can have many immutable borrows, but mutation of the same value must wait until those borrows end.',
      '',
      'ASCII:',
      '```text',
      'value:  ---- read borrow ----+',
      'push():       write needed X |',
      '```'
    ].join('\n')
  },
  {
    name: 'for-in',
    test: (line) => /\bfor\s+\w+\s+in\s+(?!&)([A-Za-z_][A-Za-z0-9_]*)\b/.test(line),
    markdown: [
      '**Rust Ownership Lens**',
      '',
      '`for item in collection` usually calls `into_iter()` and may move the collection.',
      '',
      'Use `for item in &collection` when you only need to read.',
      '',
      'ASCII:',
      '```text',
      'collection --into_iter()--> loop',
      'collection = moved',
      '```'
    ].join('\n')
  },
  {
    name: 'clone',
    test: (line) => /\.clone\s*\(\s*\)/.test(line),
    markdown: [
      '**Rust Ownership Lens**',
      '',
      '`clone()` creates a new owned value.',
      '',
      'This can be correct, but it is often better to borrow with `&value` if the callee only needs to read.',
      '',
      'Rule of thumb: prefer borrow first, clone only the small data you really need.'
    ].join('\n')
  },
  {
    name: 'tokio-spawn',
    test: (line) => /\b(tokio::spawn|task::spawn|spawn)\s*\(\s*async\b/.test(line),
    markdown: [
      '**Rust Ownership Lens**',
      '',
      '`spawn(async { ... })` may run after the current function returns.',
      '',
      'So borrowed local values often fail with lifetime errors. Use `async move` and move owned data, or share data with `Arc<T>` when needed.',
      '',
      'ASCII:',
      '```text',
      'function frame:  [local data] ---- drops here',
      'spawned task:             uses data later X',
      '```'
    ].join('\n')
  }
];

let outputChannel;
let statusBarItem;
let lastReportText = '';
let lastReportHtml = '';
let lastDiagnostics = [];
let viewProvider;

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Rust Ownership Lens');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(rust) Rust Lens';
  statusBarItem.command = 'rustOwnershipLens.runCheck';
  statusBarItem.tooltip = 'Run Rust Ownership Lens';
  statusBarItem.show();

  viewProvider = new RustLensViewProvider(context.extensionUri);

  context.subscriptions.push(
    outputChannel,
    statusBarItem,
    vscode.window.registerWebviewViewProvider('rustOwnershipLens.view', viewProvider),
    vscode.commands.registerCommand('rustOwnershipLens.runCheck', () => runCargoCheck()),
    vscode.commands.registerCommand('rustOwnershipLens.explainSelection', () => explainSelection()),
    vscode.commands.registerCommand('rustOwnershipLens.showPanel', async () => {
      await vscode.commands.executeCommand('rustOwnershipLens.view.focus');
      viewProvider.update(lastReportHtml || welcomeHtml(), lastReportText || welcomeText());
    }),
    vscode.commands.registerCommand('rustOwnershipLens.copyLastExplanation', async () => {
      const text = lastReportText || welcomeText();
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Rust Ownership Lens explanation copied.');
    }),
    vscode.commands.registerCommand('rustOwnershipLens.insertExample', () => insertExampleError())
  );

  registerHoverProvider(context);
  viewProvider.update(welcomeHtml(), welcomeText());
}

function deactivate() {}

async function runCargoCheck() {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage('Open a Rust workspace folder first.');
    return;
  }

  const config = vscode.workspace.getConfiguration('rustOwnershipLens');
  const cargoCommand = config.get('cargoCommand', 'cargo');
  const cargoArgs = config.get('cargoArgs', ['check', '--message-format=json']);
  const includeWarnings = config.get('includeWarnings', false);
  const maxDiagnostics = config.get('maxDiagnostics', 20);

  statusBarItem.text = '$(sync~spin) Rust Lens';
  outputChannel.clear();
  outputChannel.appendLine(`Running: ${cargoCommand} ${cargoArgs.join(' ')}`);
  outputChannel.appendLine(`Workspace: ${folder.uri.fsPath}`);
  outputChannel.show(true);
  viewProvider.update(loadingHtml(folder.uri.fsPath, cargoCommand, cargoArgs), 'Running cargo check...');

  try {
    const result = await runProcess(cargoCommand, cargoArgs, folder.uri.fsPath);
    outputChannel.appendLine('--- cargo stdout ---');
    outputChannel.appendLine(result.stdout || '(empty)');
    if (result.stderr) {
      outputChannel.appendLine('--- cargo stderr ---');
      outputChannel.appendLine(result.stderr);
    }

    const messages = parseCargoJsonMessages(result.stdout + os.EOL + result.stderr);
    const diagnostics = extractDiagnostics(messages, includeWarnings)
      .filter((diagnostic) => includeWarnings || diagnostic.level === 'error')
      .slice(0, maxDiagnostics);

    lastDiagnostics = diagnostics;
    const report = buildReport(diagnostics, {
      cwd: folder.uri.fsPath,
      exitCode: result.exitCode,
      command: `${cargoCommand} ${cargoArgs.join(' ')}`,
      rawMessageCount: messages.length,
      includeWarnings,
    });

    lastReportText = report.text;
    lastReportHtml = report.html;
    outputChannel.appendLine('--- Rust Ownership Lens report ---');
    outputChannel.appendLine(report.text);
    viewProvider.update(report.html, report.text);
    statusBarItem.text = diagnostics.length > 0 ? `$(warning) Rust Lens ${diagnostics.length}` : '$(check) Rust Lens';

    const knownCount = diagnostics.filter((d) => KNOWN_CODES.has(getCode(d))).length;
    if (diagnostics.length === 0) {
      vscode.window.showInformationMessage('Rust Ownership Lens: cargo check produced no parsed diagnostics.');
    } else if (knownCount === 0) {
      vscode.window.showInformationMessage(`Rust Ownership Lens: ${diagnostics.length} diagnostics found. No known ownership error code matched yet.`);
    } else {
      vscode.window.showInformationMessage(`Rust Ownership Lens: ${knownCount} ownership/lifetime diagnostics explained.`);
    }
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    const text = [
      'Rust Ownership Lens failed to run cargo check.',
      '',
      `Error: ${message}`,
      '',
      'Check that Rust and Cargo are installed and that the workspace has Cargo.toml.'
    ].join('\n');
    lastReportText = text;
    lastReportHtml = textReportHtml('Run failed', text);
    outputChannel.appendLine(text);
    viewProvider.update(lastReportHtml, lastReportText);
    statusBarItem.text = '$(error) Rust Lens';
    vscode.window.showErrorMessage(`Rust Ownership Lens failed: ${message}`);
  }
}

function getWorkspaceFolder() {
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (folder) return folder;
  }
  if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
    return vscode.workspace.workspaceFolders[0];
  }
  return undefined;
}

function runProcess(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(command, args, {
      cwd,
      shell: process.platform === 'win32',
      env: Object.assign({}, process.env, { CARGO_TERM_COLOR: 'never' })
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

function parseCargoJsonMessages(raw) {
  const messages = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch (_) {
      // Ignore human output or partial lines.
    }
  }
  return messages;
}

function extractDiagnostics(messages, includeWarnings) {
  const diagnostics = [];
  for (const msg of messages) {
    let diagnostic;
    if (msg && msg.reason === 'compiler-message' && msg.message) {
      diagnostic = msg.message;
    } else if (msg && (msg.$message_type === 'diagnostic' || msg.message || msg.code || msg.spans)) {
      diagnostic = msg;
    }

    if (!diagnostic) continue;
    if (!diagnostic.level) continue;
    if (diagnostic.level !== 'error' && !(includeWarnings && diagnostic.level === 'warning')) continue;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

function buildReport(diagnostics, meta) {
  const known = diagnostics.filter((d) => KNOWN_CODES.has(getCode(d)));
  const unknown = diagnostics.filter((d) => !KNOWN_CODES.has(getCode(d)));

  const parts = [];
  parts.push('Rust Ownership Lens');
  parts.push('===================');
  parts.push('');
  parts.push(`Command: ${meta.command}`);
  parts.push(`Workspace: ${meta.cwd}`);
  parts.push(`cargo exit code: ${meta.exitCode}`);
  parts.push(`parsed JSON messages: ${meta.rawMessageCount}`);
  parts.push(`diagnostics shown: ${diagnostics.length}`);
  parts.push(`known ownership/lifetime diagnostics: ${known.length}`);
  parts.push('');

  if (diagnostics.length === 0) {
    parts.push('No diagnostics were parsed. If cargo check printed human output, make sure --message-format=json is enabled.');
  } else if (known.length === 0) {
    parts.push('No known ownership/lifetime error code was found yet. Showing compact diagnostics below.');
    for (const d of diagnostics) {
      parts.push('');
      parts.push(formatCompactDiagnostic(d));
    }
  } else {
    for (let i = 0; i < known.length; i += 1) {
      parts.push(renderDiagnosticExplanation(known[i], i + 1));
      parts.push('');
    }

    if (unknown.length > 0) {
      parts.push('Other diagnostics not deeply explained yet');
      parts.push('----------------------------------------');
      for (const d of unknown.slice(0, 5)) {
        parts.push(formatCompactDiagnostic(d));
        parts.push('');
      }
    }
  }

  const text = parts.join('\n').trimEnd();
  return {
    text,
    html: textReportHtml('Rust Ownership Lens', text)
  };
}

function renderDiagnosticExplanation(diagnostic, index) {
  const code = getCode(diagnostic);
  const message = diagnostic.message || '(no message)';
  const primary = getPrimarySpan(diagnostic);
  const variable = guessVariable(diagnostic);
  const file = primary ? `${primary.file_name}:${primary.line_start}:${primary.column_start}` : '(unknown file)';
  const events = buildEvents(diagnostic);
  const source = sourceSnippet(primary);

  const lines = [];
  lines.push(`Issue ${index}: error[${code}]`);
  lines.push('-'.repeat(Math.max(18, `Issue ${index}: error[${code}]`.length)));
  lines.push(`File: ${file}`);
  lines.push(`Message: ${message}`);
  if (variable) lines.push(`Main value: ${variable}`);
  lines.push('');

  if (source) {
    lines.push('Source near the primary span:');
    lines.push('```rust');
    lines.push(source);
    lines.push('```');
    lines.push('');
  }

  const template = templateForDiagnostic(code, variable, diagnostic, events);
  lines.push(template.trimEnd());

  const suggestions = collectSuggestions(diagnostic, code, variable);
  if (suggestions.length > 0) {
    lines.push('');
    lines.push('rustc suggestions / hints:');
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  return lines.join('\n');
}

function templateForDiagnostic(code, variable, diagnostic, events) {
  const v = variable || 'this value';
  const timeline = renderEventTimeline(events, v);

  switch (code) {
    case 'E0106':
      return [
        'Problem:',
        '  A returned or stored reference has no clear owner, so Rust asks where its lifetime comes from.',
        '',
        'Lifetime ASCII:',
        '```text',
        'fn f(...) -> &str',
        '             ^--- borrowed from what? X',
        '',
        'input:  ----- lives here ----->',
        'output: needs to point at something that lives long enough',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Return owned data instead: `String` instead of `&str`.',
        '  B. If the reference comes from an input, tie them: `fn f<\'a>(x: &\'a T) -> &\'a str`.',
        '  C. Do not return references to values created inside the function.',
        '  D. For structs holding references, consider owning the data instead.'
      ].join('\n');

    case 'E0382':
      return [
        'Problem:',
        `  ${v} was moved, then used again.`,
        '',
        'Ownership ASCII:',
        '```text',
        `${v} owns data`,
        `${v} ---- move ----> new owner`,
        `${v} = invalid`,
        '',
        `use ${v} later: X`,
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Pass a reference with `&value` if the callee only reads.',
        '  B. Reorder code so the last use happens before the move.',
        '  C. Clone only the small piece you really need.',
        '  D. Change the function to borrow instead of taking ownership.'
      ].join('\n');

    case 'E0499':
      return [
        'Problem:',
        `  ${v} has two overlapping mutable borrows.`,
        '',
        'Borrow ASCII:',
        '```text',
        `${v}:  ---- mutable borrow #1 ----+`,
        `${v}:        mutable borrow #2 X  |`,
        '                                  |',
        'Only one mutable borrow can be active at a time.',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Finish using the first `&mut` before creating the second one.',
        '  B. Split the code into smaller scopes.',
        '  C. Use methods like `split_at_mut` when you need two disjoint mutable parts.',
        '  D. Avoid `RefCell` or `Mutex` unless you truly need runtime borrowing or shared mutable state.'
      ].join('\n');

    case 'E0502':
      return [
        'Problem:',
        `  ${v} is borrowed in one way, then borrowed in a conflicting way before the first borrow ends.`,
        '',
        'Borrow ASCII:',
        '```text',
        `${v}:  ---- immutable borrow ----+`,
        `${v}:        mutable borrow X    |`,
        '                                |',
        'The read borrow and write borrow overlap.',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Use the immutable reference before mutating the original value.',
        '  B. Move the mutation after the last use of the immutable borrow.',
        '  C. Clone only the needed field if the value must outlive the borrow.',
        '  D. Split the scope with `{ ... }` so the borrow ends earlier.'
      ].join('\n');

    case 'E0505':
      return [
        'Problem:',
        `  ${v} is moved while it is still borrowed.`,
        '',
        'Ownership / borrow ASCII:',
        '```text',
        `${v}:  ---- borrowed ----+`,
        `${v}:        move X      |`,
        '                         |',
        'The borrow must end before the move.',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Use the borrow first, then move the value.',
        '  B. Put the borrow in a smaller scope.',
        '  C. Change the later operation to borrow instead of move.',
        '  D. Return owned data instead of a reference if the value must escape.'
      ].join('\n');

    case 'E0515':
      return [
        'Problem:',
        '  The function returns a reference to data owned inside the function.',
        '',
        'Lifetime ASCII:',
        '```text',
        'fn frame starts',
        '+------------------------------+',
        '| local value owns the data     |',
        '| return reference ----+        |',
        '+----------------------|-------+',
        '                       v',
        'local value is dropped here',
        'returned reference points to dead data X',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Return owned data, for example `String` instead of `&str`.',
        '  B. Return a reference that comes from an input parameter.',
        '  C. Store the data outside the function so it outlives the returned reference.',
        '  D. Do not try to fix this only by adding a lifetime annotation.'
      ].join('\n');

    case 'E0597':
      return [
        'Problem:',
        `  ${v} does not live long enough for the reference that uses it.`,
        '',
        'Lifetime ASCII:',
        '```text',
        `${v}:      alive ----+`,
        'reference:       needs data -------->',
        '                 ^',
        '                 data drops too early X',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Move the owned value to a wider scope.',
        '  B. Return owned data instead of a borrowed reference.',
        '  C. Avoid borrowing from a temporary value.',
        '  D. For async tasks, move owned data into the task with `async move`.'
      ].join('\n');

    case 'E0716':
      return [
        'Problem:',
        '  A temporary value is borrowed, but the temporary is dropped too soon.',
        '',
        'Temporary lifetime ASCII:',
        '```text',
        'temporary value:  alive --+',
        'borrow:                needs data ---->',
        '                       ^',
        '                       temporary dropped X',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Store the temporary in a named variable.',
        '  B. Make the owner live longer than the reference.',
        '  C. Return owned data instead of a reference to a temporary.'
      ].join('\n');

    default:
      return [
        'Problem:',
        `  ${diagnostic.message || 'Unknown Rust diagnostic'}`,
        '',
        timeline || 'No timeline available yet.'
      ].join('\n');
  }
}

function buildEvents(diagnostic) {
  const events = [];
  const primary = getPrimarySpan(diagnostic);
  if (primary) {
    events.push({
      line: primary.line_start,
      column: primary.column_start,
      kind: 'primary error',
      label: primary.label || diagnostic.message || 'primary diagnostic span',
      file: primary.file_name
    });
  }

  const children = Array.isArray(diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    const spans = Array.isArray(child.spans) ? child.spans : [];
    for (const span of spans) {
      if (!span || !span.file_name || !span.line_start) continue;
      const label = span.label || child.message || child.level || 'related span';
      events.push({
        line: span.line_start,
        column: span.column_start || 1,
        kind: classifySpanLabel(label),
        label,
        file: span.file_name
      });
    }
  }

  const allSpans = Array.isArray(diagnostic.spans) ? diagnostic.spans : [];
  for (const span of allSpans) {
    if (!span || !span.file_name || !span.line_start || span.is_primary) continue;
    events.push({
      line: span.line_start,
      column: span.column_start || 1,
      kind: classifySpanLabel(span.label || 'related span'),
      label: span.label || 'related span',
      file: span.file_name
    });
  }

  const seen = new Set();
  return events
    .filter((event) => {
      const key = `${event.file}:${event.line}:${event.column}:${event.label}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (a.file || '').localeCompare(b.file || '') || a.line - b.line || a.column - b.column);
}

function classifySpanLabel(label) {
  const lower = String(label || '').toLowerCase();
  if (lower.includes('borrow')) return 'borrow';
  if (lower.includes('move') || lower.includes('moved')) return 'move';
  if (lower.includes('dropped') || lower.includes('drop')) return 'drop';
  if (lower.includes('use') || lower.includes('used')) return 'use';
  if (lower.includes('return')) return 'return';
  return 'related';
}

function renderEventTimeline(events, variable) {
  if (!events || events.length === 0) {
    return 'Timeline from rustc spans:\n```text\n(no related spans were available in JSON output)\n```';
  }

  const width = Math.max(20, Math.min(60, events.length * 10));
  const rows = [];
  rows.push('Timeline from rustc spans:');
  rows.push('```text');

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const pos = events.length === 1 ? 0 : Math.floor((i / (events.length - 1)) * (width - 1));
    const markerLine = ' '.repeat(pos) + markerForKind(event.kind);
    const pathLine = '-'.repeat(Math.max(0, pos)) + markerForKind(event.kind) + '-'.repeat(Math.max(0, width - pos - 1));
    rows.push(`line ${String(event.line).padStart(4, ' ')}: ${event.kind}`);
    rows.push(`          ${event.label}`);
    rows.push(`          ${pathLine}`);
    rows.push(`          ${markerLine}`);
  }

  if (events.length > 1) {
    rows.push('');
    rows.push(`Legend for ${variable}: B=borrow, M=move, U=use, D=drop, R=return, X=error/conflict`);
  }
  rows.push('```');
  return rows.join('\n');
}

function markerForKind(kind) {
  if (kind === 'borrow') return 'B';
  if (kind === 'move') return 'M';
  if (kind === 'drop') return 'D';
  if (kind === 'use') return 'U';
  if (kind === 'return') return 'R';
  if (kind === 'primary error') return 'X';
  return '*';
}

function sourceSnippet(span) {
  if (!span || !Array.isArray(span.text) || span.text.length === 0) return '';
  return span.text.map((entry) => {
    const lineNo = entry.line_start || span.line_start;
    return `${String(lineNo).padStart(4, ' ')} | ${entry.text}`;
  }).join('\n');
}

function collectSuggestions(diagnostic, code, variable) {
  const suggestions = [];
  const children = Array.isArray(diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    if (child && child.message && !suggestions.includes(child.message)) suggestions.push(child.message);
    const spans = Array.isArray(child.spans) ? child.spans : [];
    for (const span of spans) {
      if (span && span.suggested_replacement) {
        suggestions.push(`replace code at ${span.file_name}:${span.line_start} with \`${span.suggested_replacement}\``);
      }
    }
  }

  if (suggestions.length === 0) {
    const v = variable || 'value';
    if (code === 'E0382') suggestions.push(`try passing \`&${v}\` if only read access is needed`);
    if (code === 'E0502') suggestions.push('move the mutation after the last use of the immutable borrow');
    if (code === 'E0499') suggestions.push('end the first mutable borrow before creating the second mutable borrow');
    if (code === 'E0515') suggestions.push('return owned data instead of a reference to local data');
  }

  return suggestions.slice(0, 8);
}

function formatCompactDiagnostic(diagnostic) {
  const code = getCode(diagnostic) || 'no-code';
  const primary = getPrimarySpan(diagnostic);
  const location = primary ? `${primary.file_name}:${primary.line_start}:${primary.column_start}` : '(unknown location)';
  return [`[${diagnostic.level || 'diagnostic'} ${code}] ${diagnostic.message || ''}`, `  at ${location}`].join('\n');
}

function getCode(diagnostic) {
  if (!diagnostic) return '';
  if (typeof diagnostic.code === 'string') return diagnostic.code;
  if (diagnostic.code && typeof diagnostic.code.code === 'string') return diagnostic.code.code;
  return '';
}

function getPrimarySpan(diagnostic) {
  const spans = Array.isArray(diagnostic && diagnostic.spans) ? diagnostic.spans : [];
  return spans.find((s) => s && s.is_primary) || spans[0];
}

function guessVariable(diagnostic) {
  const candidates = [];
  const message = diagnostic && diagnostic.message ? diagnostic.message : '';
  const fromBackticks = [...message.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
  candidates.push(...fromBackticks);

  const code = getCode(diagnostic);
  const spans = [];
  if (Array.isArray(diagnostic.spans)) spans.push(...diagnostic.spans);
  if (Array.isArray(diagnostic.children)) {
    for (const child of diagnostic.children) {
      if (Array.isArray(child.spans)) spans.push(...child.spans);
      if (child.message) {
        const childVars = [...child.message.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
        candidates.push(...childVars);
      }
    }
  }

  for (const span of spans) {
    if (span && span.label) {
      const vars = [...span.label.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter(Boolean);
      candidates.push(...vars);
    }
    if (span && Array.isArray(span.text)) {
      for (const text of span.text) {
        const line = text.text || '';
        const simplePatterns = [
          /cannot borrow\s+([A-Za-z_][A-Za-z0-9_]*)/,
          /borrow of moved value:\s*([A-Za-z_][A-Za-z0-9_]*)/,
          /use of moved value:\s*([A-Za-z_][A-Za-z0-9_]*)/,
          /&\s*mut\s+([A-Za-z_][A-Za-z0-9_]*)/,
          /&\s*([A-Za-z_][A-Za-z0-9_]*)/,
          /([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*(push|insert|clear|remove)/,
        ];
        for (const pattern of simplePatterns) {
          const match = line.match(pattern);
          if (match && match[1]) candidates.push(match[1]);
        }
      }
    }
  }

  const filtered = candidates
    .map((s) => String(s).trim())
    .filter((s) => s && !s.includes(' ') && !s.includes('::'))
    .filter((s) => !['String', 'Vec', 'Option', 'Result', 'Copy', 'Clone'].includes(s));

  if (code === 'E0716') return filtered[0] || 'temporary value';
  return mostCommon(filtered) || filtered[0] || '';
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

async function explainSelection() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rust') {
    vscode.window.showWarningMessage('Open a Rust file and select code first.');
    return;
  }

  const selection = editor.selection;
  let code = editor.document.getText(selection);
  if (!code.trim()) {
    const line = editor.document.lineAt(editor.selection.active.line);
    code = line.text;
  }

  const text = buildHeuristicExplanation(code, editor.document.fileName, editor.selection.active.line + 1);
  lastReportText = text;
  lastReportHtml = textReportHtml('Rust Ownership Lens: Selection', text);
  outputChannel.clear();
  outputChannel.appendLine(text);
  outputChannel.show(true);
  viewProvider.update(lastReportHtml, lastReportText);
  await vscode.commands.executeCommand('rustOwnershipLens.view.focus');
}

function buildHeuristicExplanation(code, fileName, lineNumber) {
  const lines = [];
  lines.push('Rust Ownership Lens: heuristic explanation');
  lines.push('==========================================');
  lines.push('');
  lines.push(`File: ${fileName}:${lineNumber}`);
  lines.push('');
  lines.push('Selected code:');
  lines.push('```rust');
  lines.push(code.trimEnd());
  lines.push('```');
  lines.push('');
  lines.push('This explanation is heuristic. For the real compiler answer, run `Rust Ownership Lens: Run cargo check`.');
  lines.push('');

  const findings = heuristicFindings(code);
  if (findings.length === 0) {
    lines.push('No obvious ownership pattern found in the selected code.');
    lines.push('');
    lines.push('Try selecting a larger block around the error, or run cargo check.');
  } else {
    for (const finding of findings) {
      lines.push(finding);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

function heuristicFindings(code) {
  const findings = [];
  const trimmed = code.trim();

  const forMove = trimmed.match(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(?!&)([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (forMove) {
    const item = forMove[1];
    const collection = forMove[2];
    findings.push([
      'Possible move in `for` loop:',
      '```text',
      `${collection} --into_iter()--> loop`,
      `${item} receives each element by value`,
      `${collection} = moved after the loop`,
      '```',
      '',
      'If you need to use the collection later, use:',
      '```rust',
      `for ${item} in &${collection} {`,
      '    // read only',
      '}',
      '```'
    ].join('\n'));
  }

  const returnLocalRef = trimmed.match(/fn\s+\w+[^\{]*->\s*&[^\{]*\{[\s\S]*let\s+([A-Za-z_][A-Za-z0-9_]*)[\s\S]*&\s*\1/);
  if (returnLocalRef) {
    const local = returnLocalRef[1];
    findings.push([
      'Possible reference to local data:',
      '```text',
      'function frame starts',
      '+---------------------------+',
      `| ${local} owns data             |`,
      `| return &${local} -------------+ |`,
      '+-----------------------------|-+',
      '                              v',
      `${local} is dropped when the function ends`,
      'returned reference is invalid X',
      '```',
      '',
      'Best fix: return owned data, or return a reference that comes from an input parameter.'
    ].join('\n'));
  }

  const mutBorrowTargets = [...trimmed.matchAll(/&\s*mut\s+([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);
  const duplicateMut = mutBorrowTargets.find((target, idx) => mutBorrowTargets.indexOf(target) !== idx);
  if (duplicateMut) {
    findings.push([
      'Possible overlapping mutable borrows:',
      '```text',
      `${duplicateMut}:  ---- &mut borrow #1 ----+`,
      `${duplicateMut}:        &mut borrow #2 X  |`,
      '```',
      '',
      'Best fix: finish using the first mutable reference before creating the second one.'
    ].join('\n'));
  }

  const immutableBorrow = trimmed.match(/let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*&\s*([A-Za-z_][A-Za-z0-9_]*)/);
  if (immutableBorrow) {
    const refName = immutableBorrow[1];
    const target = immutableBorrow[2];
    const mutationPattern = new RegExp(`\\b${escapeRegex(target)}\\s*\\.\\s*(push|insert|clear|remove|sort|truncate)\\s*\\(`);
    if (mutationPattern.test(trimmed)) {
      findings.push([
        'Possible immutable + mutable borrow conflict:',
        '```text',
        `${target}:  ---- immutable borrow by ${refName} ----+`,
        `${target}:        mutation requested X             |`,
        '```',
        '',
        `Best fix: use \`${refName}\` before mutating \`${target}\`, or split the scope.`
      ].join('\n'));
    }
  }

  const assignmentMove = trimmed.match(/let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?!&)([A-Za-z_][A-Za-z0-9_]*)\s*;/);
  if (assignmentMove) {
    const dst = assignmentMove[1];
    const src = assignmentMove[2];
    findings.push([
      'Possible ownership move:',
      '```text',
      `${src} owns data`,
      `${src} ---- move ----> ${dst}`,
      `${src} = invalid if the type is not Copy`,
      '```',
      '',
      `If you only need to read, use \`let ${dst} = &${src};\`.`
    ].join('\n'));
  }

  if (/\.clone\s*\(\s*\)/.test(trimmed)) {
    findings.push([
      'Clone check:',
      '```text',
      'value --clone()--> new owned copy',
      '```',
      '',
      '`clone()` can be correct, but avoid cloning large data just to silence the borrow checker.',
      'Prefer borrowing with `&value` when the callee only reads.'
    ].join('\n'));
  }

  if (/\b(tokio::spawn|task::spawn|spawn)\s*\(\s*async\s*\{/.test(trimmed)) {
    findings.push([
      'Possible async task lifetime issue:',
      '```text',
      'current function:  local data ---- drops here',
      'spawned task:              may run later ---->',
      'borrowed local data in task X',
      '```',
      '',
      'Best fix: use `async move` and move owned data into the task. Use `Arc<T>` for shared data.'
    ].join('\n'));
  }

  return findings;
}

function registerHoverProvider(context) {
  const provider = vscode.languages.registerHoverProvider({ language: 'rust', scheme: 'file' }, {
    provideHover(document, position) {
      const config = vscode.workspace.getConfiguration('rustOwnershipLens');
      if (!config.get('showHoverHints', true)) return undefined;
      const line = document.lineAt(position.line).text;
      for (const hint of SIMPLE_HINTS) {
        if (hint.test(line)) {
          const md = new vscode.MarkdownString(hint.markdown);
          md.isTrusted = false;
          return new vscode.Hover(md);
        }
      }
      return undefined;
    }
  });
  context.subscriptions.push(provider);
}

async function insertExampleError() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'rust') {
    const doc = await vscode.workspace.openTextDocument({
      language: 'rust',
      content: exampleRustCode()
    });
    await vscode.window.showTextDocument(doc);
    return;
  }
  await editor.edit((edit) => edit.insert(editor.selection.active, exampleRustCode()));
}

function exampleRustCode() {
  return [
    'fn main() {',
    '    let mut users = vec![String::from("alice")];',
    '    let first_user = &users[0];',
    '    users.push(String::from("bob"));',
    '    println!("{}", first_user);',
    '}',
    ''
  ].join('\n');
}

class RustLensViewProvider {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
    this.view = undefined;
    this.pendingHtml = welcomeHtml();
    this.pendingText = welcomeText();
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = shellHtml(webviewView.webview, this.pendingHtml);
    webviewView.webview.onDidReceiveMessage(async (message) => {
      if (!message || !message.command) return;
      if (message.command === 'runCheck') {
        await runCargoCheck();
      } else if (message.command === 'copy') {
        await vscode.env.clipboard.writeText(lastReportText || this.pendingText || welcomeText());
        vscode.window.showInformationMessage('Rust Ownership Lens explanation copied.');
      } else if (message.command === 'explainSelection') {
        await explainSelection();
      }
    });
  }

  update(innerHtml, text) {
    this.pendingHtml = innerHtml;
    this.pendingText = text;
    if (this.view) {
      this.view.webview.html = shellHtml(this.view.webview, innerHtml);
    }
  }
}

function shellHtml(webview, innerHtml) {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 12px;
      line-height: 1.45;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 10px;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 13px);
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      padding: 10px;
      border-radius: 4px;
      border: 1px solid var(--vscode-editorWidget-border, transparent);
      overflow: auto;
    }
    code { font-family: var(--vscode-editor-font-family, monospace); }
    .muted { opacity: 0.75; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="run">Run cargo check</button>
    <button id="selection">Explain selection</button>
    <button id="copy">Copy</button>
  </div>
  <main>${innerHtml}</main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => vscode.postMessage({ command: 'runCheck' }));
    document.getElementById('selection').addEventListener('click', () => vscode.postMessage({ command: 'explainSelection' }));
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ command: 'copy' }));
  </script>
</body>
</html>`;
}

function welcomeText() {
  return [
    'Rust Ownership Lens',
    '===================',
    '',
    'Open a Rust workspace, then run:',
    '  Rust Ownership Lens: Run cargo check',
    '',
    'The extension parses:',
    '  cargo check --message-format=json',
    '',
    'It explains these first:',
    '  E0382, E0499, E0502, E0505, E0515, E0597, E0716',
    '',
    'You can also select Rust code and run:',
    '  Rust Ownership Lens: Explain Selected Rust Code'
  ].join('\n');
}

function welcomeHtml() {
  return textReportHtml('Rust Ownership Lens', welcomeText());
}

function loadingHtml(cwd, command, args) {
  const text = [
    'Running cargo check...',
    '',
    `Workspace: ${cwd}`,
    `Command: ${command} ${args.join(' ')}`,
    '',
    'Waiting for cargo JSON diagnostics.'
  ].join('\n');
  return textReportHtml('Running', text);
}

function textReportHtml(title, text) {
  return `<h2>${escapeHtml(title)}</h2><pre>${escapeHtml(text)}</pre>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let i = 0; i < 32; i += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

module.exports = {
  activate,
  deactivate,
  // Exported for lightweight unit checks outside VS Code.
  _test: {
    parseCargoJsonMessages,
    extractDiagnostics,
    buildReport,
    buildHeuristicExplanation,
    heuristicFindings,
    getCode,
    guessVariable,
  }
};
