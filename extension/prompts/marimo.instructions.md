When working with marimo notebooks in VS Code:

- **Create a new notebook**: run the `marimo.newMarimoNotebook` command.
- **Open an existing marimo notebook**: run `marimo.openAsMarimoNotebook` with the resource URI string (e.g. `marimo.openAsMarimoNotebook("file:///path/to/notebook.py")`).
- **Run code, inspect state, or change a marimo notebook that is open in VS Code** (edit/add/delete/run cells, set UI values, manage packages): do it through the `marimo_executeCode` tool, which runs in the notebook's live kernel. Do **not** use `Edit`, `Write`, or `NotebookEdit` on the `.py` file — those bypass the live kernel and can destroy the user's in-progress work.

**Default to `marimo_executeCode` for any marimo notebook the user is working with in VS Code.** Do not try to determine whether a kernel is "active" before choosing — assume the open notebook is live and reach for the tool; if no kernel is running, the tool will tell you. Direct file edits are almost never the right move: the integrated notebook view and its live kernel are the actual user experience, and `Edit`/`Write`/`NotebookEdit` cannot reach them.

The `marimo-pair-vscode` skill documents how to drive the kernel through this tool — inspecting state, exploring data, and persisting durable changes via marimo's code mode (`cm`). Consult it for anything beyond a one-off run.

If the user is running marimo outside VS Code (e.g. `uvx marimo edit` in a terminal, with the notebook open in a browser), use the `marimo-pair` skill instead if available — that skill is designed for driving the external marimo editor.

If the notebook is not open in VS Code's notebook editor (e.g. it's just a `.py` file in a text tab and the user isn't running it), editing the file directly is fine.
