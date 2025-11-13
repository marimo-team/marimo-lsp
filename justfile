# marimo-lsp justfile
# Run `just` to see available recipes

# Default recipe - show available commands
default:
    @just --list

# Lint and typecheck code
check:
    uv run ruff check
    uv run ty check
    pnpm -C extension lint
    pnpm -C extension typecheck

# Fix linting issues and format code
fix:
    uv run ruff format
    uv run ruff check --fix
    pnpm -C extension fix

# Download tutorial files from marimo repository
download-tutorials:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p extension/tutorials
    BASE_URL="https://raw.githubusercontent.com/marimo-team/marimo/main/marimo/_tutorials"
    TUTORIALS=(dataflow.py fileformat.py for_jupyter_users.py intro.py layout.py markdown.py plots.py sql.py ui.py)
    for tutorial in "${TUTORIALS[@]}"; do
        echo "Downloading $tutorial..."
        curl -fsSL "$BASE_URL/$tutorial" -o "extension/tutorials/$tutorial"
    done
    echo "All tutorials downloaded successfully!"

# Run Python tests
pytest *args:
    uv run pytest {{args}}

# Run TypeScript tests
vitest *args:
    pnpm -C extension test {{args}}

# Run VS Code extension integration tests
vscode-test *args:
    pnpm -C extension test:extension {{args}}

# Run all tests
test: pytest vitest
