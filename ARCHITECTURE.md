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
│                 │  Custom LSP        │                 │   Python API       │             │
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

Document synchronization. Automatic through LSP's notebook protocol:

- `notebookDocument/didOpen` - Track notebook open events
- `notebookDocument/didChange` - Sync cell content changes
- `notebookDocument/didSave` - Handle save operations
- `notebookDocument/didClose` - Clean up sessions

### 2. Custom LSP Commands

Marimo-specific operations. Custom LSP commands that the extension must
explicitly invoke:

- `marimo.run` - Execute cells with specified IDs
- `marimo.serialize` - Serialize LSP notebook document to marimo python file
- `marimo.deserialize` - Deserialize marimo file to LSP notebook document
- `marimo.set_ui_element_value` - Update UI element values from frontend interactions

### 3. Custom LSP Notifications

Kernel message forwarding. The server sends these notifications to update the
frontend:

- `marimo/operation` - Forwards kernel operations

Both command and notification types use the same LSP transport, but custom
commands require the extension to coordinate user actions with kernel
operations.

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

The custom `LspAppFileManager` adapts VS Code's notebook documents into
marimo's App structure. Unlike marimo's standard file-based loading, it reads
directly from the LSP's in-memory document state, tracking which cells have
changed between reloads.

### Session Consumer

For kernel communication, the `LspSessionConsumer` "consumes" kernel messages
and forwards them as LSP notifications. This enables real-time updates of:

- Cell execution status (queued, running, idle)
- Cell outputs and console messages
- Variable state and dependencies
- UI element updates

### Frontend Integration

The VS Code extension includes a custom notebook renderer for marimo UI
elements:
