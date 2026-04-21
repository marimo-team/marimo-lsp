# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo layout

This is a **dual-stack monorepo**: a Python LSP server and a TypeScript VS Code extension that talk to each other.

- `src/marimo_lsp/` — Python LSP server (pygls-based). Bridges VS Code's notebook protocol to a marimo `Session`/kernel.
- `extension/` — VS Code extension (TypeScript, Effect-TS). Consumes the LSP, renders cells, manages kernels.
- `tests/` — pytest tests for the LSP server (uses `pytest-lsp` for in-process client).
- `extension/src/**/__tests__/` — vitest unit tests, colocated with source.
- `extension/tests/` — `@vscode/test-cli` integration tests that launch a real VS Code instance.
- `scripts/` — release / maintenance Python scripts (e.g. `generate_release_notes.py`).

The Python server is pinned to a specific `marimo` version (`.marimo-version`). For local dev, clone `marimo-team/marimo` as a sibling directory and check out that tag — the extension links `@marimo-team/frontend`, `@marimo-team/openapi`, and `@marimo-team/smart-cells` from `../../marimo/`. CI does this automatically.

## Common commands

Toolchain: **`uv`** for Python, **`pnpm`** for Node, **`just`** as task runner.

**NEVER** invoke `python`/`pip` directly — use `uv run ...` / `uv pip ...`.

Run `just --list` to see available recipes. They're bucketed into `lint`, `fix`, `test`, `build`, and `setup` groups; recipes that accept pytest/vitest args take them as trailing positional args (`just test-py -v -k name`, `just test-ts --watch`).

To launch the extension for manual testing, open the repo in VS Code and press **F5**.

## Architecture

Read `ARCHITECTURE.md` first — it documents the custom LSP protocol (commands like `marimo.run`, `marimo.serialize`, `marimo.set_ui_element_value`, and the `marimo/operation` server→client notification stream). The key mental model:

1. **VS Code notebook protocol** handles cell text sync (`notebookDocument/didOpen`, `didChange`, ...).
2. **Custom LSP commands** drive kernel actions (run cells, interrupt, call UI element functions, (de)serialize).
3. **`marimo/operation` notifications** stream kernel output/state (`cell-op`, `variables`, `data-*-preview`, `alert`, package install progress, …) from server to client.

### Python side (`src/marimo_lsp/`)

- `server.py` — pygls `LanguageServer` with handlers for notebook lifecycle + custom commands.
- `session_manager.py` — `LspSessionManager`: notebook URI → marimo `Session`. Sessions are created lazily on first `marimo.run` and closed on untitled-close, executable change, or shutdown. **URIs are the session key** — they're unstable across rename, so some operations can lose track.
- `session.py`, `session_consumer.py`, `app_file_manager.py`, `kernel_manager.py` — LSP-flavored adapters around marimo's internals (`SessionConsumer`, `AppFileManager`, `KernelManager`) that read from in-memory LSP documents instead of files.
- `completions.py`, `diagnostics.py`, `_rules.py` — language features (trigger-char completion for `@cell_name`, diagnostics).
- `package_manager.py`, `api.py`, `models.py` — package-install flow and shared LSP request/response schemas.

### TypeScript side (`extension/src/`)

Built on **Effect-TS**. Everything is wired as `Layer`s (services) assembled in `layers/Main.ts` via `makeActivate(...)` in `features/Main.ts`. Directory roles:

- `features/` — top-level layers that only register side effects (commands, codelens, file detection, theme sync, debug, cell-metadata bindings).
- `services/`, `kernel/`, `notebook/`, `config/`, `lsp/`, `platform/`, `python/`, `telemetry/` — the actual services composed into `MainLive`. E.g. `KernelManager` consumes `marimo/operation`, `ExecutionRegistry` drives `NotebookCellExecution` state, `CellStateManager` tracks stale cells and the `marimo.notebook.hasStaleCells` context key, `NotebookRenderer` renders `application/vnd.marimo+html` MIME outputs, `VariablesService`/`DatasourcesService`/`PackagesService` back the tree views.
- `commands/` — one file per VS Code command registered in `package.json`.
- `renderer/` — webview-side notebook renderer (`renderer.tsx`) that embeds marimo's frontend.
- `panel/`, `views/` — tree views for recents, variables, datasources, packages.
- `lsp/` — language-client wiring + inner servers (`RuffLanguageServer`, `TyLanguageServer`) used when managed language features are enabled.
- `lib/`, `utils/`, `schemas/`, `vendor/`, `__mocks__/` — supporting code.

Cells use a dedicated language id `mo-python` so external Python LSPs don't double up on completions/diagnostics. Users can opt out with `marimo.disableManagedLanguageFeatures`.

## Philosophy

Tests, types, and lints are pedantic on purpose: they're load-bearing tools, not ceremony. Opting out is rarely the right call, but is allowed only with a thoughtful and clear explanation of *why*.

## Effect-TS

**Treat Effect as part of this codebase, not a third-party library.** The extension is built on Effect top-to-bottom — services, layers, fibers, scopes, schemas, streams — and writing idiomatic extension code means reaching for the right Effect primitive instead of reinventing it. Before adding a new abstraction (a queue, a cache, a retry wrapper, a resource lifecycle), ask whether Effect already has it.

Invoke the project-local `/effect-ts` skill ([`.claude/skills/effect-ts/SKILL.md`](.claude/skills/effect-ts/SKILL.md)) — start there; it indexes deeper references under `references/` for each primitive.

