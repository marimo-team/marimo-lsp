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

## Installing notebook dependencies

Choose how to manage dependencies using the notebook's kernel picker.

### marimo sandbox

Save the notebook as a `.py` file and select **marimo sandbox**. The extension
uses `uv` to create an isolated environment from the notebook's inline script
metadata. When an import is missing, use the package installation prompt.

To declare a dependency before running the notebook, run this in a terminal,
replacing `notebook.py` with the saved notebook's path:

```sh
uv add --script notebook.py pandas
```

This records the dependency in the notebook's `# /// script` metadata block.
Run a cell again to synchronize the sandbox with that metadata. Installing a
package into a separate project environment does not add it to the sandbox.

### An existing Python environment

Select the environment you want to use in the kernel picker. Install `marimo`
and the notebook's packages into that same environment, for example:

```sh
uv pip install --python /path/to/environment/bin/python marimo pandas
```

On Windows, use the environment's `Scripts/python.exe` path instead. You can
also use pip or your environment manager, provided it installs into the
interpreter selected for the notebook. Then run the cell again.

### Finding uv

Platform-specific extension builds include `uv` for the extension's own
operations. That bundled executable is not necessarily on your terminal's
`PATH`. To run the commands above, follow the
[uv installation instructions](https://docs.astral.sh/uv/getting-started/installation/).
Use the `marimo.uv.path` setting if you want the extension to use a particular
`uv` executable. A separate VS Code extension for `uv` is not required.

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
