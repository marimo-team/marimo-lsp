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
2. Create a new notebook:
   - Press `Cmd+Shift+P` (macOS) or `Ctrl+Shift+P` (Windows/Linux)
   - Run **"Create: New marimo notebook"** and choose where to save it
3. Select a Python environment with marimo installed, or choose **marimo sandbox**
   to manage the notebook's dependencies with `uv`, then run a cell

Open an existing marimo `.py` file with **"marimo: Open as marimo notebook"**.
The default marimo language server is bundled. Platform-specific builds also
include `uv`, so no separate installation is needed.

## Python Language Features

We recommend [ty](https://marketplace.visualstudio.com/items?itemName=astral-sh.ty)
for Python completions and type diagnostics, and
[Ruff](https://marketplace.visualstudio.com/items?itemName=charliermarsh.ruff)
for linting and formatting. Both are optional; you can edit and run notebooks
without them. marimo uses their extensions or binaries configured through
`marimo.ty.path` / `marimo.ruff.path` and does not install them automatically.

## Commands and Settings

Search **marimo** in the Command Palette or VS Code Settings for available
commands and configuration. Use **marimo: Show diagnostics** to troubleshoot.
To use an external Python language server, enable
`marimo.disableManagedLanguageFeatures`.

## Support

- [marimo Documentation](https://docs.marimo.io/)
- [marimo GitHub Repository](https://github.com/marimo-team/marimo)
- [Report an Issue](https://github.com/marimo-team/marimo-lsp/issues)

## License

Apache 2.0
