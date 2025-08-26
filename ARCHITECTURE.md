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

<a name="marimo.run" href="#marimo.run">#</a> **marimo.run** ·
[Source](src/marimo_lsp/server.py#L109)

Executes cells with specified IDs in the marimo kernel.

```typescript
{
  notebookUri: string;
  cellIds: string[];
  codes: string[];
}
```

<a name="marimo.serialize" href="#marimo.serialize">#</a> **marimo.serialize** →
`{source: string}` · [Source](src/marimo_lsp/server.py#L126)

Converts notebook document to marimo Python file format.

```typescript
{
  notebook: NotebookSerialization;
}
```

<a name="marimo.deserialize" href="#marimo.deserialize">#</a>
**marimo.deserialize** → `NotebookSerialization` ·
[Source](src/marimo_lsp/server.py#L143)

Converts marimo Python file to notebook document structure.

```typescript
{
  source: string;
}
```

<a name="marimo.set_ui_element_value" href="#marimo.set_ui_element_value">#</a>
**marimo.set_ui_element_value** · [Source](src/marimo_lsp/server.py#L119)

Updates UI element values from frontend interactions.

```typescript
{
  notebookUri: string;
  object_id: string;
  value: any;
}
```

<a name="marimo.dap" href="#marimo.dap">#</a> **marimo.dap** ·
[Source](src/marimo_lsp/server.py#L149)

Handles Debug Adapter Protocol requests. Responses are sent via `marimo/dap`
notification.

```typescript
{
  sessionId: string;
  notebookUri: string;
  message: DebugProtocolMessage;
}
```

<a name="marimo.convert" href="#marimo.convert">#</a> **marimo.convert** ·
[Source](src/marimo_lsp/server.py#L206)

Converts Python/Jupyter files to marimo format, creating a new `_mo.py` file.

```typescript
{
  uri: string; // File URI to convert
}
```

### 4. Custom LSP Notifications

Server-to-client notifications for kernel updates:

<a name="marimo/operation" href="#marimo/operation">#</a> **marimo/operation** ·
[Source](src/marimo_lsp/session_consumer.py#L46)

Forwards kernel operations to the frontend.

```typescript
{
  notebookUri: string;
  op: string; // Operation type (e.g., "cell-op")
  data: any; // Operation-specific data
}
```

Currently implemented: `cell-op` for cell execution state transitions.

<a name="marimo/dap" href="#marimo/dap">#</a> **marimo/dap** ·
[Source](src/marimo_lsp/debug_adapter.py#L59)

Debug Adapter Protocol response notifications (in response to `marimo.dap`
command).

```typescript
{
  sessionId: string;
  notebookUri: string;
  message: DebugProtocolMessage;
}
```

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
