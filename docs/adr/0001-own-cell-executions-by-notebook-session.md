---
status: accepted
---

# Own cell executions by notebook session

Cell execution state is owned by a `NotebookExecutions` module acquired from `CellExecutions.open(session, binding)`. The parent is indexed by notebook ID but compares exact `OpenNotebookSession` identity, while each notebook handle owns its Cell Runs by cell ID. This prevents operations and finalizers from an old session affecting a notebook reopened at the same URI.

The binding is a stable, session-level way to look up the current presentation `Drive`. It is supplied once when the handle opens rather than passed into every operation. Kernel state is accepted even when presentation is temporarily unavailable. `VsCodeCellDrive` continues to own VS Code execution resources, and its commands remain addressed by run ID.

The Interface is:

```ts
interface CellExecutions {
  open(
    session: OpenNotebookSession,
    binding: NotebookExecutionBinding,
  ): Effect<NotebookExecutions>
}

interface NotebookExecutionBinding {
  readonly getDrive: Effect<Option<Drive>>
}

interface NotebookExecutions {
  apply(op: WireCellOp): Effect<void, RunCorrelationError>
  readonly interrupt: Effect<void>
  remove(cellId: NotebookCellId): Effect<void>

  submit<A, E, R>(
    cells: ReadonlyArray<{ cellId: NotebookCellId; source: string }>,
    send: Effect<A, E, R>,
  ): Effect<A, E, R>

  readonly staleCells: CellStaleness
}

interface CellStaleness {
  readonly current: Effect<HashSet.HashSet<NotebookCellId>>

  // Emits the current set immediately, followed by changed sets.
  readonly changes: Stream.Stream<HashSet.HashSet<NotebookCellId>>
}
```

All mutations enter one ordered notebook lane. `apply` correlates a decoded `WireCellOp` before mutation. `submit` registers the exact outbound sources before sending the execute request and rolls them back if the send does not succeed, so a fast acknowledgement cannot race source capture. Acknowledgements consume same-cell submissions in send order, matching the kernel's command-ordering guarantee.

Presentation is bound once behind the notebook seam, and a private `SubscriptionRef` implements `staleCells` without exposing mutation to callers. Its `changes` stream emits the current value first. The runtime no longer maintains a separate output-rendering/coalescing lane; the notebook handle's interpreter is the single ordered projection path.

The protocol does not attach a run ID to every cell operation. Tagged operations are rejected when their run ID conflicts with the active Cell Run, but an untagged late operation cannot be distinguished from an operation for the active run. Eliminating that residual ambiguity requires a protocol change.
