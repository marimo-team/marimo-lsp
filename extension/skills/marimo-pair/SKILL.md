---
name: marimo-pair
description: >-
  Build and drive a marimo notebook in VS Code — run Python in the live kernel,
  inspect state, and create/edit/run cells via code mode. Use when working in an
  open marimo notebook or when the user asks to build one.
---

# marimo pair programming (VS Code)

You can work inside an open marimo notebook's live kernel through the
`execute_code` tool. marimo notebooks are a dataflow graph: cells are the unit
of computation, connected by the variables they define and reference. When a
cell runs, marimo automatically re-runs its dependents. The user sees results
live in the VS Code notebook as you work.

## The one tool: `execute_code`

`execute_code(notebookUri, code)` runs Python in the notebook's kernel. Pass
the URI of the marimo notebook the user is working in.

Each call runs in a **scratchpad**: the notebook's variables are in scope, but
anything you newly bind stays in the scratchpad and does not persist. Use it
freely to inspect state and prototype — `print(df.head())` just works — then
commit cells when you want the work to last and be visible to the user.

## Building the notebook: code mode

To durably create, edit, delete, or run cells, write Python that uses
`marimo._code_mode`:

```python
import marimo._code_mode as cm

async with cm.get_context() as ctx:
    cid = ctx.create_cell("x = 1")
    ctx.packages.add("pandas")
    ctx.run_cell(cid)
```

- You **must** use `async with` — without it, operations silently do nothing.
- `ctx.*` methods are **synchronous** (they queue; the block flushes on exit).
  Do **not** `await` them.
- The kernel supports top-level `await`, so use `async with` directly — do not
  wrap it in `asyncio.run(...)`.
- `create_cell` / `edit_cell` are structural only; use `run_cell` to execute.
- The block flushes as one transaction. If marimo's checks (syntax,
  multiply-defined names, cycles) fail, the whole batch is rejected and the
  offending cells are named — fix and retry.

### Explore the API first

`code_mode` is internal and unversioned. Inspect it at the start of a session,
and dig into anything you're unsure about:

```python
import marimo._code_mode as cm
help(cm)
```

## Guard rails

- **Edit the notebook through VS Code's notebook editor (cells) or `code_mode`
  — NEVER edit the `.py` file on disk.** Both the notebook editor and
  `code_mode` go through the open notebook and the live kernel. A raw file
  write to the `.py` (`Write`/`Edit`/any text edit) bypasses them: it conflicts
  with the notebook's in-memory state and is clobbered on the next save, so the
  change never reaches the user or the kernel. For programmatic edits use
  `ctx.edit_cell(target, code=...)` with the full new cell body — even for a
  one-character change. To read a cell, prefer `ctx.cells[target].code`.
- **Install packages via `ctx.packages.add()`**, not `uv add` / `pip` — it
  handles kernel restarts and resolution. Confirm when it isn't obvious.
- **Custom widget = anywidget** (HTML/CSS/JS). Composed `mo.ui` is fine for
  simple controls. marimo can't render classic Jupyter widgets.
- **UI state lives outside the reactive graph.** Set anywidget traits directly
  (`slider.value = 5`); for `mo.ui.*` use `ctx.set_ui_value(element, value)`.
- **Avoid empty cells** — prefer editing an existing empty cell. Don't fuss
  over cell names.
- **No temp-file deps in cells** — `pathlib.Path("/tmp/...")` in cell code is a bug.

## Keep in mind

- **The user is editing too.** The notebook can change between your calls;
  re-inspect (`ctx.cells`) if it's been a while.
- **Deletions are destructive.** Deleting a cell drops its variables from
  kernel memory. If intent is ambiguous, ask first.
- **Understand intent first** — when clear, act; when ambiguous, clarify.
  Build first; polish (names, layout, styling) later.
