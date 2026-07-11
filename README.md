<!-- i18n: language-switcher -->
[English](README.md) | [日本語](README.ja.md)

# Rust Ownership Lens

[![CI](https://github.com/hjosugi/rust-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/hjosugi/rust-lens/actions/workflows/ci.yml)

Rust Ownership Lens is a VS Code extension prototype that explains Rust ownership, borrowing, lifetime, iterator, and async errors with plain text and ASCII timelines.

It is designed as a developer tool for people who are new to Rust but still need to work inside real Rust projects.

## What it does

- Runs `cargo check --message-format=json` in the current workspace.
- Parses Rust compiler JSON diagnostics.
- Explains common ownership and lifetime errors.
- Shows ASCII timelines in a VS Code side panel.
- Publishes compiler-derived diagnostics to the Problems panel.
- Adds clickable source locations in reports.
- Adds simple Rust hover hints for `&`, `&mut`, `for ... in`, `.clone()`, and `tokio::spawn(async { ... })`.
- Offers high-confidence Quick Fixes from rustc suggestions and iterator borrow rewrites.
- Can run on save with debouncing and single-flight process control.
- Can fall back to `rustc` for standalone `.rs` files without `Cargo.toml`.
- Can run `cargo clippy`, `cargo tree`, `cargo expand`, and `rustc --explain` helper flows.
- Can reuse existing rust-analyzer/rustc diagnostics instead of launching cargo when available.
- Can generate reports from a CLI with `rust-lens explain`.
- Can explain a selected Rust snippet with heuristic rules.

## Supported errors in this prototype

- `E0106`: missing lifetime specifier
- `E0277`: trait bound not satisfied
- `E0373`: closure or async block may outlive borrowed data
- `E0382`: use of moved value, including `for item in collection` iterator moves
- `E0499`: cannot borrow as mutable more than once
- `E0502`: mutable borrow conflicts with immutable borrow
- `E0505`: cannot move out because it is borrowed
- `E0515`: cannot return reference to local variable
- `E0597`: borrowed value does not live long enough
- `E0716`: temporary value dropped while borrowed
- Clippy clone/to-owned lints such as `clippy::redundant_clone`

## Design docs

- [Design](docs/DESIGN.md)
- [Tool comparison](docs/COMPARISON.md)

## Compatibility

- Minimum supported Rust compiler: `rustc 1.75.0`.
- CI runs the extension tests on Ubuntu, macOS, and Windows.
- CI also checks the intentionally failing `examples/iterator-move.rs` target against real rustc JSON output.
- The parser accepts rustc diagnostics with or without the newer `$message_type` field.
- Rustup workspace overrides are supported because the extension runs `cargo` in the active workspace directory, so local `rust-toolchain.toml` files are honored by rustup.

## Install from VSIX

If you have the `.vsix` file:

```bash
code --install-extension rust-ownership-lens-0.1.0.vsix
```

Then restart VS Code.

## Build a VSIX

Preferred path:

```bash
npm install
npm run package
```

Offline fallback that uses `zip` instead of `vsce`:

```bash
npm run package:offline
```

## CLI

After installing package dependencies, the CLI can read cargo/rustc JSON from stdin or files:

```bash
cargo check --message-format=json 2>&1 | npx rust-lens explain
rust-lens explain --json cargo-output.jsonl
```

## Install from zip folder

If you have the zip source folder:

```bash
unzip rust-ownership-lens-vscode.zip
cd rust-ownership-lens-vscode
./scripts/install-local.sh
```

Then restart VS Code.

## Run in extension development mode

Open this folder in VS Code and press `F5`.

The Extension Development Host will open. In that new window, open a Rust workspace and run:

```text
Rust Ownership Lens: Run cargo check
```

## Commands

- `Rust Ownership Lens: Run cargo check`
- `Rust Ownership Lens: Explain Selected Rust Code`
- `Rust Ownership Lens: Show Panel`
- `Rust Ownership Lens: Copy Last Explanation`
- `Rust Ownership Lens: Insert Example Error`
- `Rust Ownership Lens: Explain Dependency`
- `Rust Ownership Lens: Expand Macro at Cursor`

## Example output

```text
Issue 1: error[E0502]
---------------------
File: src/main.rs:4:5
Message: cannot borrow `users` as mutable because it is also borrowed as immutable
Main value: users

Problem:
  users is borrowed in one way, then borrowed in a conflicting way before the first borrow ends.

Borrow ASCII:
users:  ---- immutable borrow ----+
users:        mutable borrow X    |
                                |
The read borrow and write borrow overlap.

Best fixes:
  A. Use the immutable reference before mutating the original value.
  B. Move the mutation after the last use of the immutable borrow.
  C. Clone only the needed field if the value must outlive the borrow.
  D. Split the scope with `{ ... }` so the borrow ends earlier.
```

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `rustOwnershipLens.cargoCommand` | `cargo` | Cargo executable path. |
| `rustOwnershipLens.cargoArgs` | `["check", "--message-format=json"]` | Arguments for Cargo. Keep JSON output enabled. |
| `rustOwnershipLens.useClippy` | `false` | Run `cargo clippy --message-format=json` by default. |
| `rustOwnershipLens.includeWarnings` | `false` | Include warning diagnostics in the report. |
| `rustOwnershipLens.maxDiagnostics` | `20` | Maximum diagnostics shown after de-duplication. |
| `rustOwnershipLens.showHoverHints` | `true` | Enable lightweight hover hints. |
| `rustOwnershipLens.hoverOnlyOnDiagnostics` | `true` | Show hovers only on current diagnostic lines. |
| `rustOwnershipLens.showInlineTimeline` | `true` | Show inline event markers for borrow/move/use/drop spans. |
| `rustOwnershipLens.runOnSave` | `false` | Re-run diagnostics when a Rust file is saved. |
| `rustOwnershipLens.timeoutSeconds` | `300` | Stop long-running cargo/rustc checks after this many seconds. |
| `rustOwnershipLens.singleFileEdition` | `2024` | Edition used for standalone `.rs` fallback checks. |
| `rustOwnershipLens.language` | `en` | Explanation language: `en` or `ja`. |
| `rustOwnershipLens.diagnosticSource` | `auto` | Reuse existing rust-analyzer/rustc diagnostics when possible, or always run cargo/rustc. |

## Visual preview

```text
users:  ---- immutable borrow ----+
users:        mutable borrow X    |
                                |
The read borrow and write borrow overlap.
```

The Webview report uses this same ASCII timeline and turns `src/main.rs:4:5` locations into clickable source links.

## Current limitations

This is an MVP prototype.

- It does not replace rust-analyzer.
- It depends on `cargo check` output.
- The ASCII timeline uses rustc spans when available, so quality depends on the compiler diagnostic.
- Auto-fix is intentionally limited to rustc suggestions and small high-confidence rewrites.
- The selection explainer is heuristic and should not be treated as compiler truth.

## Next features

- Inline CodeLens explanations near the error span.
- Safer quick fixes with confidence labels.
- Better variable tracking from rust-analyzer or HIR.
- Team rules such as "prefer borrow over clone".
- PR bot output for GitHub comments.
- Async-specific explanations for `Send`, `'static`, and `async move`.

## License

0BSD. You can use, copy, modify, and distribute this project for almost any purpose.
