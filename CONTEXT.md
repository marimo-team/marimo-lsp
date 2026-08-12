# marimo-lsp Execution Context

This context describes how kernel cell activity is tracked for an open marimo notebook and projected into VS Code.

## Language

**Notebook Session**:
One lifetime of an open notebook document. Reopening the same notebook URI creates a different Notebook Session.
_Avoid_: Notebook ID when referring to lifetime or causal identity

**Notebook Executions**:
The session-owned collection of Cell Runs for one Notebook Session. It owns their ordering, correlation, accepted sources, staleness, and presentation lifetime.
_Avoid_: Global cell execution registry, execution service

**Cell Run**:
One causally identified kernel execution of a notebook cell. A cell can have many Cell Runs over the lifetime of a Notebook Session.
_Avoid_: Cell execution when the distinction between successive runs matters

**Wire Cell Operation**:
A decoded cell operation received from the kernel protocol. Its shape is valid, but it is not trusted to mutate a Cell Run until its run identity is correlated.
_Avoid_: Cell event, correlated operation

**Accepted Source**:
The source identity confirmed for a particular Cell Run. It comes from causal protocol or submission data, not from sampling the editor when an acknowledgement arrives.
_Avoid_: Current source, editor source

**Cell Submission**:
An outbound execute request together with the cell IDs and exact sources sent to the kernel. Notebook Executions register this provenance before sending and accept it when the queued acknowledgement arrives.
_Avoid_: Pending editor state, current cell text

**Stale Cell**:
A cell whose current source differs from its Accepted Source, or whose accepted source has been invalidated by kernel state.
_Avoid_: Dirty cell, changed cell

## Example dialogue

**Developer:** This Wire Cell Operation says the cell started. Can I apply it to the active Cell Run?

**Domain expert:** Only after its run identity is correlated. Then the Notebook Executions for that Notebook Session can apply it in order.

**Developer:** What happens when the user edits the cell afterward?

**Domain expert:** Its current source no longer matches the Accepted Source, so the Notebook Executions report it as a Stale Cell.
