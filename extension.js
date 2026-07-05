'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_CARGO_COMMAND = 'cargo';
const DEFAULT_CARGO_ARGS = ['check', '--message-format=json'];
const DEFAULT_CLIPPY_ARGS = ['clippy', '--message-format=json'];
const DEFAULT_RUSTC_COMMAND = 'rustc';
const RUN_ON_SAVE_DEBOUNCE_MS = 500;

const KNOWN_CODES = new Set([
  'E0106', // missing lifetime specifier
  'E0277', // trait bound not satisfied
  'E0373', // closure may outlive borrowed value
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
let diagnosticCollection;
let timelineDecorationTypes = {};
let saveDebounceTimer;
let cargoRunInFlight = false;
let cargoRunQueued = false;
let lastRunCwd = '';
let currentRunProcess;
const rememberedWorkspacePackages = new Map();

function activate(context) {
  outputChannel = vscode.window.createOutputChannel('Rust Ownership Lens');
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(rust) Rust Lens';
  statusBarItem.command = 'rustOwnershipLens.runCheck';
  statusBarItem.tooltip = 'Run Rust Ownership Lens';
  statusBarItem.show();

  viewProvider = new RustLensViewProvider(context.extensionUri);
  if (vscode.languages && typeof vscode.languages.createDiagnosticCollection === 'function') {
    diagnosticCollection = vscode.languages.createDiagnosticCollection('rustOwnershipLens');
  }
  timelineDecorationTypes = createTimelineDecorationTypes();

  const subscriptions = [
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
    vscode.commands.registerCommand('rustOwnershipLens.insertExample', () => insertExampleError()),
    vscode.commands.registerCommand('rustOwnershipLens.explainDependency', () => explainDependency()),
    vscode.commands.registerCommand('rustOwnershipLens.expandMacro', () => expandMacroAtCursor()),
    vscode.workspace.onDidSaveTextDocument((document) => onTextDocumentSaved(document))
  ];

  if (diagnosticCollection) subscriptions.push(diagnosticCollection);
  for (const decorationType of Object.values(timelineDecorationTypes)) {
    if (decorationType) subscriptions.push(decorationType);
  }
  if (vscode.window && typeof vscode.window.onDidChangeVisibleTextEditors === 'function') {
    subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => updateInlineTimelineDecorations(lastDiagnostics, lastRunCwd)));
  }

  context.subscriptions.push(...subscriptions);

  registerHoverProvider(context);
  registerCodeActionProvider(context);
  viewProvider.update(welcomeHtml(), welcomeText());
}

function deactivate() {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
}

async function runCargoCheck() {
  if (cargoRunInFlight) {
    cargoRunQueued = true;
    cancelCurrentRunProcess();
    return;
  }

  const config = vscode.workspace.getConfiguration('rustOwnershipLens');
  const includeWarnings = config.get('includeWarnings', false);
  const maxDiagnostics = config.get('maxDiagnostics', 20);
  const timeoutSeconds = config.get('timeoutSeconds', 300);
  const language = normalizeLanguage(config.get('language', 'en'));
  const reused = tryUseExistingDiagnostics(config, includeWarnings, maxDiagnostics, language);
  if (reused) return;

  const target = await getRunTarget(config);
  if (!target) {
    vscode.window.showWarningMessage('Open a Rust workspace folder or a Rust source file first.');
    return;
  }

  cargoRunInFlight = true;
  lastRunCwd = target.cwd;
  try {
    statusBarItem.text = '$(sync~spin) Rust Lens';
    outputChannel.clear();
    outputChannel.appendLine(`Running: ${target.command} ${target.args.join(' ')}`);
    outputChannel.appendLine(`Workspace: ${target.cwd}`);
    if (target.description) outputChannel.appendLine(`Mode: ${target.description}`);
    if (target.usedTrustedFallback) {
      outputChannel.appendLine('Workspace Trust: ignored workspace cargoCommand/cargoArgs overrides in this untrusted workspace.');
    }
    if (target.requiresJsonWarning) {
      const warning = 'Rust Ownership Lens: rustOwnershipLens.cargoArgs is missing --message-format=json, so cargo diagnostics may not parse.';
      outputChannel.appendLine(`Warning: ${warning}`);
      vscode.window.showWarningMessage(warning);
    }
    outputChannel.show(true);
    viewProvider.update(loadingHtml(target.cwd, target.command, target.args, target.description), 'Running Rust diagnostics...');

    let previewShown = false;
    let streamedRaw = '';
    const result = await runWithProgress(`Rust Ownership Lens: ${target.label}`, async (progress, token) => {
      return runProcess(target.command, target.args, target.cwd, {
        timeoutMs: timeoutSeconds * 1000,
        token,
        onData(chunk) {
          streamedRaw += chunk;
          if (previewShown) return;
          const messages = parseCargoJsonMessages(streamedRaw);
          const preview = prioritizeDiagnostics(deduplicateDiagnostics(extractDiagnostics(messages, includeWarnings)), maxDiagnostics);
          const firstKnown = preview.filter(isKnownDiagnostic);
          if (firstKnown.length > 0) {
            previewShown = true;
            progress.report({ message: `parsed ${firstKnown.length} known diagnostic(s)` });
            const partial = buildReport(firstKnown, {
              cwd: target.cwd,
              exitCode: 'running',
              command: `${target.command} ${target.args.join(' ')}`,
              rawMessageCount: messages.length,
              includeWarnings,
              mode: target.description,
              language
            });
            viewProvider.update(partial.html, partial.text);
          }
        }
      });
    });

    outputChannel.appendLine(`--- ${target.label} stdout ---`);
    outputChannel.appendLine(result.stdout || '(empty)');
    if (result.stderr) {
      outputChannel.appendLine(`--- ${target.label} stderr ---`);
      outputChannel.appendLine(result.stderr);
    }

    const messages = parseCargoJsonMessages(result.stdout + os.EOL + result.stderr);
    const diagnostics = prioritizeDiagnostics(
      deduplicateDiagnostics(extractDiagnostics(messages, includeWarnings)
        .filter((diagnostic) => includeWarnings || diagnostic.level === 'error')),
      maxDiagnostics
    );

    lastDiagnostics = diagnostics;
    const report = buildReport(diagnostics, {
      cwd: target.cwd,
      exitCode: result.exitCode,
      command: `${target.command} ${target.args.join(' ')}`,
      rawMessageCount: messages.length,
      includeWarnings,
      mode: target.description,
      language
    });

    lastReportText = report.text;
    lastReportHtml = report.html;
    outputChannel.appendLine('--- Rust Ownership Lens report ---');
    outputChannel.appendLine(report.text);
    viewProvider.update(report.html, report.text);
    publishDiagnostics(diagnostics, target.cwd);
    updateInlineTimelineDecorations(diagnostics, target.cwd);
    statusBarItem.text = diagnostics.length > 0 ? `$(warning) Rust Lens ${diagnostics.length}` : '$(check) Rust Lens';

    const knownCount = diagnostics.filter(isKnownDiagnostic).length;
    if (diagnostics.length === 0) {
      vscode.window.showInformationMessage(`Rust Ownership Lens: ${target.label} produced no parsed diagnostics.`);
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
  } finally {
    cargoRunInFlight = false;
    if (target && target.cleanup) target.cleanup();
    if (cargoRunQueued) {
      cargoRunQueued = false;
      setTimeout(() => runCargoCheck(), 0);
    }
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

async function getRunTarget(config) {
  const folder = getWorkspaceFolder();
  const editor = vscode.window.activeTextEditor;
  const activeRustFile = editor && editor.document && editor.document.languageId === 'rust'
    ? editor.document.uri.fsPath
    : '';
  const workspacePath = folder && folder.uri ? folder.uri.fsPath : '';
  const cargoRoot = findCargoRoot(activeRustFile ? path.dirname(activeRustFile) : workspacePath, workspacePath);

  if (cargoRoot) {
    const cargoConfig = getCargoRunConfig(config, vscode.workspace.isTrusted !== false);
    const packageSelection = await selectWorkspacePackage(cargoRoot, activeRustFile);
    const cargoArgs = packageSelection && packageSelection.name
      ? addPackageArgs(cargoConfig.cargoArgs, packageSelection.name)
      : cargoConfig.cargoArgs;
    return {
      label: cargoArgs[0] === 'clippy' ? 'cargo clippy' : 'cargo check',
      command: cargoConfig.cargoCommand,
      args: cargoArgs,
      cwd: cargoRoot,
      usedTrustedFallback: cargoConfig.usedTrustedFallback,
      requiresJsonWarning: !hasJsonMessageFormat(cargoArgs),
      description: [
        cargoArgs[0] === 'clippy' ? 'cargo clippy mode' : 'cargo workspace mode',
        packageSelection && packageSelection.name ? `package ${packageSelection.name}` : ''
      ].filter(Boolean).join(', ')
    };
  }

  if (activeRustFile) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-lens-'));
    const edition = normalizeRustEdition(config.get('singleFileEdition', '2024'));
    return {
      label: 'rustc single-file check',
      command: DEFAULT_RUSTC_COMMAND,
      args: [
        '--edition',
        edition,
        '--error-format=json',
        '--emit=metadata',
        '-o',
        path.join(tempDir, 'output.rmeta'),
        activeRustFile
      ],
      cwd: path.dirname(activeRustFile),
      description: `single-file mode (edition ${edition})`,
      cleanup() {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    };
  }

  return undefined;
}

async function selectWorkspacePackage(cargoRoot, activeRustFile) {
  const packages = readWorkspacePackages(cargoRoot);
  if (packages.length <= 1) return undefined;
  const remembered = rememberedWorkspacePackages.get(cargoRoot);
  const inferred = packages.find((pkg) => activeRustFile && activeRustFile.startsWith(pkg.dir + path.sep));
  const preferred = remembered || (inferred && inferred.name) || '';

  if (!vscode.window || typeof vscode.window.showQuickPick !== 'function') {
    return preferred ? packages.find((pkg) => pkg.name === preferred) : undefined;
  }

  const picks = [
    { label: 'All workspace packages', name: '' },
    ...packages.map((pkg) => ({
      label: pkg.name === preferred ? `${pkg.name} (current)` : pkg.name,
      description: path.relative(cargoRoot, pkg.dir) || '.',
      name: pkg.name
    }))
  ];
  const selected = await vscode.window.showQuickPick(picks, {
    title: 'Rust Ownership Lens package',
    placeHolder: 'Select package for cargo check, or run the full workspace'
  });
  if (!selected) return undefined;
  rememberedWorkspacePackages.set(cargoRoot, selected.name);
  return selected.name ? packages.find((pkg) => pkg.name === selected.name) : undefined;
}

function readWorkspacePackages(cargoRoot) {
  const manifestPath = path.join(cargoRoot, 'Cargo.toml');
  const manifest = readTextFile(manifestPath);
  if (!manifest) return [];
  const members = parseWorkspaceMembers(manifest);
  if (members.length === 0) {
    const name = parsePackageName(manifest);
    return name ? [{ name, dir: cargoRoot }] : [];
  }
  return members
    .map((member) => path.resolve(cargoRoot, member))
    .map((dir) => {
      const memberManifest = readTextFile(path.join(dir, 'Cargo.toml'));
      const name = parsePackageName(memberManifest);
      return name ? { name, dir } : undefined;
    })
    .filter(Boolean);
}

function readTextFile(fileName) {
  try {
    return fs.readFileSync(fileName, 'utf8');
  } catch (_) {
    return '';
  }
}

function parseWorkspaceMembers(manifest) {
  const match = manifest.match(/(?:^|\n)\s*members\s*=\s*\[([\s\S]*?)\]/);
  if (!match) return [];
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function parsePackageName(manifest) {
  if (!manifest) return '';
  const packageSection = manifest.match(/(?:^|\n)\s*\[package\]([\s\S]*?)(?:\n\s*\[|$)/);
  const source = packageSection ? packageSection[1] : manifest;
  const name = source.match(/(?:^|\n)\s*name\s*=\s*"([^"]+)"/);
  return name ? name[1] : '';
}

function addPackageArgs(args, packageName) {
  if (!packageName || args.includes('-p') || args.includes('--package')) return args;
  return args.concat(['-p', packageName]);
}

function findCargoRoot(startDir, workspacePath) {
  if (!startDir) return '';
  let current = startDir;
  const stop = workspacePath ? path.resolve(workspacePath) : path.parse(current).root;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, 'Cargo.toml'))) return current;
    if (path.resolve(current) === stop) break;
    current = path.dirname(current);
  }
  if (workspacePath && fs.existsSync(path.join(workspacePath, 'Cargo.toml'))) return workspacePath;
  return '';
}

