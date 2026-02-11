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
  for referencing other cell names

### 3. Custom LSP Commands

Marimo-specific operations invoked by the extension:

<a name="marimo.run" href="#marimo.run">#</a> **marimo.run** ·
[Source](src/marimo_lsp/server.py#L153)

Executes cells with specified IDs in the marimo kernel. Creates or reuses a
session for the given notebook and Python executable.

```typescript
SessionCommand<RunRequest> {
  notebookUri: string;
  executable: string;  // Python interpreter path
  inner: {
    cellIds: string[];
    codes: string[];
  }
}
```

<a name="marimo.serialize" href="#marimo.serialize">#</a> **marimo.serialize** →
`{source: string}` · [Source](src/marimo_lsp/server.py#L210)

Converts notebook document to marimo Python file format.

```typescript
{
  notebook: NotebookSerialization;
}
```

<a name="marimo.deserialize" href="#marimo.deserialize">#</a>
**marimo.deserialize** → `NotebookSerialization` ·
[Source](src/marimo_lsp/server.py#L216)

Converts marimo Python file to notebook document structure.

```typescript
{
  source: string;
}
```

<a name="marimo.set_ui_element_value" href="#marimo.set_ui_element_value">#</a>
**marimo.set_ui_element_value** · [Source](src/marimo_lsp/server.py#L173)

Updates UI element values from frontend interactions.

```typescript
NotebookCommand<SetUIElementValueRequest> {
  notebookUri: string;
  inner: {
    object_id: string;
    value: any;
  }
}
```

<a name="marimo.function_call_request" href="#marimo.function_call_request">#</a>
**marimo.function_call_request** · [Source](src/marimo_lsp/server.py#L185)

Handles function call requests from UI elements (e.g., button clicks, form
submissions).

```typescript
NotebookCommand<FunctionCallRequest> {
  notebookUri: string;
  inner: {
    function_call_id: string;
    args: Record<string, any>;
    namespace: string;
  }
}
```

<a name="marimo.interrupt" href="#marimo.interrupt">#</a>
**marimo.interrupt** · [Source](src/marimo_lsp/server.py#L197)

Interrupts kernel execution for the specified notebook, stopping all running
cells by sending SIGINT to the kernel process.

```typescript
NotebookCommand<InterruptRequest> {
  notebookUri: string;
  inner: {}
}
```

<a name="marimo.dap" href="#marimo.dap">#</a> **marimo.dap** ·
[Source](src/marimo_lsp/server.py#L222)

Handles Debug Adapter Protocol requests. Responses are sent via `marimo/dap`
notification.

```typescript
NotebookCommand<DebugAdapterRequest> {
  notebookUri: string;
  inner: {
    sessionId: string;
    message: DebugProtocolMessage;
  }
}
```

<a name="marimo.convert" href="#marimo.convert">#</a> **marimo.convert** ·
[Source](src/marimo_lsp/server.py#L237)

Converts Python/Jupyter files to marimo format, creating a new `_mo.py` file
and opening it in the editor.

```typescript
ConvertRequest {
  uri: string; // File URI to convert
}
```

### 4. Custom LSP Notifications

Server-to-client notifications for kernel updates:

<a name="marimo/operation" href="#marimo/operation">#</a> **marimo/operation** ·
[Source](src/marimo_lsp/session_consumer.py#L48)

Forwards kernel operations to the frontend. This is the primary communication
channel for all kernel state updates.

```typescript
{
  notebookUri: string;
  operation: MessageOperation; // Operation with type and data
}
```

Currently implemented operations:

- `cell-op` - Cell execution state transitions (queued, running, idle)
- `variables` - Variable state updates for the variables panel
- `data-column-preview` - Datasource column preview data
- `data-table-preview` - Datasource table preview data
- `interrupted` - Kernel interrupt notification
- `alert` - Error and info messages to display to user
- `package-install-start` - Package installation started
- `package-install-complete` - Package installation completed
- And other marimo kernel operations

<a name="marimo/dap" href="#marimo/dap">#</a> **marimo/dap** ·
[Source](src/marimo_lsp/debug_adapter.py#L59)

Debug Adapter Protocol response notifications (in response to `marimo.dap`
command).

```typescript
{
  sessionId: string;
  message: DebugProtocolMessage;
}
```

## Components

### Language Server

The `pygls.LanguageServer` registers handlers for notebook lifecycle events,
language features (code actions, completions), and custom commands. Sessions are
lazily created on the first `marimo.run` command. The `LspSessionManager`
maintains a mapping of notebook URI → marimo `Session`.

> [!IMPORTANT]
> This mapping is tied to the file's URI, which may be unstable (e.g., renamed
> files, untitled notebooks). As long as the document URI doesn't change during
> a session, cell URIs remain stable, enabling reliable references to both
> notebooks and cells.

### Session Manager

The `LspSessionManager` creates and manages marimo `Session` objects. Each
session contains a `QueueManager`, `LspKernelManager`, `LspAppFileManager`,
`LspSessionConsumer`, and `ConfigManager`. Sessions are closed when the notebook
is untitled and closed, the Python executable changes, or during shutdown.

### App File Manager

The `LspAppFileManager` adapts VS Code's notebook documents into marimo's
`InternalApp` structure. Unlike marimo's standard file-based loading, it reads
from the LSP's in-memory document state via `sync_app_with_workspace()`, which
extracts cell IDs, codes, configs, and names from the notebook document.

### Session Consumer

The `LspSessionConsumer` implements marimo's `SessionConsumer` interface,
forwarding kernel messages to VS Code via `marimo/operation` notifications.
This enables real-time updates of cell execution status, outputs, variable
state, UI elements, and package installation progress.

### Kernel Manager (TypeScript)

The `KernelManagerLive` layer (`extension/src/layers/KernelManager.ts`)
orchestrates kernel operations by:

1. Consuming `marimo/operation` notifications from the LSP server
2. Routing operations via `routeOperation()` to appropriate handlers
3. Forwarding renderer messages (UI interactions) back to the kernel via LSP
   commands

### Cell State Manager (TypeScript)

The `CellStateManager` (`extension/src/services/CellStateManager.ts`) tracks
cell stale state. When a cell's content changes, it's marked as stale in the
cell metadata and the `marimo.notebook.hasStaleCells` context key is updated for UI
enablement (e.g., "Run Stale Cells" button).

### Execution Registry (TypeScript)

The `ExecutionRegistry` (`extension/src/services/ExecutionRegistry.ts`) manages
`NotebookCellExecution` objects for cells. It handles `cell-op` operations from
the kernel, transitioning cells through queued → running → idle states, and
manages output rendering.

### Notebook Renderer (TypeScript)

The `NotebookRenderer` (`extension/src/services/NotebookRenderer.ts`) provides a
custom renderer for marimo UI elements. It renders marimo components within
notebook cells using the `application/vnd.marimo+html` MIME type and forwards UI
interactions (e.g., `marimo.set_ui_element_value`, `marimo.function_call_request`)
back to the kernel.

### Variables and Datasources (TypeScript)

The `VariablesService` and `DatasourcesService` maintain state for their
respective tree views. They consume `variables`, `data-column-preview`, and
`data-table-preview` operations, updating the views in real-time as the kernel
sends updates.
