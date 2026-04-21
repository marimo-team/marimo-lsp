# marimo-lsp Architecture

## Overview

marimo-lsp lets marimo notebooks run natively inside VS Code's notebook UI by
bridging three independent runtimes. Three distinct LSP channels connect the
extension to the server, and the server in turn proxies to the kernel:

```
┌──────────────────┐                           ┌──────────────────┐                        ┌───────────────┐
│     VS Code      │                           │   LSP server     │                        │ marimo kernel │
│                  │                           │    (Python)      │                        │   (Session)   │
├──────────────────┤  LSP notebook protocol    ├──────────────────┤                        │               │
│  notebook editor │◄─────────────────────────►│  document sync   │                        │               │
│  (vscode host)   │  didOpen / didChange / …  │                  │                        │               │
├──────────────────┤  custom LSP commands      ├──────────────────┤   Session methods      │               │
│    extension     │──────────────────────────►│ command handler  │───────────────────────►│    runtime    │
│ (KernelManager)  │  marimo.run, interrupt, … │                  │                        │               │
├──────────────────┤  marimo/operation push    ├──────────────────┤   SessionConsumer      │               │
│    extension     │◄──────────────────────────│ session consumer │◄───────────────────────│   messages    │
│ (KernelManager)  │                           │                  │                        │               │
└──────────────────┘                           └──────────────────┘                        └───────────────┘
```

Each row is one channel with distinct semantics:

- **Top (document sync)** is standard LSP. VS Code streams notebook cell text
  to the server; the server keeps an in-memory view so it can answer cell
  questions without touching disk. The kernel is not involved.
- **Middle (custom commands)** is the extension's outbound path. The
  extension's `KernelManager` dispatches commands like `marimo.run`; the
  server's command handler translates each into calls on the relevant
  `Session` and its kernel subprocess.
- **Bottom (operation push)** is the inbound path. The kernel emits messages
  (cell state, variables, dataset previews, alerts, package install
  progress); the server's session consumer wraps each in a `marimo/operation`
  notification tagged with the notebook URI; the extension's `KernelManager`
  receives them and fans them out to interested services.

The kernel has no direct line to VS Code — the server is always in the
middle, which makes the extension↔server protocol the load-bearing surface.
The extension's `KernelManager` is the matched pair for the server's command
handler (outbound) and session consumer (inbound).

## Messaging

Three channels carry traffic between extension and server.

**1. Document sync (standard LSP notebook protocol).** VS Code streams cell
text to the server with `notebookDocument/didOpen`, `didChange`, `didSave`,
`didClose`. The server uses these to keep an in-memory view of each notebook
so it can answer questions about cells (codes, configs, names) without
touching disk.

**2. Language features (standard LSP).** `textDocument/completion` powers
things like `@cell-name` cross-references; `textDocument/codeAction` offers
conversion actions (e.g. Python / Jupyter → marimo). Normal request/response.

**3. Custom commands and notifications.** Anything kernel-shaped rides on
workspace commands (client → server) and server-pushed notifications. By
category:

- *Lifecycle*: `marimo.run`, `marimo.interrupt`, `marimo.restart`. Creating a
  session is a side effect of the first `marimo.run` on a given notebook URI
  + Python executable.
- *Interactivity*: `marimo.set_ui_element_value`, `marimo.function_call_request`.
  UI widgets rendered inside cells bubble back through the extension and into
  these commands.
- *Conversion*: `marimo.serialize` / `marimo.deserialize` convert between the
  notebook document and marimo's `.py` file format; `marimo.convert` creates a
  new marimo file from Jupyter / plain Python input.
- *Server push*: `marimo/operation` is the firehose. Every kernel state
  update (cell execution transitions, variable diffs, dataset previews,
  alerts, package-install progress, …) is tagged with a notebook URI and
  streamed to the extension as a single notification type, carrying a
  discriminated `operation` payload.

The exact request/response shapes live in the server's Python models and the
extension's generated OpenAPI types. Treat this doc as the map, the code as
the territory.

## A message in flight: running a cell

A concrete end-to-end flow:

