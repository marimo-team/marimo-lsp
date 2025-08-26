# marimo-lsp Architecture

## Overview

The marimo Language Server Protocol (LSP) enables marimo notebooks to run
natively in VS Code. It bridges VS Code's notebook interface with marimo's
kernel runtime using both standard LSP notifications and custom LSP commands.

```
┌─────────────────┐                    ┌─────────────────┐                    ┌─────────────┐
│    VS Code      │                    │   LSP Server    │                    │marimo kernel│
├─────────────────┤                    │    (Python)     │                    │  (Session)  │
│                 │  Standard LSP      │                 │                    │             │
│ Notebook Editor │ ◄────────────────► │ Document Sync   │                    │             │
│                 │  notifications     │                 │                    │             │
├─────────────────┤                    ├─────────────────┤                    │             │
│                 │  Custom LSP        │                 │     Python API     │             │
│   Extension     │ ◄────────────────► │ Command Handler │ ◄─────────────────►│   Runtime   │
│                 │  commands          │                 │                    │             │
├─────────────────┤                    ├─────────────────┤                    │             │
│                 │  marimo/operation  │                 │                    │             │
│   UI Renderer   │ ◄──────────────────│ Session Consumer│ ◄──────────────────│   Messages  │
│                 │  notifications     │                 │                    │             │
└─────────────────┘                    └─────────────────┘                    └─────────────┘
```

## Protocol

The architecture uses three types of LSP communication:

### 1. Standard LSP Notifications

Document synchronization through LSP's notebook protocol:

- `notebookDocument/didOpen` - Track notebook open events and create sessions
- `notebookDocument/didChange` - Sync cell content changes in real-time
- `notebookDocument/didSave` - Handle save operations
- `notebookDocument/didClose` - Clean up untitled sessions

### 2. Standard LSP Features

Language features provided through standard LSP:

- `textDocument/codeAction` - Provide code action to convert Python/Jupyter
  files to marimo format
- `textDocument/completion` - Cell code completions triggered by `@` character

### 3. Custom LSP Commands

Marimo-specific operations invoked by the extension:

- `marimo.run` - Execute cells with specified IDs
  - Parameters: `notebookUri`, `cellIds[]`, `codes[]`
  - Triggers cell execution in the marimo kernel

- `marimo.serialize` - Convert notebook document to marimo Python file
  - Parameters: `notebook` (NotebookSerialization)
  - Returns: serialized Python source code

- `marimo.deserialize` - Convert marimo Python file to notebook document
  - Parameters: `source` (Python code string)
  - Returns: NotebookSerialization structure

- `marimo.set_ui_element_value` - Update UI element values from frontend
  - Parameters: `notebookUri`, `object_id`, `value`
  - Handles user interactions with UI elements

- `marimo.dap` - Forward Debug Adapter Protocol messages
  - Parameters: `sessionId`, `notebookUri`, `message`
  - Enables debugging support for marimo notebooks

- `marimo.convert` - Convert Python/Jupyter files to marimo format
  - Parameters: `uri` (file URI to convert)
  - Creates a new `_mo.py` file with marimo structure

### 4. Custom LSP Notifications

Server-to-client notifications for kernel updates:

- `marimo/operation` - Forwards all kernel operations
  - Parameters: `notebookUri`, `op` (operation type), `data` (operation-specific
    data)
  - Currently handles: `cell-op` for cell execution states
  - Available operations include cell status updates, UI messages, variable
    values, alerts, and more

## Components

### LSP Server

The LSP server acts as the entry point, creating a `pygls.LanguageServer` that
registers handlers for notebook lifecycle events. When a notebook opens
(`notebookDocument/didOpen`), the `LspSessionManager` creates a marimo session
for that file's URI (if there isn't one already), maintaining a one-to-one
mapping between open notebooks and kernel sessions.

> [!IMPORTANT]
> This mapping is tied to the file's URI, which may be unstable (e.g., renamed
> files, untitled notebooks). As long as the document URI doesn't change during
> a session, cell URIs remain stable, enabling reliable references to both
> notebooks and cells.

The notebook document is kept in sync via LSP notifications
(`notebookDocument/didChange`) and remains accessible on the LSP server even
after it's closed or saved — provided the same VS Code session.

### File Management

The custom `LspAppFileManager` adapts VS Code's notebook documents into marimo's
App structure. Unlike marimo's standard file-based loading, it reads directly
from the LSP's in-memory document state, tracking which cells have changed
between reloads.

### Session Consumer

For kernel communication, the `LspSessionConsumer` "consumes" kernel messages
and forwards them as LSP notifications. This enables real-time updates of:

- Cell execution status (queued, running, idle)
- Cell outputs and console messages
- Variable state and dependencies
- UI element updates

### Cell Execution and State Management

The extension maintains cell runtime state through the `CellStateManager` which
tracks:

- Cell execution status (queued, running, idle, disabled, stale)
- Cell outputs (console logs, UI elements, errors)
- Execution timing and timestamps

Cell execution follows this lifecycle:

1. **Queued**: `NotebookCellExecution` created when cell is submitted
2. **Running**: Execution started with timestamp, outputs begin streaming
3. **Idle**: Execution completed, final outputs rendered, execution disposed

### Frontend Integration

The VS Code extension includes a custom notebook renderer for marimo UI
elements. The renderer (`marimo-renderer`) handles:

- Rendering marimo UI components within notebook cells
- Bidirectional communication with the kernel for UI interactions
- Managing cell output state with `application/vnd.marimo.ui+json` MIME type

### Debug Adapter Protocol (DAP) Support

The LSP server supports debugging through the Debug Adapter Protocol:

- DAP messages are forwarded via the `marimo.dap` command
- Enables breakpoints, stepping, and variable inspection in marimo notebooks
- Integrates with VS Code's native debugging UI