function normalizeRustEdition(value) {
  const edition = String(value || '').trim();
  return ['2015', '2018', '2021', '2024'].includes(edition) ? edition : '2024';
}

function normalizeLanguage(value) {
  return value === 'ja' ? 'ja' : 'en';
}

function runWithProgress(title, task) {
  if (vscode.window && typeof vscode.window.withProgress === 'function' && vscode.ProgressLocation) {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true
    }, task);
  }
  return task({ report() {} }, undefined);
}

function runProcess(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const spawnCommand = resolveCommandForSpawn(command);
    const child = cp.spawn(spawnCommand, args, {
      cwd,
      shell: false,
      env: Object.assign({}, process.env, { CARGO_TERM_COLOR: 'never' })
    });

    currentRunProcess = child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout;

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (currentRunProcess === child) currentRunProcess = undefined;
      fn(value);
    };

    if (options.timeoutMs && options.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM');
        settle(reject, new Error(`Timed out after ${Math.round(options.timeoutMs / 1000)} seconds.`));
      }, options.timeoutMs);
    }

    if (options.token && typeof options.token.onCancellationRequested === 'function') {
      options.token.onCancellationRequested(() => {
        child.kill('SIGTERM');
        settle(reject, new Error('Canceled by user.'));
      });
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (typeof options.onData === 'function') options.onData(text, 'stdout');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (typeof options.onData === 'function') options.onData(text, 'stderr');
    });
    child.on('error', (err) => settle(reject, err));
    child.on('close', (exitCode) => settle(resolve, { stdout, stderr, exitCode }));
  });
}

function cancelCurrentRunProcess() {
  if (currentRunProcess && !currentRunProcess.killed) {
    currentRunProcess.kill('SIGTERM');
  }
}

function getCargoRunConfig(config, workspaceTrusted) {
  const commandResult = getRestrictedConfigurationValue(config, 'cargoCommand', DEFAULT_CARGO_COMMAND, workspaceTrusted);
  const defaultArgs = config && typeof config.get === 'function' && config.get('useClippy', false)
    ? DEFAULT_CLIPPY_ARGS
    : DEFAULT_CARGO_ARGS;
  const argsResult = getRestrictedConfigurationValue(config, 'cargoArgs', defaultArgs, workspaceTrusted);

  return {
    cargoCommand: normalizeCargoCommand(commandResult.value),
    cargoArgs: normalizeCargoArgs(argsResult.value),
    usedTrustedFallback: commandResult.usedTrustedFallback || argsResult.usedTrustedFallback
  };
}

function getRestrictedConfigurationValue(config, key, defaultValue, workspaceTrusted) {
  if (!workspaceTrusted && config && typeof config.inspect === 'function') {
    const inspected = config.inspect(key);
    if (hasWorkspaceConfigurationValue(inspected)) {
      if (inspected.globalValue !== undefined) {
        return { value: cloneConfigValue(inspected.globalValue), usedTrustedFallback: true };
      }
      if (inspected.defaultValue !== undefined) {
        return { value: cloneConfigValue(inspected.defaultValue), usedTrustedFallback: true };
      }
      return { value: cloneConfigValue(defaultValue), usedTrustedFallback: true };
    }
  }

  if (config && typeof config.get === 'function') {
    return { value: cloneConfigValue(config.get(key, defaultValue)), usedTrustedFallback: false };
  }
  return { value: cloneConfigValue(defaultValue), usedTrustedFallback: false };
}

