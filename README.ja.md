# Rust Ownership Lens

Rust Ownership Lens は、Rust の ownership / borrow / lifetime エラーを VS Code 上で読みやすく説明する拡張です。

方針は「compiler is source of truth, extension is translator」です。独自に borrow checker を再実装せず、`cargo check --message-format=json` や `rustc --error-format=json` の構造化診断を読み、平易な説明・ASCII タイムライン・Problems パネル・Quick Fix に変換します。

## できること

- `cargo check --message-format=json` を実行して診断を解析する
- `E0106`, `E0277`, `E0373`, `E0382`, `E0499`, `E0502`, `E0505`, `E0515`, `E0597`, `E0716` を説明する
- `for item in collection` が collection を move するケースを専用に説明する
- Webview / OutputChannel / Problems パネルに結果を表示する
- レポート内の `src/main.rs:4:5` からソースへジャンプする
- rustc suggestion と安全な iterator borrow rewrite を Quick Fix として提示する
- `Cargo.toml` がない単一 `.rs` ファイルでは `rustc` にフォールバックする
- `cargo clippy`, `cargo tree`, `cargo expand`, `rustc --explain` を補助的に呼び出す

## 使い方

1. VS Code で Rust workspace または `.rs` ファイルを開く
2. コマンドパレットで `Rust Ownership Lens: Run cargo check` を実行する
3. サイドバーの Rust Lens パネル、OutputChannel、Problems パネルを見る

保存時に自動実行したい場合:

```json
{
  "rustOwnershipLens.runOnSave": true
}
```

## VSIX の作成

```bash
npm install
npm run package
```

ネットワークなしで簡易 VSIX を作る場合:

```bash
npm run package:offline
```

詳しい設計は [docs/DESIGN.md](docs/DESIGN.md)、競合比較は [docs/COMPARISON.md](docs/COMPARISON.md) を参照してください。
