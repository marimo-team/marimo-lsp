# marimo-lsp justfile
# Run `just` to see available recipes

default:
    @just --list

# lint ---------------------------------------------------------------

[group('lint')]
lint: lint-py lint-ts

[group('lint')]
lint-py:
    uv run ruff check
    uv run ty check

[group('lint')]
lint-ts:
    pnpm -C extension check

# fix ----------------------------------------------------------------

[group('fix')]
fix: fix-py fix-ts

[group('fix')]
fix-py:
    uv run ruff format
    uv run ruff check --fix

[group('fix')]
fix-ts:
    pnpm -C extension fix

# test ---------------------------------------------------------------

[group('test')]
test: test-py test-ts

[group('test')]
test-py *args:
    uv run pytest {{args}}

[group('test')]
test-ts *args:
    pnpm -C extension test {{args}}

[group('test')]
test-vscode *args:
    pnpm -C extension test:extension {{args}}

# build --------------------------------------------------------------

[group('build')]
build:
    pnpm -C extension build
    pnpm -C extension embed-sdist

# setup --------------------------------------------------------------

[group('setup')]
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
