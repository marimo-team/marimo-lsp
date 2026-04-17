# marimo

A VS Code extension for [marimo](https://github.com/marimo-team/marimo), a
reactive Python notebook that's reproducible, git-friendly, and deployable as
scripts or apps.

![](https://github.com/user-attachments/assets/1221b757-4c82-471d-897c-030d61132e90)

## Features

- 📓 Create, edit, and share marimo notebooks in VS Code
- ✨ Rich output rendering with interactive UI elements
- 📦 Integrated package and environment management
- 🔍 Variables explorer and datasources panel

## Getting Started

1. Install this extension from the VS Code Marketplace
2. Open a marimo notebook (`.py` file), or create a new one:
   - Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
   - Run **"Create: Marimo notebook"**
3. VS Code will prompt you to open the file as a marimo notebook

If you have an existing Python file that's a marimo notebook, you'll see an
icon in the editor title bar to open it as a notebook (see image above).

## Commands

| Command                                                   | Description                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `marimo: New marimo notebook`                             | Create a new marimo notebook                                              |
| `marimo: Open as marimo notebook`                         | Open a Python file as a marimo notebook                                   |
| `marimo: Toggle on-cell-change mode`                      | Switch between auto-run and lazy execution modes                          |
| `marimo: Run stale cells`                                 | Execute all cells that need to be re-run                                  |
| `marimo: Restart notebook kernel`                         | Restart the notebook's Python kernel                                      |
| `marimo: Create setup cell`                               | Create or navigate to an existing setup cell                              |
| `marimo: Publish notebook as Gist`                        | Share your notebook as a GitHub Gist                                      |
| `marimo: Publish notebook as...`                          | Export your notebook in various formats                                   |
| `marimo: Export static HTML`                              | Export notebook with current outputs as HTML (without re-executing cells) |
| `marimo: Set Python interpreter to match notebook kernel` | Set the active Python interpreter to match the notebook's kernel          |
| `marimo: Restart marimo language server (marimo-lsp)`     | Restart the LSP server if it becomes unresponsive                         |
| `marimo: Report an issue or suggest a feature`            | Open GitHub to report bugs or request features                            |
| `marimo: Show diagnostics`                                | Display diagnostic information for troubleshooting                        |

## Configuration

| Setting                                 | Type      | Default  | Description                                                                                                                                                                                         |
| --------------------------------------- | --------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marimo.lsp.path`                       | `array`   | `[]`     | Path to a custom `marimo-lsp` executable, e.g., `["/path/to/marimo-lsp"]`. Leave empty to use the bundled version via `uvx`.                                                                        |
| `marimo.uv.path`                        | `string`  |          | Path to the `uv` binary, e.g., `/Users/me/.local/bin/uv`. Leave empty to use `uv` from the system PATH.                                                                                             |
| `marimo.ruff.path`                      | `string`  |          | Path to a custom `ruff` binary, e.g., `/usr/local/bin/ruff`. Useful for offline environments. Leave empty to auto-discover or install via uv.                                                       |
| `marimo.ty.path`                        | `string`  |          | Path to a custom `ty` binary, e.g., `/usr/local/bin/ty`. Useful for offline environments. Leave empty to auto-discover or install via uv.                                                           |
| `marimo.disableUvIntegration`           | `boolean` | `false`  | Disable uv integration features such as automatic package installation prompts.                                                                                                                     |
| `marimo.languageFeatures`               | `string`  | `"none"` | Controls how Python language features are provided for notebook cells. See [Language Features](#language-features) below.                                                                           |
| `marimo.disableManagedLanguageFeatures` | `boolean` | `false`  | Disable marimo's managed Python language features (completions, diagnostics, formatting). When enabled, notebook cells use the standard `python` language ID and rely on external language servers. |
| `marimo.telemetry`                      | `boolean` | `true`   | Anonymous usage data. This helps us prioritize features for the marimo VSCode extension.                                                                                                            |

### Language Features

The `marimo.languageFeatures` setting controls how Python language features are provided for notebook cells. There are three modes:

| Mode               | Language ID | ty + Ruff started | External servers attach |
| ------------------ | ----------- | ----------------- | ----------------------- |
| `"managed"`        | `mo-python` | Yes               | No                      |
| `"external"`       | `python`    | No                | Yes                     |
| `"none"` (default) | `mo-python` | No                | No                      |

- **`"managed"`** — marimo manages Python language features using dedicated ty and Ruff language servers. Cells use the `mo-python` language ID to prevent conflicts with external servers like Pylance.
- **`"external"`** — Cells use the standard `python` language ID so external language servers (Pylance, pyright, etc.) can attach. marimo's managed servers are not started.
- **`"none"`** — No language features at all. Cells use `mo-python` to prevent external servers from attaching, and marimo's managed servers are not started.

> **Migration:** The deprecated `marimo.disableManagedLanguageFeatures` boolean still works during the transition period. If you had it set to `true`, it maps to `"external"`. If set to `false`, it maps to `"managed"`. Setting the new `marimo.languageFeatures` enum takes priority over the old boolean.

## Support

- [marimo Documentation](https://docs.marimo.io/)
- [marimo GitHub Repository](https://github.com/marimo-team/marimo)
- [Report an Issue](https://github.com/marimo-team/marimo-lsp/issues)

## License

Apache 2.0
