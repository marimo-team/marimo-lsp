# marimo-lsp

Language Server Protocol implementation for
[marimo](https://github.com/marimo-team/marimo) notebooks.

## Quick Start

```bash
uv run marimo-lsp
```

The server communicates via stdio and implements standard LSP protocol.

## Development

```bash
uv run pytest
uv run ruff check
uv run ruff format
```
