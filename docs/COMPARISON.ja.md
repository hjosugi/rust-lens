<!-- i18n: language-switcher -->
[English](COMPARISON.md) | [日本語](COMPARISON.ja.md)

# Rust所有権レンズの比較

Rust所有権レンズは、Rust IDE、リンター、フィクサー、ビジュアライザー、またはコースの代替品ではありません。そのニッチは狭く、所有権とライフタイムエラーに関する実際のコンパイラ診断を、エディタ内で簡潔な説明とタイムラインに変換することに特化しています。

## 機能マトリックス

| ツール | 主な役割 | コンパイラに基づく診断 | 所有権の説明 | タイムライン/ビジュアルモデル | 修正/適用編集 | Rust所有権レンズの立場 |
| --- | --- | --- | --- | --- | --- | --- |
| rust-analyzer | IDE機能のためのRust言語サーバー | はい、check/flycheck統合を介して | 診断と支援に限定 | 集中的な所有権タイムラインはなし | 支援/リファクタリング | 補完的; LSP機能を重複させない。 |
| RustRover | 完全なJetBrains Rust IDE | はい、統合されたCargo/rustcツール | IDEの検査とヘルプ | 専用のASCII所有権タイムラインはなし | IDEのクイックフィックス/リファクタリング | 概念的補完; 同じ翻訳モデルがIDEプラグインに適合する可能性がある。 |
| Error Lens | エディタの診断をより可視化する | 他のツールからの診断を使用 | Rust特有の教育層はなし | なし | なし | 補完的; Rust Lens Problemsの出力を表示できる。 |
| cargo clippy/fix | リンティングとコンパイラの提案を適用 | はい | リンティング/修正指向、教育指向ではない | なし | はい、機械適用可能な提案に対して | 提案を再利用; 安全でない自動修正を発明しない。 |
| rustc `--explain` / エラーインデックス | 標準的なエラーコードの参照 | はい | 深い一般的な説明 | プロジェクトごとのタイムラインはなし | なし | リンクまたは要約; Rust Lensはプロジェクト固有のコンテキストを追加する。 |
| Aquascope / RustViz / BORIS | 所有権と借用のビジュアライゼーション | ツールによって異なる | 強い学習焦点 | はい、より豊かなビジュアライゼーション | なし/制限あり | インスピレーション; Rust Lensは軽量で診断駆動のままである。 |
| bacon / cargo-watch | 変更時にCargoコマンドを再実行 | はい、Cargo出力を通じて | なし | なし | なし | 初期段階では重複するウォッチャーを避ける; 可能なドライバー/統合ソース。 |
| Rustlings | ガイド付きRust演習 | 演習内でコンパイラのフィードバックを使用 | カリキュラムベース | 集中的なエディタタイムラインはなし | ユーザーが演習を編集 | 実際のコンパイラメッセージを通じて学ぶ学習者のための補完。 |

## 統合の立場

- **rust-analyzer:** Rust所有権レンズはrust-analyzerと共存すべきです。rust-analyzerは補完、ナビゲーション、意味解析、通常のエディタ診断を担当し、Rust Lensは選択されたコンパイラ診断の説明レポートを担当します。
- **RustRover:** RustRoverはすでに統合されたRust環境を提供しています。Rust Lensはそれを依存関係としてではなく、別のIDE表面として扱うべきです。役立つアイデアはポータブルです: コンパイラ診断を入力し、説明タイムラインを出力します。
- **Error Lens:** Error Lensは既存のVS Code診断の可視性を向上させます。もしRust Lensが後に`DiagnosticCollection`を公開するなら、Error LensはRust Lensがインライン装飾ロジックを構築することなく、そのメッセージを表示できます。
- **cargo clippy/fix:** Clippyと`cargo fix`はリンティングと機械適用可能な提案の権威あるツールです。Rust Lensはrustcの提案と信頼ラベルを表示すべきであり、所有権コードを静かに書き換えるべきではありません。
- **rustc `--explain`とエラーインデックス:** これらはエラーコードの標準的な参照です。Rust Lensはそれらを丸ごとコピーすべきではなく、リンクし、ローカルスパン順序、主な値、具体的な修正選択肢を追加すべきです。
- **Aquascope、RustViz、BORIS:** これらのプロジェクトは所有権と借用のためのより豊かな視覚的学習モデルを示しています。Rust Lensは教育的な教訓を借りるべきであり、スコープを借りるべきではありません: 実際の診断に結びついた短いASCIIタイムラインで十分です。
- **baconとcargo-watch:** これらのツールは継続的なCargo実行に優れています。Rust Lensはそれらの出力と統合するか、後でそのワークフローから学ぶことができますが、拡張機能はまず手動実行を予測可能でキャンセル可能に保つべきです。
- **Rustlings:** Rustlingsはカリキュラムです。Rust Lensは演習中に遭遇したコンパイラエラーを説明するのを助けることができますが、コースや演習ランナーにはならないべきです。

## 参考文献

- rust-analyzerマニュアル: https://rust-analyzer.github.io/manual.html
- RustRover: https://www.jetbrains.com/rust/
- Error Lens: https://marketplace.visualstudio.com/items?itemName=usernamehw.errorlens
- Clippyの使用法: https://doc.rust-lang.org/clippy/usage.html
- Cargo fix: https://doc.rust-lang.org/cargo/commands/cargo-fix.html
- Rustのドキュメントとエラー説明: https://doc.rust-lang.org/
- Aquascope: https://github.com/cognitive-engineering-lab/aquascope
- RustViz: https://github.com/rustviz/rustviz
- BORIS: https://github.com/ChristianSchott/boris
- bacon: https://github.com/Canop/bacon
- cargo-watch: https://github.com/watchexec/cargo-watch
- Rustlings: https://rustlings.rust-lang.org/