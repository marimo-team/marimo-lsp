# marimo-lsp

Language Server Protocol implementation and VS Code extension to run
[marimo](https://github.com/marimo-team/marimo) notebooks natively in VS Code.

## Quick Start

1. Open this project in VS Code
2. Press `F5` to launch a new VS Code window with the extension loaded
3. Open any `*_mo.py` file to see it as a marimo notebook

## Development

Currently requires [uv](https://docs.astral.sh/uv/) and [pnpm](https://pnpm.io/).

Right now, this project builds against the main version of marimo and requires
both repositories to be cloned side-by-side:

```
parent-folder/
├── marimo/          # Main marimo codebase
└── marimo-lsp/      # This project
```

Eventually, this codebase will be integrated into the main marimo repository,
which will simplify the development setup.

The LSP server is a pure Python program that communicates over stdin/stdout.

```bash
uv run marimo-lsp    # Run the server
uv run pytest        # Run tests
uv run ruff check    # Lint
uv run ruff format   # Format
```

```bash
cd extension
pnpm install         # Install dependencies
pnpm build           # Build extension and renderer
```

Or just press `F5` in VS Code - it handles everything automatically.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on how the LSP server and extension work together.
