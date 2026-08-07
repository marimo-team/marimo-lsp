# marimo Language Server

marimo-lsp coordinates editor sessions with marimo kernels. The language server may run in native Python or WASM, while kernels always run in a selected native Python environment.

## Language

**Session**:
A live notebook attachment backed by exactly one ready **Kernel**. A session owns notebook state and may remain alive while its editor is detached.
_Avoid_: Kernel session, connection

**Kernel**:
A ready execution handle for one marimo runtime. It accepts commands, input, and interrupts and emits ordered operations.
_Avoid_: Worker, host, connection

**Selected Python**:
The native Python executable chosen for a notebook's **Kernel**. Only code running in this environment may depend on its installed marimo version and native runtime support.
_Avoid_: Host Python, system Python

**Kernel bridge**:
The private selected-Python program used only when the WASM language server cannot launch or connect to a **Kernel** itself. It owns marimo IPC and ZeroMQ while Node brokers its opaque stdin and stdout bytes.
_Avoid_: Worker, native kernel host, kernel server

**Native language server**:
The marimo-lsp entrypoint running in native Python. It launches a **Kernel** and connects to marimo IPC directly, without a **Kernel bridge**.
_Avoid_: Native host

**WASM language server**:
The bundled marimo-lsp entrypoint running in Pyodide. It reaches each **Kernel** through Node and a **Kernel bridge** in the **Selected Python** environment.
_Avoid_: WASM kernel, Pyodide kernel

## Flagged ambiguities

**Worker** is not a domain term. It has referred to both the **Kernel** and the **Kernel bridge**; use the precise term instead.

**Host** is not a domain term. Node supplies process mechanics, while the **Kernel bridge** owns marimo IPC; neither is a kernel host.

## Example dialogue

> **Developer:** When does a session become visible?
>
> **Domain expert:** Only after its kernel is ready. The native language server reaches it directly; the WASM language server reaches it through a kernel bridge running in the selected Python.
>
> **Developer:** Does Node decode kernel messages?
>
> **Domain expert:** No. Node brokers opaque bytes between the WASM language server and the kernel bridge. The Python endpoints own framing and message semantics.
