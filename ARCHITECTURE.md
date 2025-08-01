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
└─────────────────┘                    └─────────────────┘                    └─────────────┘
```

## Protocol

The architecture uses two types of LSP communication:

### Standard LSP Notifications

Document synchronization. Automatic through LSP's notebook protocol:

- `notebookDocument/didOpen` - Track notebook open events
- `notebookDocument/didChange` - Sync cell content changes
- `notebookDocument/didSave` - Handle save operations
- `notebookDocument/didClose` - Clean up sessions

### Custom LSP Commands

Marimo-specific operations. Custom LSP commands that the extension must
explicitly invoke:

- `marimo.run` - Execute cells with specified IDs
- `marimo.serialize` - Serialize LSP notebook document to marimo python file
- `marimo.deserialize` - Deserialize marimo file to LSP notebook document

Both types use the same LSP transport, but custom commands require the extension
to coordinate user actions with kernel operations.

## Components

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

The custom `LspAppFileManager` adapts VS Code's notebook documents into marimo's
App structure. Unlike marimo's standard file-based loading, it reads directly
from the LSP's in-memory document state, tracking which cells have changed
between reloads.

For kernel communication, the `LspSessionConsumer` "consumes"kernel messages and
forward them as LSP notifications.

## Current Implementation Status

- ✅ Basic LSP server and protocol handling
- ✅ Session management and lifecycle
- ✅ Command registration and routing
- ✅ Notebook document synchronization
- ⚠️ Cell execution (partial implementation)
- ❌ Output message handling
- ❌ UI element interactions
- ❌ Error recovery and robustness
