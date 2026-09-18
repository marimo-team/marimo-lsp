## Quick Start

1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Open a marimo notebook (or create a new one)

## Development

Repository development requires [uv](https://docs.astral.sh/uv/),
[pnpm](https://pnpm.io/), and [just](https://just.systems/).
These are development tools, not prerequisites for installing the published
VS Code extension.

**Quickstart**

```sh
cd marimo-lsp
code .
# Press `F5` in VS Code (or "Run and Debug" > "Run Extension" in the UI).
```

> [!NOTE]
> The extension builds against the marimo release pinned by the exact
> `marimo-base` dependency in `pyproject.toml`. Both repositories must be
> cloned side-by-side:
>
> ```
> parent-folder/
> ├── marimo/          # Main marimo codebase
> └── marimo-lsp/      # This project
> ```
>
> For local development, checkout the matching version in the `marimo` directory:
>
> ```sh
> cd ../marimo
> git checkout $(cd ../marimo-lsp && uv run --no-project python -m scripts.marimo_version show)
> pnpm install --frozen-lockfile
> pnpm exec turbo run build --filter='./packages/*'
> ```
>
> Repeat the install and package build after switching marimo versions. The
> extension links directly to that checkout, including its frontend dependencies.
>
> CI derives the same source tag from the exact dependency. To update the Bundled
> marimo, run `uv run --no-project python -m scripts.marimo_version update`, or pass
> an exact release as the final argument. You may check out a different sibling ref
> temporarily when developing against unreleased marimo changes.

### Replaying the missing-ty prompt

The **Run Extension** F5 configuration sets `MARIMO_REPLAY_TY_PROMPT=1`.
In that development host, the missing-ty warning ignores saved dismissals and
does not persist new ones. Run **Developer: Reload Window** to try the flow
again. Remove the environment variable from `.vscode/launch.json` to test the
normal persistent dismissal behavior.

The warning only appears when no compatible ty binary is available. To test
the install flow again after installing ty, uninstall it in the development
host and clear any `marimo.ty.path` or `ty.path` overrides, then reload. Other
VS Code settings and extension state are preserved.

Development hosts and replay mode are excluded from the new ty telemetry.
See the [ty telemetry event guide](extension/src/telemetry/README.md) for event
semantics and suggested PostHog metrics.

### Pre-commit Hooks

To install pre-commit hooks:

```sh
uvx pre-commit install
```

This will run linting and formatting checks automatically before each commit.

### Common Commands

This project uses [just](https://just.systems/) for common development tasks.
Run `just --list` to see all recipes, grouped into `lint`, `fix`, `test`,
`build`, and `setup`. Highlights:

| Command              | Action                                       |
| -------------------- | -------------------------------------------- |
| `just lint`          | Lint + typecheck everything (py + ts)        |
| `just fix`           | Autofix + format everything (py + ts)        |
| `just test`          | Run all tests (`test-py` + `test-ts`)        |
| `just test-vscode`   | VS Code extension integration tests (slow)   |
| `just build`         | Embed the Python sdist and bundle the extension |

Recipes that wrap pytest or vitest forward trailing args:

```sh
just test-py -v                    # pytest with verbose output
just test-py tests/test_foo.py     # specific test file
just test-ts --watch               # vitest in watch mode
```

## Architecture

This repository contains a Python language server under `src/marimo_lsp/` and
a TypeScript VS Code extension under `extension/`. Start from these entry points
when tracing the current architecture:

- Python server: `src/marimo_lsp/server.py`
- VS Code extension: `extension/src/extension.ts`
- Effect layer composition: `extension/src/features/Main.ts`

Use the source tree to discover individual modules; their names and locations
change as the architecture evolves.

## Logging (Extension)

Use Effect's native logging primitives. Avoid custom logging utilities.

### Named Effect Functions

Add a name to `Effect.fn` for automatic span creation. Use `Effect.fnUntraced`
for inner/callback functions to avoid span overhead:

```ts
// Do: Named function at entry points
export const myCommand = Effect.fn("command.myCommand")(function* () {
  // Do: Untraced for callbacks (avoids extra span overhead)
  yield* SynchronizedRef.updateEffect(ref, Effect.fnUntraced(function* (value) { ... }));
});

// Don't: Anonymous at entry points
export const myCommand = Effect.fn(function* () { ... });
```

### Logging with Annotations

Put variable data in annotations, not the message:

```ts
// Do
yield *
  Effect.logInfo("Created notebook").pipe(
    Effect.annotateLogs({ uri: notebook.uri.toString() }),
  );

// Don't
yield * Effect.logDebug(`Processing ${count} items`);
```

### Span Annotations

Use `Effect.annotateCurrentSpan` to add context to the enclosing span:

```ts
const refresh = Effect.fn("ControllerRegistry.refresh")(function* () {
  yield* Effect.annotateCurrentSpan("environmentCount", envs.length);
  // ...
});
```

### Explicit Spans

Use `Effect.withSpan` for important operations:

```ts
yield *
  client
    .executeCommand(cmd)
    .pipe(
      Effect.withSpan("lsp.executeCommand", {
        attributes: { command: cmd.command },
      }),
    );
```
