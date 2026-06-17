---
name: marimo-pair-vscode
description: >-
  Drive a live marimo notebook in VS Code as a workspace: run Python in the
  same kernel the user does, inspect and explore live notebook state and data,
  prototype and debug code, and commit durable notebook changes (cells, values,
  packages). Use whenever working with a marimo notebook open in VS Code's
  notebook editor with an active kernel — running code, inspecting variables,
  exploring data, debugging, or editing and running cells — not only when
  explicitly "pairing" or starting a session.
---

marimo is a reactive Python runtime for building reproducible Python programs
(marimo notebooks). Cells are connected by the variables they define and
reference. Running a cell re-executes dependents in dataflow order. The active
runtime holds the kernel namespace, cell state, and dataflow graph. The
notebook (`.py` file) is the artifact the kernel writes from that state while a
session is running.

A user interacts with the same runtime via a notebook UI with cells, outputs,
and widgets.

**WARNING. The active runtime is the source of truth.** While the user is
pairing on an open notebook, you SHOULD NOT modify the associated `.py` file
directly, and you SHOULD NOT use VS Code's `NotebookEdit` to change cells.
File edits WILL NOT reach the active kernel or user, and the kernel may
overwrite them on save; `NotebookEdit` bypasses the kernel's dataflow graph.
Use `marimo._code_mode` (`cm`) for all notebook changes. Reading disk is fine,
but prefer `ctx.cells[...].code` for current cell code.

**WARNING. Every notebook edit goes through code mode — no exceptions.** When
the user asks you to change the notebook (add, edit, delete, or run a cell;
rename; change a value or a package), you MUST make that change through
`marimo._code_mode` (`cm`). DO NOT edit the notebook `.py` file with `Edit` or
`Write`, and DO NOT use VS Code's notebook-editing tools (`NotebookEdit`) — those
bypass the live kernel, never reach the user's running session, and get
clobbered when the kernel saves. Running ad-hoc Python with `marimo_executeCode`
to explore or test is fine; _persisting any change to the notebook_ is only ever
done via `cm`.

## Connect to a Notebook

The notebook is already open in VS Code, and the extension manages its kernel.
Run Python in that kernel with the `marimo_executeCode` tool, passing the
`notebookUri` of the notebook the user is working in (VS Code provides the
active notebook as context; if several are open or you are unsure which one,
ask rather than guessing). The tool runs your `code` in the scratchpad — see
below.

## Scratchpad Scope

`marimo_executeCode` evaluates Python in marimo's scratchpad: a temporary namespace
with a shallow copy of the kernel globals. Notebook variables are available by
name, but new top-level bindings and rebindings are discarded after each call.
In-place mutations to notebook-owned objects can persist because those names
still reference live objects.

Each call reports stdout and stderr from the scratchpad, plus console output
from notebook cells it causes to run, including reactive descendants.

### Ordinary Python

Use ordinary Python in the scratchpad to inspect variables, sample data, test
transformations, probe APIs, check imports, and read widget state.

```python
print(df.head())

x = 10
print(x)
```

Here `df` comes from notebook globals, while `x` is a scratchpad-local binding.
`x` exists for this call only and WILL NOT be added to notebook globals.

### Persist with `cm`

Top-level scratchpad assignments and rebindings are temporary. To persist work,
including new variables, you MUST submit changes through `marimo._code_mode`
(`cm`).

`marimo._code_mode` is a PRIVATE, UNSTABLE agent API (note the leading
underscore). It exists for tools like this skill to drive a live kernel from
the scratchpad. DO NOT import it from notebook cells, library code, or
anything a user would run — methods can change or disappear across marimo
versions and kernels. Treat every `import marimo._code_mode as cm` as
scratchpad-only.

At session start, inspect what `cm` exposes in the active kernel:

```python
import marimo._code_mode as cm

help(cm)
```

Open a code-mode context to queue notebook changes.

```python
import marimo._code_mode as cm

async with cm.get_context() as ctx:
    cid = ctx.create_cell("x = df.head()")
    ctx.run_cell(cid)
```

The scratchpad supports top-level async code. Use `async with` directly;
wrapping it in `asyncio.run(...)` is unnecessary and can conflict with the
kernel's event loop.

After this block exits and the new cell runs, `x` is notebook state. Later
scratchpad calls can read `x` by name. Code later in the same scratchpad call
should read `ctx.globals["x"]`, because the scratchpad namespace was copied
before the cell ran.

Inside the context, queued mutation methods are synchronous. Call them
directly; do not `await` them. Each call queues an operation for marimo to
apply when the context exits normally. If the block raises, the queue is
discarded.

On clean exit, marimo applies packages, validates and applies structural cell
changes, runs queued cells, then may run dependents. Validation is only
structural since queued cell runs can still error. `create_cell` and
`edit_cell` change notebook structure only. Use `run_cell` to execute.

`create_cell` currently defaults to `hide_code=True`, which collapses the code
editor in the UI. Pass `hide_code=False` if the user wants created cells to
be visible without manually expanding them.