function hasWorkspaceConfigurationValue(inspected) {
  return Boolean(
    inspected &&
    (inspected.workspaceValue !== undefined || inspected.workspaceFolderValue !== undefined)
  );
}

function normalizeCargoCommand(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return DEFAULT_CARGO_COMMAND;
}

function normalizeCargoArgs(value) {
  if (!Array.isArray(value)) return DEFAULT_CARGO_ARGS.slice();
  return value.map((arg) => String(arg));
}

function cloneConfigValue(value) {
  return Array.isArray(value) ? value.slice() : value;
}

function hasJsonMessageFormat(args) {
  if (!Array.isArray(args)) return false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--message-format=json') return true;
    if (arg.startsWith('--message-format=json')) return true;
    if (arg === '--message-format' && args[i + 1] && String(args[i + 1]).startsWith('json')) return true;
  }
  return false;
}

function resolveCommandForSpawn(command, env = process.env, platform = process.platform, exists = fs.existsSync) {
  if (platform !== 'win32') return command;

  const winPath = path.win32;
  const trimmed = String(command || '').trim();
  if (!trimmed) return DEFAULT_CARGO_COMMAND;
  if (winPath.extname(trimmed)) return trimmed;

  const extensions = getWindowsPathExtensions(env);
  const candidates = /[\\/]/.test(trimmed)
    ? extensions.map((ext) => `${trimmed}${ext}`)
    : getWindowsPathDirs(env).flatMap((dir) => extensions.map((ext) => winPath.join(dir, `${trimmed}${ext}`)));

  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  return `${trimmed}.exe`;
}

function getWindowsPathDirs(env) {
  const pathValue = env.Path || env.PATH || '';
  return pathValue.split(';').filter(Boolean);
}

