# Repository instructions

## Project

This repository contains:

- A Python language server under `src/marimo_lsp/`.
- A TypeScript VS Code extension under `extension/`.

Start architectural investigation from the current entry points:

- Python: `src/marimo_lsp/server.py`
- Extension: `extension/src/extension.ts`
- Effect layer composition: `extension/src/features/Main.ts`

Use `rg` and the source tree to discover current modules. Do not rely on
documentation inventories of filenames; this codebase changes frequently.

## Tooling

- Never invoke `python`, `python3`, or `pip` directly. Always use `uv`.
- Use `pnpm -C extension` for extension commands.
- Run `just --list` to discover supported repository tasks.
- Prefer targeted checks while iterating, then run the relevant `just` lint and
  test recipes before finishing.

The extension links packages from a sibling `marimo` checkout. Follow
`CONTRIBUTING.md` when setting up or updating that checkout.

## Learning more about Effect

This repository uses the Effect TypeScript library.

Before writing Effect code, inspect the relevant APIs and concepts in
`extension/node_modules/effect/src`. This source always matches the installed
version.

Follow the repository's Effect logging and function-naming conventions in
`CONTRIBUTING.md`. Prefer existing Effect primitives and local patterns over
introducing parallel abstractions.

## Generated files

Do not edit files marked as generated.

Run `just codegen` after changing their source inputs and use
`just codegen-check` to verify generated output.

## marimo compatibility

`pyproject.toml` contains two separate marimo version policies:

- The exact `marimo-base` dependency is the bundled server/frontend version.
- `tool.marimo-lsp.minimum-kernel-version` is the supported user-kernel floor.

Do not update or conflate them unless the task explicitly requires it.

## Testing

- Python tests: `just test-py [args]`
- TypeScript tests: `just test-ts [args]`
- User-facing VS Code behavior: `just test-vscode [args]`
- Full lint: `just lint`
