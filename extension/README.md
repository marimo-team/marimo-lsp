# marimo

A VS Code extension for [marimo](https://github.com/marimo-team/marimo), a
reactive Python notebook that's reproducible, git-friendly, and deployable as
scripts or apps.

![](https://github.com/user-attachments/assets/1221b757-4c82-471d-897c-030d61132e90)

## Prerequisites

This extension requires [uv](https://docs.astral.sh/uv/) to be installed and
available on your PATH. The extension uses `uvx` to run the bundled
`marimo-lsp` language server.

Install uv:

```bash
# macOS/Linux
curl -LsSf https://astral.sh/uv/install.sh | sh

# Windows
powershell -c "irm https://astral.sh/uv/install.ps1 | iex"
```

## Features

- 📓 Create, edit, and share marimo notebooks in VS Code
- ✨ Rich output rendering with interactive UI elements
- 📦 Integrated package and environment management
- 🔍 Variables explorer and datasources panel

## Getting Started

1. Ensure [uv](https://docs.astral.sh/uv/) is installed
2. Install this extension from the VS Code Marketplace
3. Open a marimo notebook (`.py` file), or create a new one:
   - Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
   - Run **"Create: Marimo notebook"**
4. VS Code will prompt you to open the file as a marimo notebook

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
| `marimo: Show marimo diagnostics`                         | Display diagnostic information for troubleshooting                        |

## Configuration

| Setting                                 | Type      | Default | Description                                                                                                                                                                                         |
| --------------------------------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marimo.lsp.path`                       | `array`   | `[]`    | Path to a custom `marimo-lsp` executable, e.g., `["/path/to/marimo-lsp"]`. Leave empty to use the bundled version via `uvx`.                                                                        |
| `marimo.disableUvIntegration`           | `boolean` | `false` | Disable uv integration features such as automatic package installation prompts.                                                                                                                     |
| `marimo.disableManagedLanguageFeatures` | `boolean` | `false` | Disable marimo's managed Python language features (completions, diagnostics, formatting). When enabled, notebook cells use the standard `python` language ID and rely on external language servers. |
| `marimo.telemetry`                      | `boolean` | `true`  | Anonymous usage data. This helps us prioritize features for the marimo VSCode extension.                                                                                                            |

### Language Features

By default, marimo provides managed Python language features (completions, diagnostics, formatting) for notebook cells using a dedicated language server. This prevents conflicts with external Python language servers and ensures a consistent editing experience.

**Why managed mode?** Notebook cells use a custom language ID (`mo-python`) to isolate them from external language servers like Pylance or Jedi. This prevents duplicate completions, conflicting diagnostics, and other interference while editing marimo notebooks.

**When to disable managed mode:** If you prefer to use your own Python language server configuration (e.g., Pylance, pyright, or another LSP), enable `marimo.notebook.disableManagedLanguageFeatures`. This switches cells to use the standard `python` language ID, allowing external language servers to provide completions and diagnostics. Note that this may result in some language features not working as expected in the notebook context.

## Support

- [marimo Documentation](https://docs.marimo.io/)
- [marimo GitHub Repository](https://github.com/marimo-team/marimo)
- [Report an Issue](https://github.com/marimo-team/marimo-lsp/issues)

## License

Apache 2.0
