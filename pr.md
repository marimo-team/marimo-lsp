# Add VS Code Notebook Renderer for Marimo Outputs

Adds a custom notebook renderer to display Marimo UI components in VS Code notebook cells. The renderer handles `application/vnd.marimo.ui+json` mime type outputs.

The implementation uses Vite to build an ES module that exports an `activate` function, as required by VS Code's notebookRenderer API. The renderer uses React and imports components from `@marimo-team/frontend`.

**Build setup requirements:**
- This repo must be alongside the marimo repo: `marimo-team/marimo` and `marimo-team/marimo-lsp`
- The `@marimo-team/frontend` package needs `"exports": { "./*": "./src/*" }` added to its package.json
- Run `pnpm build` to build both the renderer and extension

**Current status:**
- Basic renderer infrastructure works
- Styles are successfully injected into the iframe via a custom Vite plugin
- Marimo web components are not rendering yet (under investigation)
- Added a patch to disable Pyodide/WASM code paths in the frontend for VS Code compatibility

**Key files:**
- `src/renderer.tsx` - React-based renderer implementation
- `vite.config.mjs` - Build configuration with custom style injection plugin
- `package.json` - New dependencies and notebookRenderer contribution point