When the reference doesn't cover something, reading the Effect source directly is usually the fastest way to resolve a question — the public API lives in `packages/effect/src/ModuleName.ts` and the implementation in `packages/effect/src/internal/`. One option is to clone `github.com/Effect-TS/effect` somewhere on your machine so you can grep it, but any approach that lets you read the source works.

### Local Effect conventions (from `CONTRIBUTING.md`)

- Use Effect's native logger primitives — no custom logging utilities.
- Name top-level functions: `Effect.fn("namespace.operation")(function*(){...})`.
- Put variable data in `Effect.annotateLogs({ … })` / `Effect.annotateCurrentSpan(...)`, not interpolated into the message.
- Wrap important external calls with `Effect.withSpan("lsp.executeCommand", { attributes: {...} })`.

### Prefer Schema or type guards over type assertions

Think of `as T`, `!` (non-null), and `as unknown as T` the way Rust thinks of `unsafe`: the compiler's contract is off and you're staking your word that you know more than it does. Sometimes that's true — but rarely. A wrong type assertion surfaces as neither a type error nor a runtime error, just silent propagation, and that throws away the exact property we picked Effect for (`Effect<A, E, R>` making every error and dependency explicit).

The convention: reach for real checks by default; assertions only in the rare case you genuinely know more than the compiler.

**Use instead:**
- **`Schema`** (Effect's `Schema`) at boundaries — once data is parsed, the type is earned.
- **Type guards / predicates** (`function isUser(x): x is User`) for narrowing within flow.
- **Plain narrowing** — `typeof`, `instanceof`, equality, discriminants — is often enough. In `catch`, narrow with `instanceof` or let typed Effect errors carry the shape.
- **`assert(...)`** for runtime invariants the compiler can't see; it narrows *and* crashes loudly on violation, which is the point.

**When a type assertion is warranted**, leave a `// SAFETY:` comment right above it — same convention Rust uses for every `unsafe` block. State the invariant you're staking, not what the code does, so the next reader can check your reasoning.

```ts
// SAFETY: routeOperation only forwards cell-op messages whose cellId
// is present in `executions`; we guard the lookup on line 84.
const execution = executions.get(cellId) as NotebookCellExecution;
```

No `// SAFETY:` comment, no type assertion.

This extends to tests. Don't `{} as FooService` your way to a mock — fully `implements` the interface (see `src/__mocks__/Test*.ts`), or introduce a test-scoped branded type / helper that restricts the surface *and* gets checked. If the mock is hard to write, the seam is wrong, not the types.

Background: [Be assertive](https://trevorma.nz/blog/be-assertive), [Catch errors carefully](https://trevorma.nz/blog/catch-errors-carefully).

## Testing

**Write tests. Not too many. Mostly integration.** ([write-tests](https://kentcdodds.com/blog/write-tests)) Integration tests are where real confidence lives — unit tests that mock out everything around the code under test give you a green bar without proving the pieces fit. For most bugfixes there's a high-value test worth adding; take a quiet moment to think about what shape of test would actually catch the bug next time, and how to make it reviewable as a diff.

**`just test-vscode` (`@vscode/test-cli`)** drives the real extension inside a real VS Code instance (`extension/tests/*.test.cjs`). This is where most user-facing confidence is earned: a green test here proves the extension behaves the way a user actually uses it, end-to-end. Slower per run, but the runner is good enough to make reliable integration coverage worth the wall-clock.

**`just test-py` (pytest + `pytest-lsp`)** is integration-shaped by default: it spins up a real `marimo-lsp` subprocess over stdio and drives the full protocol. The obvious place for anything that touches an LSP request/response shape.

**`just test-ts` (vitest)** gives high leverage on individual services in partial isolation — the service-oriented layering means you can feed a service the events it'd normally receive from upstream and assert on what it does, without booting the whole runtime. `src/__mocks__/Test*.ts` has real `implements`-based stand-ins; `Effect.die("not implemented")` on methods the code-under-test shouldn't touch makes boundary violations loud instead of silent. Effect's `Layer` pattern makes mocking frictionless, which also makes over-mocking tempting — ask whether the test is still exercising behavior a user could observe.

**Snapshot tests pull a lot of weight** — `inline-snapshot` (pytest) and `toMatchInlineSnapshot` (vitest) put the expected shape of a protocol message or serialized output right next to the test body, so PR reviewers see the expected output in the diff and regressions surface as line-by-line changes. Regen with `uv run pytest --inline-snapshot=create` (or `=fix`); pair with `dirty-equals` matchers to keep non-deterministic fields out of the recorded shape.

## Other conventions

### Python

- Ruff is configured with `select = ["ALL"]` plus a curated ignore list in `pyproject.toml`. Tests have extra ignores (asserts allowed, no docstring requirement, etc.).
- Type-check with `ty` (not mypy). Extension files are excluded from `ty`.
- `inline-snapshot` is wired up with `ruff format` — regenerate with `uv run pytest --inline-snapshot=create` (or `=fix`).

### Python kernel compatibility

Two distinct version pins live in `pyproject.toml`:

- `dependencies.marimo == <exact>` — the version the LSP server *ships with* (bundled frontend + Python API). Auto-bumped by the `update-marimo-version` cron.
- `[tool.marimo-lsp] minimum-kernel-version` — the floor we claim to support in the *user's* kernel env. Bumped manually when intentionally dropping support.

Don't conflate these when editing. The cron only touches the first.

## Gotchas

- **Marimo controllers leave `executionOrder` undefined.** Tests that wait for `executionOrder` to increment will hang forever — gate on cell state or output instead.
- **`ARCHITECTURE.md` file-path references can lag the code** (services were renamed/moved from `services/` into subdirs like `kernel/`, `notebook/`, `config/`). Prefer grep over trusting a stale path.