function getWindowsPathExtensions(env) {
  const pathext = env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  const extensions = pathext.split(';').filter(Boolean);
  return extensions.length > 0 ? extensions : ['.EXE'];
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

function tryUseExistingDiagnostics(config, includeWarnings, maxDiagnostics, language) {
  const source = config.get('diagnosticSource', 'auto');
  if (source === 'cargo') return false;
  if (!vscode.languages || typeof vscode.languages.getDiagnostics !== 'function') return false;

  const diagnostics = [];
  for (const [uri, items] of vscode.languages.getDiagnostics()) {
    if (!uri || !uri.fsPath || !uri.fsPath.endsWith('.rs')) continue;
    for (const item of items || []) {
      const code = codeFromVsCodeDiagnostic(item);
      if (!code || (!KNOWN_CODES.has(code) && !code.startsWith('clippy::'))) continue;
      if (item.severity === vscode.DiagnosticSeverity.Warning && !includeWarnings) continue;
      if (!isRustDiagnosticSource(item.source) && source === 'rust-analyzer') continue;
      diagnostics.push(vscodeDiagnosticToRustDiagnostic(uri.fsPath, item, code));
    }
  }

  const selected = prioritizeDiagnostics(diagnostics, maxDiagnostics);
  if (selected.length === 0) return false;

  lastDiagnostics = selected;
  lastRunCwd = getWorkspaceFolder() && getWorkspaceFolder().uri ? getWorkspaceFolder().uri.fsPath : process.cwd();
  const report = buildReport(selected, {
    cwd: lastRunCwd,
    exitCode: 'reused',
    command: 'VS Code diagnostics',
    rawMessageCount: selected.length,
    includeWarnings,
    mode: 'existing rust-analyzer/rustc diagnostics',
    language
  });
  lastReportText = report.text;
  lastReportHtml = report.html;
  outputChannel.clear();
  outputChannel.appendLine('Reused existing VS Code diagnostics; cargo was not run.');
  outputChannel.appendLine(report.text);
  viewProvider.update(report.html, report.text);
  publishDiagnostics(selected, lastRunCwd);
  updateInlineTimelineDecorations(selected, lastRunCwd);
  statusBarItem.text = `$(warning) Rust Lens ${selected.length}`;
  return true;
}

function codeFromVsCodeDiagnostic(diagnostic) {
  if (!diagnostic) return '';
  if (typeof diagnostic.code === 'string') return diagnostic.code;
  if (diagnostic.code && typeof diagnostic.code.value === 'string') return diagnostic.code.value;
  if (diagnostic.code && typeof diagnostic.code.code === 'string') return diagnostic.code.code;
  const match = String(diagnostic.message || '').match(/\b(E\d{4}|clippy::[A-Za-z0-9_]+)\b/);
  return match ? match[1] : '';
}

function isRustDiagnosticSource(source) {
  const value = String(source || '').toLowerCase();
  return !value || value.includes('rust') || value.includes('rust-analyzer') || value.includes('clippy');
}

function vscodeDiagnosticToRustDiagnostic(fileName, diagnostic, code) {
  const range = diagnostic.range;
  const start = range && range.start ? range.start : { line: 0, character: 0 };
  const end = range && range.end ? range.end : start;
  return {
    level: diagnostic.severity === vscode.DiagnosticSeverity.Warning ? 'warning' : 'error',
    code: { code },
    message: diagnostic.message || code,
    spans: [{
      file_name: fileName,
      line_start: start.line + 1,
      line_end: end.line + 1,
      column_start: start.character + 1,
      column_end: Math.max(start.character + 2, end.character + 1),
      is_primary: true,
      label: diagnostic.message || code,
      text: []
    }],
    children: []
  };
}

function deduplicateDiagnostics(diagnostics) {
  const unique = [];
  const seen = new Set();
  for (const diagnostic of Array.isArray(diagnostics) ? diagnostics : []) {
    const primary = getPrimarySpan(diagnostic);
    const key = [
      getCode(diagnostic),
      formatDiagnosticPath(primary && primary.file_name ? primary.file_name : ''),
      primary && primary.line_start ? primary.line_start : '',
      primary && primary.column_start ? primary.column_start : '',
      diagnostic && diagnostic.message ? diagnostic.message : ''
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(diagnostic);
  }
  return unique;
}

function prioritizeDiagnostics(diagnostics, maxDiagnostics) {
  const unique = deduplicateDiagnostics(diagnostics);
  const known = unique.filter(isKnownDiagnostic);
  const unknown = unique.filter((diagnostic) => !isKnownDiagnostic(diagnostic));
  return known.concat(unknown).slice(0, maxDiagnostics);
}

function isKnownDiagnostic(diagnostic) {
  const code = getCode(diagnostic);
  return KNOWN_CODES.has(code) || isClippyCloneDiagnostic(diagnostic);
}

function buildReport(diagnostics, meta) {
  const known = diagnostics.filter(isKnownDiagnostic);
  const unknown = diagnostics.filter((d) => !isKnownDiagnostic(d));

  const parts = [];
  parts.push('Rust Ownership Lens');
  parts.push('===================');
  parts.push('');
  parts.push(`Command: ${meta.command}`);
  parts.push(`Workspace: ${meta.cwd}`);
  if (meta.mode) parts.push(`Mode: ${meta.mode}`);
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
      parts.push(renderDiagnosticExplanation(known[i], i + 1, normalizeLanguage(meta.language)));
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
    html: textReportHtml('Rust Ownership Lens', text, { cwd: meta.cwd })
  };
}

function renderDiagnosticExplanation(diagnostic, index, language = 'en') {
  const code = getCode(diagnostic);
  const message = diagnostic.message || '(no message)';
  const primary = getPrimarySpan(diagnostic);
  const variable = guessVariable(diagnostic);
  const file = formatSpanLocation(primary);
  const events = buildEvents(diagnostic);
  const source = sourceSnippet(primary);

  const lines = [];
  lines.push(`Issue ${index}: error[${code}]`);
  lines.push('-'.repeat(Math.max(18, `Issue ${index}: error[${code}]`.length)));
  lines.push(`File: ${file}`);
  lines.push(`Message: ${message}`);
  if (/^E\d{4}$/.test(code)) {
    lines.push(`Official explanation: rustc --explain ${code} | https://doc.rust-lang.org/error_codes/${code}.html`);
  }
  if (variable) lines.push(`Main value: ${variable}`);
  lines.push('');

  if (source) {
    lines.push('Source near the primary span:');
    lines.push('```rust');
    lines.push(source);
    lines.push('```');
    lines.push('');
  }

  const template = templateForDiagnostic(code, variable, diagnostic, events, language);
  lines.push(template.trimEnd());

  const suggestions = collectSuggestions(diagnostic, code, variable);
  if (suggestions.length > 0) {
    lines.push('');
    lines.push('rustc suggestions / hints:');
    for (const s of suggestions) lines.push(`- ${s}`);
  }

  return lines.join('\n');
}

function templateForDiagnostic(code, variable, diagnostic, events, language = 'en') {
  if (language === 'ja') {
    return japaneseTemplateForDiagnostic(code, variable, diagnostic, events);
  }

  const v = variable || 'this value';
  const timeline = renderEventTimeline(events, v);

  switch (code) {
    case 'E0277':
      return [
        'Problem:',
        `  A trait bound is missing: Rust needed ${v} to implement a trait, but that requirement was not satisfied.`,
        '',
        'Trait bound ASCII:',
        '```text',
        'generic code asks for: T: Trait',
        'actual type supplied:  T',
        '                         ^ Trait implementation or bound missing X',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Add the trait bound where the generic type is declared, for example `T: Clone` or `T: Debug`.',
        '  B. Pass a reference such as `&T` when the callee only needs borrowed access.',
        '  C. Derive or implement the missing trait when the type should support it.',
        '  D. For `Send` or `\'static`, move owned data into the task or use `Arc<T>` for shared state.'
      ].join('\n');

    case 'E0373':
      return [
        'Problem:',
        '  A closure or async block may outlive the current function while borrowing local data.',
        '',
        'Async lifetime ASCII:',
        '```text',
        'current function frame: [local data] ---- drops here',
        'closure/task:                    may run later ---->',
        'borrowed local data crosses that boundary X',
        '```',
        '',
        timeline,
        '',
        'Best fixes:',
        '  A. Use `move` or `async move` so the closure/task owns the data it needs.',
        '  B. Clone small owned values before spawning if each task needs its own copy.',
        '  C. Use `Arc<T>` for shared read-only data across tasks.',
        '  D. Use `Arc<Mutex<T>>` or another synchronization primitive only for true shared mutation.'
      ].join('\n');

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
      if (isForLoopIteratorMoveDiagnostic(diagnostic)) {
        return iteratorMoveTemplate(v, diagnostic, events);
      }
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
      if (isClippyCloneDiagnostic(diagnostic)) {
        return clippyCloneTemplate(diagnostic, timeline);
      }
      return [
        'Problem:',
        `  ${diagnostic.message || 'Unknown Rust diagnostic'}`,
        '',
        timeline || 'No timeline available yet.'
      ].join('\n');
  }
}

function japaneseTemplateForDiagnostic(code, variable, diagnostic, events) {
  const v = variable || 'この値';
  const timeline = renderEventTimeline(events, v);

  if (isClippyCloneDiagnostic(diagnostic)) {
    return [
      '問題:',
      '  Clippy は、不要な `clone()` や `to_owned()` の可能性を見つけました。',
      '',
      'Clone ASCII:',
      '```text',
      'value ---- clone() ----> 新しい所有値',
      '&value ---------------> 借用だけで読む',
      '```',
      '',
      timeline,
      '',
      '修正候補:',
      '  A. 元の値を move できるなら clone を消す。',
      '  B. 読むだけなら `&value` で借用する。',
      '  C. 本当に 2 つの owner が必要な場合だけ clone を残す。',
      '  D. 自動適用は MachineApplicable な Clippy suggestion に限定する。'
    ].join('\n');
  }

  switch (code) {
    case 'E0106':
      return [
        '問題:',
        '  返す参照、または保持する参照が、どの入力・所有者から来たものか lifetime で示されていません。',
        '',
        'Lifetime ASCII:',
        '```text',
        'fn f(...) -> &str',
        '             ^--- 何から借りた参照か不明 X',
        'input:  ----- ここまで生存 ----->',
        'output: 十分長く生きるデータを指す必要がある',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. 参照ではなく `String` などの owned data を返す。',
        '  B. 入力由来の参照なら `fn f<\'a>(x: &\'a T) -> &\'a str` のように結びつける。',
        '  C. 関数内で作った値への参照を返さない。',
        '  D. 参照を持つ struct は owned data にできないか検討する。'
      ].join('\n');

    case 'E0277':
      return [
        '問題:',
        `  ${v} に必要な trait bound が満たされていません。Rust はその型が特定の trait を実装している必要があると判断しました。`,
        '',
        'Trait bound ASCII:',
        '```text',
        'generic code: T: Trait が必要',
        'actual type:  T',
        '              ^ trait 実装または bound が不足 X',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. `T: Clone` や `T: Debug` のように generic の宣言へ bound を足す。',
        '  B. 読むだけなら `&T` を渡す設計にする。',
        '  C. 型がその能力を持つべきなら derive または impl する。',
        '  D. `Send` や `\'static` の場合は owned data を task に move するか `Arc<T>` を使う。'
      ].join('\n');

    case 'E0373':
      return [
        '問題:',
        '  closure または async block が現在の関数より長く生きる可能性があり、local data を借用しています。',
        '',
        'Async lifetime ASCII:',
        '```text',
        'current frame: [local data] ---- ここで drop',
        'closure/task:              後で実行される可能性 ---->',
        'local data への借用が境界を越える X',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. `move` または `async move` で必要な data を task/closure に所有させる。',
        '  B. 小さい owned value は spawn 前に clone して渡す。',
        '  C. 共有読み取りには `Arc<T>` を使う。',
        '  D. 共有 mutation が本当に必要なときだけ `Arc<Mutex<T>>` などを使う。'
      ].join('\n');

    case 'E0382':
      if (isForLoopIteratorMoveDiagnostic(diagnostic)) {
        return iteratorMoveTemplate(v, diagnostic, events);
      }
      return [
        '問題:',
        `  ${v} は move されたあと、もう一度使われています。`,
        '',
        'Ownership ASCII:',
        '```text',
        `${v} owns data`,
        `${v} ---- move ----> new owner`,
        `${v} = invalid`,
        `use ${v} later: X`,
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. 読むだけなら `&value` で参照を渡す。',
        '  B. move の前に最後の使用を済ませる。',
        '  C. 本当に必要な小さい部分だけ clone する。',
        '  D. 関数側を ownership ではなく borrow で受け取る設計にする。'
      ].join('\n');

    case 'E0499':
      return [
        '問題:',
        `  ${v} に対する mutable borrow が同時に 2 つ存在しています。`,
        '',
        'Borrow ASCII:',
        '```text',
        `${v}:  ---- mutable borrow #1 ----+`,
        `${v}:        mutable borrow #2 X  |`,
        'Only one mutable borrow can be active at a time.',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. 1 つ目の `&mut` を使い終えてから 2 つ目を作る。',
        '  B. scope を分けて borrow を早く終わらせる。',
        '  C. 別々の要素を編集したいなら `split_at_mut` などを使う。',
        '  D. 共有 mutable state が本当に必要な場合だけ `RefCell` や `Mutex` を検討する。'
      ].join('\n');

    case 'E0502':
      return [
        '問題:',
        `  ${v} が immutable borrow されている間に、mutable borrow しようとしています。`,
        '',
        'Borrow ASCII:',
        '```text',
        `${v}:  ---- immutable borrow ----+`,
        `${v}:        mutable borrow X    |`,
        'The read borrow and write borrow overlap.',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. immutable reference を使い終えてから元の値を変更する。',
        '  B. mutation を immutable borrow の最後の使用より後に移す。',
        '  C. 長く保持する必要がある小さい field だけ clone する。',
        '  D. `{ ... }` で scope を分け、borrow を早く終わらせる。'
      ].join('\n');

    case 'E0505':
      return [
        '問題:',
        `  ${v} はまだ borrow されている間に move されています。`,
        '',
        'Ownership / borrow ASCII:',
        '```text',
        `${v}:  ---- borrowed ----+`,
        `${v}:        move X      |`,
        'The borrow must end before the move.',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. borrow を使い終えてから値を move する。',
        '  B. borrow の scope を小さくする。',
        '  C. 後続処理を move ではなく borrow に変える。',
        '  D. 参照を返すのではなく owned data を返す。'
      ].join('\n');

    case 'E0515':
      return [
        '問題:',
        '  関数内で所有されている local data への参照を返そうとしています。',
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
        '修正候補:',
        '  A. `&str` ではなく `String` など owned data を返す。',
        '  B. 入力 parameter 由来の参照を返す。',
        '  C. 返す参照が指す data を関数外に置く。',
        '  D. lifetime annotation だけで直そうとしない。'
      ].join('\n');

    case 'E0597':
      return [
        '問題:',
        `  ${v} は、その参照が必要とする期間まで生きていません。`,
        '',
        'Lifetime ASCII:',
        '```text',
        `${v}:      alive ----+`,
        'reference:       needs data -------->',
        '                 data drops too early X',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. owned value をより外側の scope に移す。',
        '  B. borrowed reference ではなく owned data を返す。',
        '  C. temporary value から借用しない。',
        '  D. async task では `async move` で owned data を task に渡す。'
      ].join('\n');

    case 'E0716':
      return [
        '問題:',
        '  temporary value を borrow していますが、その temporary が早く drop されます。',
        '',
        'Temporary lifetime ASCII:',
        '```text',
        'temporary value:  alive --+',
        'borrow:                needs data ---->',
        '                       temporary dropped X',
        '```',
        '',
        timeline,
        '',
        '修正候補:',
        '  A. temporary を名前付き変数に保存する。',
        '  B. owner が reference より長く生きるようにする。',
        '  C. temporary への参照ではなく owned data を返す。'
      ].join('\n');

    default:
      return [
        '問題:',
        `  ${diagnostic.message || '不明な Rust diagnostic'}`,
        '',
        timeline || 'Timeline はまだありません。'
      ].join('\n');
  }
}

function iteratorMoveTemplate(variable, diagnostic, events) {
  const context = findForLoopIteratorMoveContext(diagnostic, variable);
  const collection = context.collection || variable || 'collection';
  const item = context.item || 'item';
  const timeline = renderEventTimeline(events, collection);

  return [
    'Problem:',
    `  The for loop moved ${collection} by calling \`.into_iter()\`, then ${collection} was used again.`,
    '',
    'Iterator ownership ASCII:',
    '```text',
    `${collection} before loop: owns Vec<T>`,
    `for ${item} in ${collection}`,
    `${' '.repeat(4 + item.length + 4)}^ calls IntoIterator::into_iter(${collection})`,
    `${collection} moved into the loop iterator`,
    `later use of ${collection}: X`,
    '```',
    '',
    'Iterator choices:',
    '```text',
    `for ${item} in ${collection}      -> into_iter(), moves the owned collection`,
    `for ${item} in &${collection}     -> iter(), reads borrowed items`,
    `for ${item} in &mut ${collection} -> iter_mut(), edits items without moving the Vec`,
    '```',
    '',
    timeline,
    '',
    'Quick fixes:',
    `  A. Read only: change to \`for ${item} in &${collection} { ... }\`.`,
    `  B. Mutate elements: change to \`for ${item} in &mut ${collection} { ... }\`.`,
    `  C. Consume intentionally: keep \`for ${item} in ${collection}\` and do not use ${collection} after the loop.`
  ].join('\n');
}

function japaneseIteratorMoveTemplate(variable, diagnostic, events) {
  const context = findForLoopIteratorMoveContext(diagnostic, variable);
  const collection = context.collection || variable || 'collection';
  const item = context.item || 'item';
  const timeline = renderEventTimeline(events, collection);

  return [
    '問題:',
    `  \`for ${item} in ${collection}\` が \`.into_iter()\` を呼び、${collection} を move しました。その後でもう一度 ${collection} を使っています。`,
    '',
    'Iterator ownership ASCII:',
    '```text',
    `${collection} before loop: owns Vec<T>`,
    `for ${item} in ${collection}`,
    `${collection} moved into the loop iterator`,
    `later use of ${collection}: X`,
    '```',
    '',
    'Iterator choices:',
    '```text',
    `for ${item} in ${collection}      -> into_iter(), collection を move`,
    `for ${item} in &${collection}     -> iter(), borrowed items を読む`,
    `for ${item} in &mut ${collection} -> iter_mut(), Vec を move せず要素を編集`,
    '```',
    '',
    timeline,
    '',
    '修正候補:',
    `  A. 読むだけなら \`for ${item} in &${collection} { ... }\` に変える。`,
    `  B. 要素を変更するなら \`for ${item} in &mut ${collection} { ... }\` に変える。`,
    `  C. consume する意図なら \`for ${item} in ${collection}\` のままにし、loop 後に ${collection} を使わない。`
  ].join('\n');
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
    rows.push(`${formatDiagnosticPath(event.file)}:${event.line}:${event.column} line ${String(event.line).padStart(4, ' ')}: ${event.kind}`);
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
  const addSuggestion = (suggestion) => {
    if (suggestion && !suggestions.includes(suggestion)) suggestions.push(suggestion);
  };

  if (code === 'E0382' && isForLoopIteratorMoveDiagnostic(diagnostic)) {
    const context = findForLoopIteratorMoveContext(diagnostic, variable);
    const collection = context.collection || variable || 'collection';
    const item = context.item || 'item';
    addSuggestion(`Quick Fix: change \`for ${item} in ${collection}\` to \`for ${item} in &${collection}\` for read-only iteration`);
    addSuggestion(`Quick Fix: change \`for ${item} in ${collection}\` to \`for ${item} in &mut ${collection}\` when mutating items`);
  }

  const children = Array.isArray(diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    if (child && child.message) addSuggestion(child.message);
    const spans = Array.isArray(child.spans) ? child.spans : [];
    for (const span of spans) {
      if (span && span.suggested_replacement) {
        addSuggestion(`replace code at ${formatDiagnosticPath(span.file_name)}:${span.line_start} with \`${span.suggested_replacement}\``);
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

function isClippyCloneDiagnostic(diagnostic) {
  const code = getCode(diagnostic);
  const text = diagnosticSearchText(diagnostic).toLowerCase();
  return code.startsWith('clippy::') && (
    code.includes('clone') ||
    code.includes('to_owned') ||
    text.includes('clone') ||
    text.includes('to_owned')
  );
}

function clippyCloneTemplate(diagnostic, timeline) {
  const code = getCode(diagnostic) || 'clippy';
  return [
    'Problem:',
    `  Clippy reported ${code}, usually meaning an owned copy is being made where a borrow or move would be clearer.`,
    '',
    'Clone cost ASCII:',
    '```text',
    'value ---- clone() ----> new allocation/copy',
    'borrow with &value ---> no ownership transfer',
    '```',
    '',
    timeline,
    '',
    'Best fixes:',
    '  A. Remove the clone when the original value can be moved.',
    '  B. Borrow with `&value` when the callee only reads.',
    '  C. Keep the clone only when two independent owners are really needed.',
    '  D. Apply only MachineApplicable Clippy suggestions automatically.'
  ].join('\n');
}

function collectSuggestedReplacementEdits(diagnostic, fileName, lineNumber) {
  const edits = [];
  const targetFile = path.resolve(fileName);
  const clippyDiagnostic = isClippyCloneDiagnostic(diagnostic);
  for (const candidate of diagnosticSuggestionSpans(diagnostic)) {
    const span = candidate.span;
    if (!span || !span.suggested_replacement) continue;
    if (span.file_name && resolveDiagnosticFile(span.file_name, lastRunCwd) !== targetFile) continue;
    if ((span.line_start || 1) - 1 !== lineNumber) continue;
    if (clippyDiagnostic && !isMachineApplicableSuggestion(span, candidate.child)) continue;
    edits.push({
      title: `Rust Ownership Lens: apply ${getCode(diagnostic) || 'rustc'} suggestion`,
      replacement: span.suggested_replacement,
      line: (span.line_start || 1) - 1,
      start: Math.max(0, (span.column_start || 1) - 1),
      end: Math.max(0, (span.column_end || span.column_start || 1) - 1)
    });
  }
  return edits;
}

function diagnosticSuggestionSpans(diagnostic) {
  const values = [];
  for (const span of Array.isArray(diagnostic && diagnostic.spans) ? diagnostic.spans : []) {
    values.push({ span, child: undefined });
  }
  const children = Array.isArray(diagnostic && diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    for (const span of Array.isArray(child.spans) ? child.spans : []) {
      values.push({ span, child });
    }
  }
  return values;
}

function isMachineApplicableSuggestion(span, child) {
  const value = span.suggestion_applicability || span.applicability || (child && child.applicability);
  return !value || value === 'MachineApplicable';
}

function isForLoopIteratorMoveDiagnostic(diagnostic) {
  if (getCode(diagnostic) !== 'E0382') return false;

  const text = diagnosticSearchText(diagnostic).toLowerCase();
  const hasIntoIter = text.includes('into_iter') || text.includes('intoiterator');
  const hasImplicitMove = text.includes('implicit call') || text.includes('takes ownership of the receiver') || text.includes('moved due to this');
  const hasForLoopSource = diagnosticSpans(diagnostic).some((span) => {
    const lines = Array.isArray(span.text) ? span.text : [];
    return lines.some((entry) => parseMovableForLoopLine(entry && entry.text ? entry.text : ''));
  });
  const hasForLoopHint = text.includes('consider iterating over') || text.includes('for loop') || hasForLoopSource;

  return hasIntoIter && hasImplicitMove && hasForLoopHint;
}

function findForLoopIteratorMoveContext(diagnostic, fallbackCollection) {
  const spans = diagnosticSpans(diagnostic);
  for (const span of spans) {
    const lines = Array.isArray(span.text) ? span.text : [];
    for (const entry of lines) {
      const parsed = parseMovableForLoopLine(entry && entry.text ? entry.text : '');
      if (parsed) {
        return { item: parsed.item, collection: parsed.collection };
      }
    }
  }

  const backticked = [];
  for (const value of diagnosticTextValues(diagnostic)) {
    for (const match of String(value || '').matchAll(/`([^`]+)`/g)) {
      if (match[1]) backticked.push(match[1]);
    }
  }
  const collection = backticked.find((value) => value === fallbackCollection)
    || backticked.find((value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value))
    || fallbackCollection
    || 'collection';

  return { item: 'item', collection };
}

function diagnosticSearchText(diagnostic) {
  return diagnosticTextValues(diagnostic).join('\n');
}

function diagnosticTextValues(diagnostic) {
  const values = [];
  if (!diagnostic) return values;
  if (diagnostic.message) values.push(diagnostic.message);

  for (const span of diagnosticSpans(diagnostic)) {
    if (span.label) values.push(span.label);
    const lines = Array.isArray(span.text) ? span.text : [];
    for (const entry of lines) {
      if (entry && entry.text) values.push(entry.text);
    }
  }

  const children = Array.isArray(diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    if (child && child.message) values.push(child.message);
  }
  return values;
}

function diagnosticSpans(diagnostic) {
  const spans = [];
  if (Array.isArray(diagnostic && diagnostic.spans)) spans.push(...diagnostic.spans);
  const children = Array.isArray(diagnostic && diagnostic.children) ? diagnostic.children : [];
  for (const child of children) {
    if (Array.isArray(child.spans)) spans.push(...child.spans);
  }
  return spans;
}

function formatCompactDiagnostic(diagnostic) {
  const code = getCode(diagnostic) || 'no-code';
  const primary = getPrimarySpan(diagnostic);
  const location = formatSpanLocation(primary);
  return [`[${diagnostic.level || 'diagnostic'} ${code}] ${diagnostic.message || ''}`, `  at ${location}`].join('\n');
}

function formatSpanLocation(span) {
  if (!span) return '(unknown location)';
  const file = formatDiagnosticPath(span.file_name || '(unknown file)');
  const line = span.line_start || '?';
  const column = span.column_start || '?';
  return `${file}:${line}:${column}`;
}

function publishDiagnostics(diagnostics, cwd) {
  if (!diagnosticCollection || !vscode.Diagnostic || !vscode.Range || !vscode.Uri) return;
  diagnosticCollection.clear();
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    const primary = getPrimarySpan(diagnostic);
    if (!primary || !primary.file_name) continue;
    const filePath = resolveDiagnosticFile(primary.file_name, cwd);
    const range = rangeFromSpan(primary);
    const item = new vscode.Diagnostic(
      range,
      `${diagnosticSummary(diagnostic)} See Rust Ownership Lens for the full timeline.`,
      severityForDiagnostic(diagnostic)
    );
    item.source = 'Rust Ownership Lens';
    item.code = getCode(diagnostic) || undefined;
    if (!byFile.has(filePath)) byFile.set(filePath, []);
    byFile.get(filePath).push(item);
  }
  for (const [filePath, items] of byFile) {
    diagnosticCollection.set(vscode.Uri.file(filePath), items);
  }
}

function diagnosticSummary(diagnostic) {
  const code = getCode(diagnostic);
  const variable = guessVariable(diagnostic);
  if (code === 'E0382') return variable ? `${variable} was moved and then used again.` : 'A value was moved and then used again.';
  if (code === 'E0499') return variable ? `${variable} has overlapping mutable borrows.` : 'Overlapping mutable borrows.';
  if (code === 'E0502') return variable ? `${variable} has conflicting immutable and mutable borrows.` : 'Conflicting immutable and mutable borrows.';
  if (code === 'E0505') return variable ? `${variable} is moved while still borrowed.` : 'A value is moved while still borrowed.';
  if (code === 'E0515') return 'A reference to local data escapes the function.';
  if (code === 'E0597') return variable ? `${variable} does not live long enough.` : 'A borrowed value does not live long enough.';
  if (code === 'E0716') return 'A borrowed temporary is dropped too soon.';
  if (code === 'E0277') return 'A required trait bound is missing.';
  if (code === 'E0373') return 'A closure or async block may outlive borrowed data.';
  if (isClippyCloneDiagnostic(diagnostic)) return 'Clippy found a clone or ownership conversion that may be unnecessary.';
  return diagnostic.message || 'Rust diagnostic.';
}

function severityForDiagnostic(diagnostic) {
  if (!vscode.DiagnosticSeverity) return undefined;
  if (diagnostic.level === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (diagnostic.level === 'note') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

function rangeFromSpan(span) {
  const startLine = Math.max(0, (span.line_start || 1) - 1);
  const startColumn = Math.max(0, (span.column_start || 1) - 1);
  const endLine = Math.max(startLine, (span.line_end || span.line_start || 1) - 1);
  const endColumn = Math.max(startColumn + 1, (span.column_end || span.column_start || 2) - 1);
  return new vscode.Range(startLine, startColumn, endLine, endColumn);
}

function resolveDiagnosticFile(fileName, cwd) {
  const cleaned = formatDiagnosticPath(fileName);
  if (path.isAbsolute(cleaned)) return path.normalize(cleaned);
  return path.resolve(cwd || lastRunCwd || process.cwd(), cleaned);
}

function createTimelineDecorationTypes() {
  if (!vscode.window || typeof vscode.window.createTextEditorDecorationType !== 'function') return {};
  const make = (text, color) => vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ` ${text}`,
      color: new vscode.ThemeColor(color),
      margin: '0 0 0 1.5em'
    },
    rangeBehavior: vscode.DecorationRangeBehavior && vscode.DecorationRangeBehavior.ClosedOpen
  });
  return {
    borrow: make('Rust Lens: borrow', 'charts.blue'),
    move: make('Rust Lens: move', 'charts.orange'),
    drop: make('Rust Lens: drop', 'charts.purple'),
    use: make('Rust Lens: use', 'charts.green'),
    return: make('Rust Lens: return', 'charts.yellow'),
    'primary error': make('Rust Lens: conflict', 'errorForeground'),
    related: make('Rust Lens: related', 'descriptionForeground')
  };
}

function updateInlineTimelineDecorations(diagnostics, cwd) {
  if (!vscode.window || !Array.isArray(vscode.window.visibleTextEditors)) return;
  const config = vscode.workspace.getConfiguration('rustOwnershipLens');
  const enabled = config.get('showInlineTimeline', true);
  for (const editor of vscode.window.visibleTextEditors) {
    for (const decorationType of Object.values(timelineDecorationTypes)) {
      if (decorationType && editor.setDecorations) editor.setDecorations(decorationType, []);
    }
    if (!enabled || !editor.document || !editor.document.uri) continue;
    const byKind = {};
    for (const diagnostic of diagnostics || []) {
      for (const event of buildEvents(diagnostic)) {
        if (!event.file) continue;
        if (resolveDiagnosticFile(event.file, cwd) !== path.normalize(editor.document.uri.fsPath)) continue;
        const kind = timelineDecorationTypes[event.kind] ? event.kind : 'related';
        if (!byKind[kind]) byKind[kind] = [];
        const line = Math.max(0, (event.line || 1) - 1);
        if (Number.isInteger(editor.document.lineCount) && line >= editor.document.lineCount) continue;
        const textLine = editor.document.lineAt(line);
        const range = new vscode.Range(line, textLine.range.end.character, line, textLine.range.end.character);
        byKind[kind].push({ range, hoverMessage: event.label || event.kind });
      }
    }
    for (const [kind, ranges] of Object.entries(byKind)) {
      const decorationType = timelineDecorationTypes[kind];
      if (decorationType && editor.setDecorations) editor.setDecorations(decorationType, ranges);
    }
  }
}

function formatDiagnosticPath(fileName) {
  const value = String(fileName || '');
  if (/^\\\\\?\\UNC\\/i.test(value)) return `\\\\${value.slice(8)}`;
  if (/^\\\\\?\\/i.test(value)) return value.slice(4);
  return value;
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
      if (!shouldShowHoverHint(document, position, config)) return undefined;
      const line = document.lineAt(position.line).text;
      for (const hint of SIMPLE_HINTS) {
        if (hint.test(line) && isPositionNearHint(line, position.character, hint.name)) {
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

function registerCodeActionProvider(context) {
  if (!vscode.languages || !vscode.languages.registerCodeActionsProvider) return;
  if (!vscode.CodeAction || !vscode.CodeActionKind || !vscode.WorkspaceEdit || !vscode.Range) return;

  const provider = vscode.languages.registerCodeActionsProvider({ language: 'rust', scheme: 'file' }, {
    provideCodeActions(document, range) {
      const lineNumber = range && range.start && Number.isInteger(range.start.line) ? range.start.line : 0;
      const line = document.lineAt(lineNumber).text;
      const actions = [];

      for (const edit of collectCodeActionEdits(document, lineNumber)) {
        const action = new vscode.CodeAction(edit.title, vscode.CodeActionKind.QuickFix);
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.replace(document.uri, new vscode.Range(edit.line, edit.start, edit.line, edit.end), edit.replacement);
        action.edit = workspaceEdit;
        action.isPreferred = true;
        actions.push(action);
      }

      const parsed = parseMovableForLoopLine(line);
      if (parsed) {
        // Prefer borrowing fixes over broad clone-based suggestions; clones are not offered automatically.
        actions.push(
          makeForLoopQuickFix(document, lineNumber, parsed, `&${parsed.collection}`, 'Rust Ownership Lens: iterate by shared reference'),
          makeForLoopQuickFix(document, lineNumber, parsed, `&mut ${parsed.collection}`, 'Rust Ownership Lens: iterate by mutable reference')
        );
      }
      return actions;
    }
  }, {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
  });

  context.subscriptions.push(provider);
}

function shouldShowHoverHint(document, position, config) {
  const line = document.lineAt(position.line).text;
  if (isCommentOrStringPosition(line, position.character)) return false;
  if (config.get('hoverOnlyOnDiagnostics', true) && !hasDiagnosticOnLine(document.uri.fsPath, position.line)) return false;
  return true;
}

function hasDiagnosticOnLine(fileName, lineNumber) {
  const target = path.normalize(fileName);
  for (const diagnostic of lastDiagnostics || []) {
    for (const span of diagnosticSpans(diagnostic)) {
      if (!span || !span.file_name) continue;
      if (resolveDiagnosticFile(span.file_name, lastRunCwd) === target && (span.line_start || 1) - 1 === lineNumber) {
        return true;
      }
    }
  }
  return false;
}

function isCommentOrStringPosition(line, character) {
  const before = line.slice(0, character);
  const commentIndex = line.indexOf('//');
  if (commentIndex >= 0 && commentIndex <= character) return true;
  const quoteCount = (before.match(/(?<!\\)"/g) || []).length;
  return quoteCount % 2 === 1;
}

function isPositionNearHint(line, character, hintName) {
  const tests = {
    '&mut': /&\s*mut\b/g,
    '&': /(^|[^&])&[A-Za-z_][A-Za-z0-9_]*(\b|\[|\.)/g,
    'for-in': /\bfor\s+\w+\s+in\s+(?!&)([A-Za-z_][A-Za-z0-9_]*)\b/g,
    clone: /\.clone\s*\(\s*\)/g,
    'tokio-spawn': /\b(tokio::spawn|task::spawn|spawn)\s*\(\s*async\b/g
  };
  const pattern = tests[hintName];
  if (!pattern) return true;
  for (const match of line.matchAll(pattern)) {
    const start = match.index || 0;
    const end = start + match[0].length;
    if (character >= start && character <= end) return true;
  }
  return false;
}

function collectCodeActionEdits(document, lineNumber) {
  const edits = [];
  for (const diagnostic of lastDiagnostics || []) {
    edits.push(...collectSuggestedReplacementEdits(diagnostic, document.uri.fsPath, lineNumber));
  }
  return edits;
}

function onTextDocumentSaved(document) {
  if (!document || document.languageId !== 'rust') return;
  const config = vscode.workspace.getConfiguration('rustOwnershipLens');
  if (!config.get('runOnSave', false)) return;
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = undefined;
    runCargoCheck();
  }, RUN_ON_SAVE_DEBOUNCE_MS);
}

async function explainDependency() {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage('Open a Rust workspace folder first.');
    return;
  }
  const crateName = await vscode.window.showInputBox({
    prompt: 'Crate name to explain',
    placeHolder: 'serde'
  });
  if (!crateName) return;

  const cwd = findCargoRoot(folder.uri.fsPath, folder.uri.fsPath) || folder.uri.fsPath;
  const inverted = await runProcess('cargo', ['tree', '--invert', crateName], cwd, { timeoutMs: 120000 });
  const features = await runProcess('cargo', ['tree', '-e', 'features'], cwd, { timeoutMs: 120000 });
  const text = [
    `Rust Ownership Lens: dependency ${crateName}`,
    '==========================================',
    '',
    'Dependency path:',
    '```text',
    (inverted.stdout || inverted.stderr || '(no cargo tree output)').trimEnd(),
    '```',
    '',
    'Feature activation tree:',
    '```text',
    (features.stdout || features.stderr || '(no cargo feature output)').trimEnd(),
    '```',
    '',
    'Review tips:',
    '- If a default feature pulls in too much, consider `default-features = false`.',
    '- Prefer feature flags that match the code path actually used by this workspace.',
    '- Treat this as Cargo output first; Rust Ownership Lens only formats the tree.'
  ].join('\n');
  lastReportText = text;
  lastReportHtml = textReportHtml('Rust Ownership Lens: Dependency', text, { cwd });
  outputChannel.clear();
  outputChannel.appendLine(text);
  outputChannel.show(true);
  viewProvider.update(lastReportHtml, lastReportText);
}

async function expandMacroAtCursor() {
  const folder = getWorkspaceFolder();
  if (!folder) {
    vscode.window.showWarningMessage('Open a Rust workspace folder first.');
    return;
  }
  const cwd = findCargoRoot(folder.uri.fsPath, folder.uri.fsPath) || folder.uri.fsPath;
  try {
    await runProcess('cargo', ['expand', '--version'], cwd, { timeoutMs: 30000 });
  } catch (_) {
    vscode.window.showWarningMessage('cargo-expand is not installed. Install it with: cargo install cargo-expand');
    return;
  }

  const result = await runWithProgress('Rust Ownership Lens: cargo expand', (_progress, token) => {
    return runProcess('cargo', ['expand'], cwd, { timeoutMs: 300000, token });
  });
  const doc = await vscode.workspace.openTextDocument({
    language: 'rust',
    content: result.stdout || result.stderr || '// cargo expand produced no output'
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function showRustExplain(code) {
  if (!/^E\d{4}$/.test(code)) return;
  try {
    const result = await runProcess('rustc', ['--explain', code], process.cwd(), { timeoutMs: 60000 });
    const text = [
      `rustc --explain ${code}`,
      '='.repeat(`rustc --explain ${code}`.length),
      '',
      (result.stdout || result.stderr || '(rustc returned no explanation)').trimEnd()
    ].join('\n');
    lastReportText = text;
    lastReportHtml = textReportHtml(`rustc --explain ${code}`, text);
    viewProvider.update(lastReportHtml, lastReportText);
    outputChannel.appendLine(text);
  } catch (err) {
    vscode.window.showErrorMessage(`rustc --explain ${code} failed: ${err.message || err}`);
  }
}

async function explainWithLanguageModel() {
  if (!vscode.lm || typeof vscode.lm.selectChatModels !== 'function') {
    vscode.window.showInformationMessage('No VS Code language model provider is available.');
    return;
  }
  const models = await vscode.lm.selectChatModels({});
  const model = models && models[0];
  if (!model) {
    vscode.window.showInformationMessage('No VS Code language model provider is available.');
    return;
  }
  const payload = {
    diagnostics: lastDiagnostics.slice(0, 3).map((diagnostic) => ({
      code: getCode(diagnostic),
      message: diagnostic.message,
      primary: getPrimarySpan(diagnostic),
      children: diagnostic.children
    })),
    deterministicReport: lastReportText.slice(0, 8000)
  };
  const prompt = [
    'Explain these Rust compiler diagnostics for a developer.',
    'Use the compiler JSON and deterministic report as the source of truth.',
    'Do not invent compiler behavior. Label any fix ranking as AI-assisted and not compiler-verified.',
    '',
    JSON.stringify(payload, null, 2)
  ].join('\n');

  try {
    const messages = [vscode.LanguageModelChatMessage.User(prompt)];
    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
    let text = 'AI-assisted explanation (not compiler-verified)\n================================================\n\n';
    for await (const fragment of response.text) {
      text += fragment;
    }
    lastReportText = `${lastReportText}\n\n${text}`;
    lastReportHtml = textReportHtml('Rust Ownership Lens', lastReportText, { cwd: lastRunCwd });
    viewProvider.update(lastReportHtml, lastReportText);
  } catch (err) {
    vscode.window.showErrorMessage(`AI explanation failed: ${err.message || err}`);
  }
}

function makeForLoopQuickFix(document, lineNumber, parsed, replacement, title) {
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  const edit = new vscode.WorkspaceEdit();
  const range = new vscode.Range(lineNumber, parsed.collectionStart, lineNumber, parsed.collectionEnd);
  edit.replace(document.uri, range, replacement);
  action.edit = edit;
  action.isPreferred = replacement.startsWith('&') && !replacement.startsWith('&mut');
  return action;
}

function parseMovableForLoopLine(line) {
  const match = String(line || '').match(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(?!&)([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (!match) return undefined;
  const collection = match[2];
  const collectionStart = match.index + match[0].lastIndexOf(collection);
  return {
    item: match[1],
    collection,
    collectionStart,
    collectionEnd: collectionStart + collection.length
  };
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
      } else if (message.command === 'openLocation') {
        await openReportLocation(message.file, message.line, message.column);
      } else if (message.command === 'explainError') {
        await showRustExplain(message.code);
      } else if (message.command === 'aiExplain') {
        await explainWithLanguageModel();
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
  const aiButton = vscode.lm ? '<button id="ai">AI explain</button>' : '';
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
    button.linkish {
      border: 0;
      background: transparent;
      color: var(--vscode-textLink-foreground);
      padding: 0;
      font: inherit;
      text-decoration: underline;
    }
    button.linkish:hover {
      background: transparent;
      color: var(--vscode-textLink-activeForeground);
    }
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
    ${aiButton}
  </div>
  <main>${innerHtml}</main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('run').addEventListener('click', () => vscode.postMessage({ command: 'runCheck' }));
    document.getElementById('selection').addEventListener('click', () => vscode.postMessage({ command: 'explainSelection' }));
    document.getElementById('copy').addEventListener('click', () => vscode.postMessage({ command: 'copy' }));
    const ai = document.getElementById('ai');
    if (ai) ai.addEventListener('click', () => vscode.postMessage({ command: 'aiExplain' }));
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-open-location], [data-explain-code]');
      if (!target) return;
      event.preventDefault();
      if (target.dataset.openLocation) {
        vscode.postMessage({
          command: 'openLocation',
          file: target.dataset.file,
          line: Number(target.dataset.line),
          column: Number(target.dataset.column)
        });
      } else if (target.dataset.explainCode) {
        vscode.postMessage({ command: 'explainError', code: target.dataset.explainCode });
      }
    });
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

function loadingHtml(cwd, command, args, mode) {
  const text = [
    'Running cargo check...',
    '',
    `Workspace: ${cwd}`,
    `Command: ${command} ${args.join(' ')}`,
    mode ? `Mode: ${mode}` : '',
    '',
    'Waiting for cargo JSON diagnostics.'
  ].filter((line) => line !== '').join('\n');
  return textReportHtml('Running', text, { cwd });
}

function textReportHtml(title, text, options = {}) {
  return `<h2>${escapeHtml(title)}</h2><pre>${linkifyReportText(text, options.cwd)}</pre>`;
}

function linkifyReportText(text, cwd) {
  const regex = /(rustc --explain (E\d{4}))|((?:[A-Za-z]:\\|\\\\|\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s:`]+\.rs):(\d+):(\d+)/g;
  let html = '';
  let lastIndex = 0;
  for (const match of String(text).matchAll(regex)) {
    html += escapeHtml(String(text).slice(lastIndex, match.index));
    if (match[1]) {
      html += `<button class="linkish" data-explain-code="${escapeHtml(match[2])}">${escapeHtml(match[1])}</button>`;
    } else {
      const display = `${match[3]}:${match[4]}:${match[5]}`;
      const file = resolveDiagnosticFile(match[3], cwd);
      html += `<button class="linkish" data-open-location="1" data-file="${escapeHtml(file)}" data-line="${escapeHtml(match[4])}" data-column="${escapeHtml(match[5])}">${escapeHtml(display)}</button>`;
    }
    lastIndex = match.index + match[0].length;
  }
  html += escapeHtml(String(text).slice(lastIndex));
  return html;
}

async function openReportLocation(fileName, line, column) {
  if (!fileName || !vscode.Uri || !vscode.Range) return;
  const lineIndex = Math.max(0, Number(line || 1) - 1);
  const columnIndex = Math.max(0, Number(column || 1) - 1);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fileName));
  const editor = await vscode.window.showTextDocument(document, { preview: true });
  const position = new vscode.Position(lineIndex, columnIndex);
  const range = new vscode.Range(position, position);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
    getCargoRunConfig,
    hasJsonMessageFormat,
    deduplicateDiagnostics,
    prioritizeDiagnostics,
    isKnownDiagnostic,
    resolveCommandForSpawn,
    getCode,
    guessVariable,
    formatDiagnosticPath,
    formatSpanLocation,
    diagnosticSummary,
    linkifyReportText,
    isForLoopIteratorMoveDiagnostic,
    parseMovableForLoopLine,
  }
};
