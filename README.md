# marimo-lsp

A language server and VS Code extension for
[marimo](https://github.com/marimo-team/marimo).

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

The **language server** is a pure Python program that implements the [Language
Server Protocol](https://microsoft.github.io/language-server-protocol/),
running over stdin/stdout

```bash
uv run marimo-lsp    # Run the server
uv run pytest        # Run tests
uv run ruff check    # Lint
uv run ruff format   # Format
uv run ty check      # Typecheck
```

The **VS Code extension** is a separate TypeScript project that sits on top of
the language server: it wires VS Code's UI to the server by dispatching and
receiving custom messages, and adds editor-specific pieces such as the custom
notebook serializer and renderer.

```bash
cd extension
pnpm install         # Install dependencies
pnpm build           # Build extension and renderer
pnpm biome check     # Lint
pnpm tsc             # Typecheck
```

Or just press `F5` in VS Code - it handles everything automatically.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for details on how the LSP server and extension work together.
