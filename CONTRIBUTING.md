## Quick Start

1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Open a marimo notebook (or create a new one)

## Development

Repository development requires [uv](https://docs.astral.sh/uv/),
[pnpm](https://pnpm.io/), and [just](https://just.systems/).

**Quickstart**

```sh
cd marimo-lsp
just setup
code .
# Press `F5` in VS Code (or "Run and Debug" > "Run Extension" in the UI).
```

F5 sets `MARIMO_REPLAY_TY_PROMPT=1` to replay the missing-ty warning without
saving dismissals. Reload to repeat; remove the variable from
`.vscode/launch.json` to test normal persistence. ty must be unavailable.

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

## Effect (Extension)

See the [extension Effect guide](docs/effect-guide.md) and
[migration TODO](docs/effect-todo.md).
