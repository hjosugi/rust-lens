<!-- i18n: language-switcher -->
[English](README.md) | [日本語](README.ja.md)

# Rust Ownership Lens

[![CI](https://github.com/hjosugi/rust-lens/actions/workflows/ci.yml/badge.svg)](https://github.com/hjosugi/rust-lens/actions/workflows/ci.yml)

Rust Ownership Lensは、Rustの所有権、借用、ライフタイム、イテレータ、非同期エラーを平易なテキストとASCIIタイムラインで説明するVS Code拡張機能のプロトタイプです。

Rust初心者でも実際のRustプロジェクトで作業する必要がある開発者向けツールとして設計されています。

## 機能概要

- 現在のワークスペースで `cargo check --message-format=json` を実行します。
- RustコンパイラのJSON診断を解析します。
- よくある所有権やライフタイムのエラーを説明します。
- VS CodeのサイドパネルにASCIIタイムラインを表示します。
- コンパイラ由来の診断をProblemsパネルに公開します。
- レポート内のソース位置をクリック可能にします。
- `&`, `&mut`, `for ... in`, `.clone()`, `tokio::spawn(async { ... })` などの簡単なRustホバーヒントを追加します。
- rustcの提案やイテレータ借用の書き換えから高信頼のクイックフィックスを提供します。
- 保存時にデバウンスとsingle-flightプロセス制御で実行できます。
- `Cargo.toml`がない単独の`.rs`ファイルでは`rustc`にフォールバックできます。
- `cargo clippy`, `cargo tree`, `cargo expand`, `rustc --explain`などの補助フローを実行できます。
- 利用可能な場合は既存のrust-analyzer/rustc診断を再利用し、cargoの起動を省略できます。
- CLIからレポートを生成可能（`rust-lens explain`）。
- 選択したRustコードスニペットをヒューリスティックルールで説明できます。

## このプロトタイプで対応しているエラー

- `E0106`: ライフタイム指定子が不足している
- `E0277`: トレイト境界が満たされていない
- `E0373`: クロージャやasyncブロックが借用データより長く生存する可能性
- `E0382`: 移動済み値の使用（`for item in collection`イテレータ移動を含む）
- `E0499`: ミュータブルな借用が複数回できない
- `E0502`: ミュータブルな借用とイミュータブルな借用が競合
- `E0505`: 借用中の値を移動できない
- `E0515`: ローカル変数への参照を返せない
- `E0597`: 借用値の生存期間が十分でない
- `E0716`: 借用中に一時値がドロップされる
- Clippyのclone/to-owned系リント（例: `clippy::redundant_clone`）

## 設計ドキュメント

- [設計](docs/DESIGN.md)
- [ツール比較](docs/COMPARISON.md)

## 互換性

- 最低対応Rustコンパイラ: `rustc 1.75.0`
- CIは拡張機能のテストをUbuntu、macOS、Windowsで実行します。
- CIは意図的に失敗する `examples/iterator-move.rs` ターゲットを実際のrustc JSON出力で検証します。
- パーサーは新しい`$message_type`フィールドの有無に関わらずrustc診断を受け付けます。
- 拡張機能はアクティブなワークスペースディレクトリで`cargo`を実行するため、rustupのワークスペースオーバーライドやローカル`rust-toolchain.toml`が尊重されます。

## VSIXからインストール

`.vsix`ファイルを持っている場合:

```bash
code --install-extension rust-ownership-lens-0.1.0.vsix
```

その後、VS Codeを再起動してください。

## VSIXのビルド

推奨手順:

```bash
npm install
npm run package
```

`vsce`の代わりに`zip`を使うオフライン手順:

```bash
npm run package:offline
```

## CLI

パッケージ依存関係をインストール後、CLIはstdinやファイルからcargo/rustcのJSONを読み取れます:

```bash
cargo check --message-format=json 2>&1 | npx rust-lens explain
rust-lens explain --json cargo-output.jsonl
```

## zipフォルダーからインストール

zipソースフォルダーを持っている場合:

```bash
unzip rust-ownership-lens-vscode.zip
cd rust-ownership-lens-vscode
./scripts/install-local.sh
```

その後、VS Codeを再起動してください。

## 拡張機能開発モードで実行

このフォルダーをVS Codeで開き、`F5`を押してください。

Extension Development Hostが開きます。その新しいウィンドウでRustワークスペースを開き、次を実行します:

```text
Rust Ownership Lens: Run cargo check
```

## コマンド

- `Rust Ownership Lens: Run cargo check`
- `Rust Ownership Lens: Explain Selected Rust Code`
- `Rust Ownership Lens: Show Panel`
- `Rust Ownership Lens: Copy Last Explanation`
- `Rust Ownership Lens: Insert Example Error`
- `Rust Ownership Lens: Explain Dependency`
- `Rust Ownership Lens: Expand Macro at Cursor`

## 出力例

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

## 設定

| 設定 | デフォルト | 目的 |
| --- | --- | --- |
| `rustOwnershipLens.cargoCommand` | `cargo` | Cargo実行ファイルのパス。 |
| `rustOwnershipLens.cargoArgs` | `["check", "--message-format=json"]` | Cargoの引数。JSON出力を有効にしておくこと。 |
| `rustOwnershipLens.useClippy` | `false` | デフォルトで `cargo clippy --message-format=json` を実行するか。 |
| `rustOwnershipLens.includeWarnings` | `false` | レポートに警告診断を含めるか。 |
| `rustOwnershipLens.maxDiagnostics` | `20` | 重複除去後に表示する最大診断数。 |
| `rustOwnershipLens.showHoverHints` | `true` | 軽量なホバーヒントを有効にするか。 |
| `rustOwnershipLens.hoverOnlyOnDiagnostics` | `true` | 現在の診断行のみホバーを表示するか。 |
| `rustOwnershipLens.showInlineTimeline` | `true` | 借用/移動/使用/ドロップの範囲にインラインイベントマーカーを表示するか。 |
| `rustOwnershipLens.runOnSave` | `false` | Rustファイル保存時に診断を再実行するか。 |
| `rustOwnershipLens.timeoutSeconds` | `300` | cargo/rustcチェックのタイムアウト秒数。 |
| `rustOwnershipLens.singleFileEdition` | `2024` | 単独`.rs`ファイルのフォールバックチェックで使用するエディション。 |
| `rustOwnershipLens.language` | `en` | 説明言語: `en` または `ja`。 |
| `rustOwnershipLens.diagnosticSource` | `auto` | 可能なら既存のrust-analyzer/rustc診断を再利用、または常にcargo/rustcを実行。 |

## ビジュアルプレビュー

```text
users:  ---- immutable borrow ----+
users:        mutable borrow X    |
                                |
The read borrow and write borrow overlap.
```

Webviewレポートも同じASCIIタイムラインを使い、`src/main.rs:4:5`の位置をクリック可能なソースリンクにします。

## 現在の制限事項

これはMVPプロトタイプです。

- rust-analyzerの代替ではありません。
- `cargo check`の出力に依存します。
- ASCIIタイムラインは利用可能な場合rustcのspanを使うため、品質はコンパイラ診断に依存します。
- 自動修正は意図的にrustc提案や小規模な高信頼書き換えのみに限定しています。
- 選択コードの説明はヒューリスティックであり、コンパイラの真実として扱わないでください。

## 今後の機能

- エラー範囲付近へのインラインCodeLens説明
- 信頼度ラベル付きの安全なクイックフィックス
- rust-analyzerやHIRによるより良い変数追跡
- 「cloneよりborrowを優先」などのチームルール
- GitHubコメント用のPRボット出力
- `Send`, `'static`, `async move`向けの非同期特化説明

## ライセンス

0BSD。ほぼすべての目的で本プロジェクトを使用、コピー、改変、配布できます。