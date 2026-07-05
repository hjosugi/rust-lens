#!/usr/bin/env bash
set -euo pipefail
EXT_ID="local-rust-tools.rust-ownership-lens"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${HOME}/.vscode/extensions/${EXT_ID}-0.1.0"
rm -rf "${TARGET_DIR}"
mkdir -p "${TARGET_DIR}"
cp -R "${SRC_DIR}/." "${TARGET_DIR}/"
echo "Installed to ${TARGET_DIR}"
echo "Restart VS Code, then open a Rust workspace and run: Rust Ownership Lens: Run cargo check"
