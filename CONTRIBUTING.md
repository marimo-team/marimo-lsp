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
> The extension currently builds against the `main` branch of
> [`marimo-team/marimo`](https://github.com/marimo-team/marimo), so both
> repositories must be cloned side-by-side:
>
> ```
> parent-folder/
> ├── marimo/          # Main marimo codebase
> └── marimo-lsp/      # This project
> ```
>
> Eventually this codebase will be merged into the main marimo repo, simplifying
> setup.

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
