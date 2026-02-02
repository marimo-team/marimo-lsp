## Quick Start

1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Open a marimo notebook (or create a new one)

## Development

This project requires [uv](https://docs.astral.sh/uv/),
[pnpm](https://pnpm.io/), and [just](https://just.systems/).

**Quickstart**

```sh
cd marimo-lsp
code .
# Press `F5` in VS Code (or "Run and Debug" > "Run Extension" in the UI).
```

> [!NOTE]
> The extension builds against a specific version of
> [`marimo-team/marimo`](https://github.com/marimo-team/marimo), specified in
> the `.marimo-version` file. Both repositories must be cloned side-by-side:
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
> git checkout $(cat ../marimo-lsp/.marimo-version)
> ```
>
> CI automatically checks out the version specified in `.marimo-version`. To update
> the pinned version, change `.marimo-version` to a tag (e.g., `0.18.4`), branch, or
> commit SHA.

### Pre-commit Hooks

To install pre-commit hooks:

```sh
uvx pre-commit install
```

This will run linting and formatting checks automatically before each commit.

### Common Commands

This project uses [just](https://just.systems/) for common development tasks:

| Command            | Action                                      |
| ------------------ | ------------------------------------------- |
| `just check`       | Lint and typecheck all code                 |
| `just fix`         | Fix linting issues and format all code      |
| `just test`        | Run all tests (pytest + vitest)             |
| `just pytest`      | Run Python tests only                       |
| `just vitest`      | Run TypeScript tests only                   |
| `just vscode-test` | Run VS Code extension integration tests     |

You can pass additional arguments to test commands:
```sh
just pytest -v                    # Run pytest with verbose output
just pytest tests/test_foo.py     # Run specific test file
just vitest --watch               # Run vitest in watch mode
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on how the LSP server and
extension work together.

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
yield* Effect.logInfo("Created notebook").pipe(
  Effect.annotateLogs({ uri: notebook.uri.toString() }),
);

// Don't
yield* Effect.logDebug(`Processing ${count} items`);
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
yield* client.executeCommand(cmd).pipe(
  Effect.withSpan("lsp.executeCommand", { attributes: { command: cmd.command } }),
);
