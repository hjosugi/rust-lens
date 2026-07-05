# Changelog

This project follows Keep a Changelog-style sections: Added, Changed, Fixed, and Security.

## Unreleased

### Added

- Added VSIX packaging via `@vscode/vsce` and an offline `scripts/package-vsix.sh` fallback.
- Added GitHub Actions VSIX artifact upload.
- Added design and comparison documentation.
- Added Japanese README.
- Added Problems panel diagnostics, clickable report locations, and inline ownership timeline decorations.
- Added run-on-save, timeout, cancellation, single-file `rustc`, Clippy, `cargo tree`, `cargo expand`, `rustc --explain`, and optional VS Code Language Model helper flows.
- Added `rust-lens explain` CLI, Japanese deterministic templates, workspace package selection, and existing diagnostic reuse.
- Added examples and tests for E0499, E0505, E0597, and E0716.

### Changed

- Diagnostics are de-duplicated and known ownership/lifetime errors are prioritized before `maxDiagnostics` is applied.
- Hover hints are scoped to diagnostic lines by default to reduce rust-analyzer overlap.

## 0.1.0

- Initial prototype.
- Parse cargo JSON diagnostics.
- Explain E0382, E0499, E0502, E0505, E0515, E0597, E0716.
- Show ASCII timelines in a side panel.
- Add simple hover hints.
- Add heuristic selection explainer.