1. **Extension** dispatches `marimo.run` with the notebook URI, the Python
   executable, and the cells to run.
2. **Server** looks up or creates the `Session` for that URI. On creation it
   spins up a kernel subprocess (with `marimo` available in the user's
   environment), wires stdio plumbing, and starts a `SessionConsumer` that
   forwards kernel messages outward.
3. **Kernel** receives the run request, executes the cell (and any reactively
   dependent cells), and emits a stream of messages: queued → running →
   outputs → idle, plus variable diffs, dataset previews, and anything else
   touched by the execution.
4. **Server** wraps each kernel message in a `marimo/operation` notification
   tagged with the notebook URI and pushes it to the extension.
5. **Extension** routes each operation to interested services in parallel —
   cell execution state, output rendering, variables panel, datasources
   panel, package install progress. Services subscribe by operation type, so
   a single operation can fan out to many consumers.

Interruption (`marimo.interrupt`) and UI interaction
(`marimo.set_ui_element_value`) follow the same pattern: a command from the
extension, a kernel side effect, a stream of operations back.

## Composition

### Python side — adapting marimo's runtime to LSP

The server is a thin adapter. The heavy lifting (execution, reactivity, UI
element state) is marimo's; the LSP layer replaces a few seams so marimo can
drive from a live notebook document rather than a file.

- **Session manager** owns the notebook URI → `Session` mapping (see "Kernel
  lifecycle" below for how that mapping is created and torn down).
- **App file manager** adapts marimo's `AppFileManager` to read cells from
  the in-memory LSP document state instead of a `.py` file — how a user's
  live edits in VS Code reach the kernel's reactivity graph.
- **Kernel manager** wraps the kernel subprocess, including interrupts and
  cleanup.
- **Session consumer** implements marimo's `SessionConsumer` interface and
  forwards everything the kernel emits to the extension as `marimo/operation`
  notifications.

### Kernel lifecycle

Kernels live inside the server, not the extension. A few properties matter
for debugging:

- **Lazy creation.** Opening a notebook doesn't start a kernel. The first
  `marimo.run` for a given notebook URI + Python executable creates the
  `Session` and spawns its subprocess.
- **Saved notebooks keep their kernel when closed.** Reopening picks up the
  same session without losing state. Only *untitled* notebooks get cleaned
  up on `didClose`, since there's no stable URI to come back to.
- **Switching the Python interpreter restarts the kernel.** Creating a
  session against a different executable closes and replaces the existing
  one for that URI.
- **Interrupt vs. restart.** `marimo.interrupt` sends SIGINT to the
  subprocess (cancels the current execution, preserves state). Restarting
  tears the session down and starts a new one.
- **Server shutdown closes every session.** All live kernels terminate with
  the `marimo-lsp` process.

> [!IMPORTANT]
> The session map is keyed by notebook URI, which can be unstable across
> rename and untitled-to-saved transitions. As long as a document's URI
> doesn't change during a session, its cell URIs remain stable — that's what
> the extension relies on to correlate kernel messages back to cell metadata.

### TypeScript side — fanning out operations

The extension is composed as Effect services assembled into a single `Layer`.
The notebook/kernel-shaped pieces:

- **Kernel manager** owns the `marimo/operation` subscription, parses each
  operation, and offers it to downstream services.
- **Execution registry** translates `cell-op` operations (queued / running /
  idle) into `NotebookCellExecution` state on VS Code's notebook API,
  including output rendering.
- **Cell state manager** tracks staleness (cells whose source has drifted
  from the last executed version) and flips context keys that drive UI
  enablement.
- **Notebook renderer** renders marimo's custom MIME outputs inside cells and
  routes user interactions back through the extension to
  `marimo.set_ui_element_value` / `marimo.function_call_request`.
- **Variables / datasources / packages** services back the corresponding
  tree views, each subscribing to its own operation types and maintaining a
  local cache.

The key property is that a single kernel operation can feed multiple services
at once (e.g. `cell-op` drives execution state *and* updates visible output),
and services can be added or swapped without changing the transport layer.
