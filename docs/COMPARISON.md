<!-- i18n: language-switcher -->
[English](COMPARISON.md) | [日本語](COMPARISON.ja.md)

# Rust Ownership Lens Comparison

Rust Ownership Lens is not a replacement for Rust IDEs, linters, fixers, visualizers, or courses. Its niche is narrower: translate real compiler diagnostics for ownership and lifetime errors into concise explanations and timelines inside the editor.

## Feature Matrix

| Tool | Primary job | Compiler-backed diagnostics | Ownership explanation | Timeline/visual model | Fix/apply edits | Rust Ownership Lens stance |
| --- | --- | --- | --- | --- | --- | --- |
| rust-analyzer | Rust language server for IDE features | Yes, via check/flycheck integration | Limited to diagnostics and assists | No focused ownership timeline | Assists/refactors | Complement; do not duplicate LSP features. |
| RustRover | Full JetBrains Rust IDE | Yes, integrated Cargo/rustc tooling | IDE inspections and help | No dedicated ASCII ownership timeline | IDE quick fixes/refactors | Conceptual complement; same translator model could fit an IDE plugin. |
| Error Lens | Makes editor diagnostics more visible | Uses diagnostics from other tools | No Rust-specific teaching layer | No | No | Complement; can render Rust Lens Problems output if added. |
| cargo clippy/fix | Lints and applies compiler suggestions | Yes | Lint/fix oriented, not teaching oriented | No | Yes, for machine-applicable suggestions | Reuse suggestions; avoid inventing unsafe auto-fixes. |
| rustc `--explain` / error index | Canonical error-code reference | Yes | Deep general explanations | No per-project timeline | No | Link or summarize; Rust Lens adds project-specific context. |
| Aquascope / RustViz / BORIS | Ownership and borrow visualization | Varies by tool | Strong learning focus | Yes, richer visualization | No/limited | Inspiration; Rust Lens stays lightweight and diagnostic-driven. |
| bacon / cargo-watch | Re-run Cargo commands on changes | Yes, through Cargo output | No | No | No | Possible driver/integration source; avoid duplicate watchers initially. |
| Rustlings | Guided Rust exercises | Uses compiler feedback in exercises | Curriculum-based | No focused editor timeline | User edits exercises | Complement for learners working through real compiler messages. |

## Integration Stance

- **rust-analyzer:** Rust Ownership Lens should coexist with rust-analyzer. rust-analyzer owns completions, navigation, semantic analysis, and normal editor diagnostics; Rust Lens owns explanatory reports for selected compiler diagnostics.
- **RustRover:** RustRover already provides an integrated Rust environment. Rust Lens should treat it as a separate IDE surface, not as a dependency. The useful idea is portable: compiler diagnostics in, explanatory timeline out.
- **Error Lens:** Error Lens improves visibility of existing VS Code diagnostics. If Rust Lens later publishes a `DiagnosticCollection`, Error Lens can display those messages without Rust Lens building inline decoration logic.
- **cargo clippy/fix:** Clippy and `cargo fix` are authoritative tooling for lints and machine-applicable suggestions. Rust Lens should surface rustc suggestions and confidence labels, not silently rewrite ownership code.
- **rustc `--explain` and the error index:** These are canonical references for error codes. Rust Lens should not copy them wholesale; it should link to them and add local span order, main value, and concrete fix choices.
- **Aquascope, RustViz, and BORIS:** These projects show richer visual learning models for ownership and borrowing. Rust Lens should borrow the pedagogical lesson, not the scope: short ASCII timelines tied to real diagnostics are enough for the VS Code MVP.
- **bacon and cargo-watch:** These tools are good at continuous Cargo runs. Rust Lens can integrate with their output or learn from their workflows later, but the extension should first keep manual runs predictable and cancellable.
- **Rustlings:** Rustlings is a curriculum. Rust Lens can help explain compiler errors encountered while doing exercises, but it should not become a course or exercise runner.

## References

- rust-analyzer manual: https://rust-analyzer.github.io/manual.html
- RustRover: https://www.jetbrains.com/rust/
- Error Lens: https://marketplace.visualstudio.com/items?itemName=usernamehw.errorlens
- Clippy usage: https://doc.rust-lang.org/clippy/usage.html
- Cargo fix: https://doc.rust-lang.org/cargo/commands/cargo-fix.html
- Rust documentation and error explanations: https://doc.rust-lang.org/
- Aquascope: https://github.com/cognitive-engineering-lab/aquascope
- RustViz: https://github.com/rustviz/rustviz
- BORIS: https://github.com/ChristianSchott/boris
- bacon: https://github.com/Canop/bacon
- cargo-watch: https://github.com/watchexec/cargo-watch
- Rustlings: https://rustlings.rust-lang.org/
