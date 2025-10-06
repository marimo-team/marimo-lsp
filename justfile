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