## Marimo Rules

marimo imposes a small contract on notebook code so it can keep the notebook as
a directed acyclic graph (DAG):

- **No cycles** - cells cannot depend on each other in a cycle.
- **No public redefinitions across cells** - each name has one owning cell.
- **No wildcard imports** - `import *` prevents static analysis of definitions.

These rules keep the kernel, UI, and saved artifact consistent.

When `cm` submits a cell body, marimo parses its top-level definitions and
references. A top-level name enters the graph unless it is private with a
leading underscore.

```python
# Public definitions: values, total, i, value, mean
values = np.array([1, 2, 3])
total = 0
for i, value in enumerate(values):
    total += value
mean = total / len(values)
mean
```

```python
# Public definition: mean
_values = np.array([1, 2, 3])
_total = 0
for _i, _value in enumerate(_values):
    _total += _value
mean = _total / len(_values)
mean
```

Use private names for intermediates that no other cell should read. Public
names define the notebook-level dataflow. If a `cm` edit violates the contract,
marimo rejects the structural change and returns the validation error.

## The Notebook's Shape

A notebook is an ordered collection of cells. `ctx.cells` is the document view
and `ctx.graph` is the dataflow view.

```python
for cell in ctx.cells:
    cell  # .id, .code, .name, .config, .status, .errors

ctx.cells["setup"]         # by name
ctx.cells[0]               # by position
list(ctx.cells.keys())     # all IDs, in notebook order
```

Cell IDs are opaque strings which can be queried from the notebook or captured
from `cm` return values:

```python
cid = ctx.create_cell("df = pd.read_csv('data.csv')")
print(cid)   # e.g. 'Hbol'
```

Alternatively, cells can be assigned and referenced by `name`. The graph can be
used to understand its role in the dataflow.

```python
for cid, impl in ctx.graph.cells.items():
    impl  # .defs, .refs   (sets of public names)

ctx.graph.descendants(cid)   # cells that re-run when this one changes
ctx.graph.ancestors(cid)     # cells this one depends on
```

In marimo, deletes are _destructive_ so it can be useful to query the
descendants prior to deleting to understand it's impact.

## Writing Notebook Changes

The graph contract keeps marimo able to run and save the notebook. Passing
those checks alone does not guarantee a useful artifact. Committed cells should
still be readable, rerunnable, and editable.

Make durable edits that reuse the notebook's existing names, imports,
dependencies, and UI model. Don't be lazy. Avoid one-off workarounds that pass
`cm` validation but leave a brittle notebook.

### Cell Bodies

Submit the code that belongs in the cell.

- **Submit cell contents** - `create_cell` and `edit_cell` take cell contents,
  not saved-file `@app.cell` wrappers.
- **Read before replacing** - for now, another editor may change a cell between
  scratchpad calls. Before `edit_cell`, read the current body from
  `ctx.cells[...]` and submit the full replacement.
- **Reuse notebook imports** - if `np` already exists, use it or edit the owning
  import cell. DO NOT add `import numpy as _np` just to bypass the graph.
- **Define public names intentionally** - use public names for values later
  cells should reference. Use private `_name` bindings or function locals for
  same-cell intermediates.
- **Define each public name once** - a public name has one owning cell.
  Reassigning it in another cell fails with `Multiply-defined names`; edit the
  owning cell or give the result a new name. See
  [gotchas.md](reference/gotchas.md).
- **Run cells deliberately** - `create_cell` and `edit_cell` change structure
  only. Queue `ctx.run_cell(...)` when the cell should execute.

### Prefer `cm`-Managed Changes

Use `cm` APIs when they exist. Avoid direct file edits, shell package commands,
and scratchpad-only state for changes that should persist.

- **Do not edit the `.py` artifact** - DO NOT use `Edit`, `Write`, or
  `NotebookEdit` on the notebook file during a live session. Use
  `ctx.edit_cell(...)` even for small changes.
- **Manage packages through `cm`** - use `ctx.packages.add()` or
  `ctx.packages.remove()` instead of direct `uv` or `pip`; confirm
  non-obvious dependency changes.
- **Avoid transient paths** - persisted cells should not depend on `/tmp/...`
  unless the work is intentionally transient.
- **Delete deliberately** - deleting a cell removes globals it defines. Reuse
  empty cells when convenient and delete cells left empty after edits.

### UI and Widgets

Inspect the object before changing it. Different UI objects update through
different paths.

- **Set `mo.ui.*` through `cm`** - use `ctx.set_ui_value(element, value)` inside
  `cm.get_context()`.
- **Set anywidget traitlets directly** - synced traitlets are Python
  attributes, for example `widget.value = 5`.

For designing custom visual or interactive output, see
[rich-representations.md](reference/rich-representations.md).

## References

- [gotchas.md](reference/gotchas.md) — name redefinition, cached module proxies, and notebook traps
- [rich-representations.md](reference/rich-representations.md) — custom widgets and visualizations
- [notebook-improvements.md](reference/notebook-improvements.md) — improving existing notebooks
