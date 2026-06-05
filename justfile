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

[group('setup')]
vendor-effect:
    #!/usr/bin/env bash
    set -euo pipefail
    PKG="extension/node_modules/effect/package.json"
    if [ ! -f "$PKG" ]; then
        echo "error: $PKG missing — run \`pnpm -C extension install\` first" >&2
        exit 1
    fi
    VERSION=$(node -p "require('./extension/node_modules/effect/package.json').version")
    TAG="effect@${VERSION}"
    DIR="repos/effect"
    if [ -d "$DIR/.git" ]; then
        CURRENT=$(git -C "$DIR" describe --tags --exact-match 2>/dev/null || echo "")
        if [ "$CURRENT" = "$TAG" ]; then
            # Right tag, but the working tree may be incomplete (e.g. an
            # interrupted clone leaves tracked files unmaterialized). repos/ is
            # read-only reference, so restoring to HEAD is always safe.
            if [ -n "$(git -C "$DIR" status --porcelain)" ]; then
                echo "repos/effect at $TAG but working tree incomplete; restoring"
                git -C "$DIR" reset --hard HEAD
                git -C "$DIR" clean -fdx
            else
                echo "repos/effect already at $TAG"
            fi
            exit 0
        fi
        echo "Updating repos/effect: ${CURRENT:-<unknown>} -> $TAG"
        git -C "$DIR" fetch --depth 1 origin "refs/tags/$TAG:refs/tags/$TAG"
        git -C "$DIR" checkout "$TAG"
    elif [ -d "$DIR" ]; then
        echo "error: $DIR exists but isn't a git checkout; remove it and re-run" >&2
        exit 1
    else
        echo "Cloning Effect-TS/effect@$TAG into $DIR"
        mkdir -p repos
        git clone --depth 1 --branch "$TAG" https://github.com/Effect-TS/effect.git "$DIR"
    fi
