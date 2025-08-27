# marimo-lsp

A language server and VS Code extension for
[marimo](https://github.com/marimo-team/marimo).

## Quick Start

1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Open any `*_mo.py` file to see it as a marimo notebook

Here’s a tightened version that keeps your style but separates the conceptual
explanation from the command references:

## Development

This project requires [uv](https://docs.astral.sh/uv/) and
[pnpm](https://pnpm.io/).

**Quickstart**

```sh
cd marimo-lsp
code .
# Press `F5` in VS Code (or "Run and Debug" > "Run Extension" in the UI).
```

> [!NOTE]
> The extension currently builds against the `main` branch of
> [`@marimo-team/marimo`](https://github.com/marimo-team/marimo), so both
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

### Language Server (Python)

All commands are run from the project root:

| Command              | Action                  |
| -------------------- | ----------------------- |
| `uv run marimo-lsp`  | Run the language server |
| `uv run pytest`      | Run unit tests          |
| `uv run ruff check`  | Lint code               |
| `uv run ruff format` | Format code             |
| `uv run ty check`    | Typecheck               |

### VS Code Extension (JavaScript/TypeScript)

Run these from the `extension/` directory:

| Command            | Action                           |
| ------------------ | -------------------------------- |
| `pnpm install`     | Install dependencies             |
| `pnpm build`       | Build the extension and renderer |
| `pnpm biome check` | Lint code                        |
| `pnpm tsc`         | Typecheck TypeScript             |

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on how the LSP server and
extension work together.
