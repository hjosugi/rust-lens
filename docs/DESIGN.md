<!-- i18n: language-switcher -->
[English](DESIGN.md) | [日本語](DESIGN.ja.md)

# Rust Ownership Lens Design

Rust Ownership Lens is built on one rule: **the compiler is the source of truth; the extension is the translator**. The extension should not try to reimplement borrow checking. It runs Rust's own tools, reads structured diagnostics, and turns those diagnostics into learner-friendly explanations, timelines, and focused editor actions.

## Goals

- Explain real `rustc` ownership, borrow, lifetime, iterator, and async diagnostics in plain language.
- Preserve the compiler's authority by basing explanations on `cargo check --message-format=json`.
- Show why an error happened through compact ASCII timelines tied to rustc spans.
- Stay useful inside real projects without replacing rust-analyzer, Cargo, Clippy, or rustc docs.

## Architecture Flow

```text
cargo check --message-format=json
  -> JSON line parser
  -> diagnostic extractor/filter
  -> ownership/lifetime templates
  -> span event timeline
  -> Webview panel / OutputChannel / Problems integration
```

The same parser/report path is also available from `rust-lens explain`, so editor-independent consumers can pipe cargo/rustc JSON into the tool without starting VS Code.

Current implementation details:

- `runCargoCheck` runs the configured cargo command in the active workspace.
- `parseCargoJsonMessages` accepts Cargo-wrapped compiler messages and direct rustc JSON diagnostics, including diagnostics with or without `$message_type`.
- `extractDiagnostics` filters errors by default and can include warnings through configuration.
- `templateForDiagnostic` maps known error codes to explanations and fix guidance.
- `buildEvents` and `renderEventTimeline` convert rustc spans and child spans into ordered timeline rows.
- `RustLensViewProvider` renders the report in the VS Code side Webview.
- The `Rust Ownership Lens` OutputChannel stores raw cargo output and the generated report.
- Problems integration is the natural presentation boundary for future `DiagnosticCollection` support; any Problems entry should still be derived from rustc diagnostics, not from independent borrow-checker guesses.

## Module Boundaries

The prototype currently lives in `extension.js`, but the logical boundaries are:

- **Cargo runner:** workspace detection, trusted-workspace config handling, command spawning, JSON message-format checks.
- **Parser:** line-oriented JSON parsing plus compatibility with Cargo and rustc diagnostic shapes.
- **Diagnostic model:** code extraction, primary span selection, path normalization, source snippets, variable guessing.
- **Explainers:** error-code templates, iterator-move specialization, rustc child messages, fallback compact diagnostics.
- **Timeline:** span classification (`borrow`, `move`, `drop`, `use`, `return`, `primary error`) and ASCII rendering.
- **Presentation:** Webview HTML, OutputChannel text, status bar state, hover hints, code actions, future Problems bridge.
- **CLI:** `bin/rust-lens.js` is a thin entrypoint over the parser/report builder for `rust-lens explain [--json]`.
- **Heuristics:** selected-code explanations and lightweight hovers. These must be clearly labeled as heuristic and secondary to cargo output.
- **Tests and compatibility checks:** Node tests for parser/config/template behavior and script checks against real rustc JSON.

Future refactors should preserve these boundaries before adding new features.

## Supported Error Codes

| Code | Current explanation focus |
| --- | --- |
| `E0106` | Missing lifetime specifier; explain where returned or stored references must come from. |
| `E0382` | Use or borrow after move; includes a dedicated `for item in collection` iterator-move path. |
| `E0499` | Multiple overlapping mutable borrows. |
| `E0502` | Mutable borrow conflicts with an active immutable borrow. |
| `E0505` | Move while a value is still borrowed. |
| `E0515` | Returning a reference to local data. |
| `E0597` | Borrowed value does not live long enough. |
| `E0716` | Temporary value dropped while still borrowed. |

Unknown diagnostics should remain visible as compact compiler diagnostics so users do not lose information.

## Roadmap

### Foundation

- Keep rustc/Cargo JSON as the truth boundary.
- Keep parser compatibility broad across rustc JSON shapes and workspace toolchain overrides.
- Split the single-file prototype along the module boundaries above when feature growth requires it.

### MVP

- Maintain Webview and OutputChannel reports for supported ownership/lifetime diagnostics.
- Keep selected-code and hover explanations clearly marked as heuristics.
- Add only high-confidence quick fixes, preferably when rustc already provides a suggestion.

### Timeline, Async, Trait

- Improve span timelines for multi-file diagnostics and macro-expanded spans.
- Add async-specific templates for `Send`, `'static`, `async move`, and spawned task lifetimes.
- Add trait/object lifetime explanations where rustc gives enough structured context.

### Cargo, Macro

- Support `cargo check`, `cargo clippy`, and targeted package/bin/test arguments without hiding the actual command.
- Handle macro-heavy diagnostics by walking related spans back to the user-authored call site when available.
- Avoid running background watchers until cancellation, debouncing, and workspace trust behavior are explicit.

### CLI, LSP

- Keep the CLI contract stable, then extract the parser and report builder into a dedicated package when the public shape settles.
- Consider an LSP or diagnostic bridge only after the core format is stable.
- Publish Problems entries and machine-readable output from the same compiler-derived model used by the Webview.
