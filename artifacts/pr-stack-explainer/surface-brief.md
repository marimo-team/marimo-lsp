# Scope

- Artifact: `architecture-explainer.html`
- Mode: Read
- Audience: one maintainer privately learning the #756–#759 architecture.

# Reader job

Understand the previous architecture, walk through the conceptual contribution of each PR, identify the leverage gained, and see why run correlation and accepted-source provenance remain unresolved.

# Content and constraints

- The full stack is the subject.
- Use actual module and type names with simplified, explicitly illustrative code sketches.
- Provide before/after synchronization, progressive disclosure, and replayable event traces.
- Work offline as one HTML file with no build step or external dependencies.
- Keep the tone candid and explanatory rather than review-comment formal.

# Chosen direction

The Causal Proof Sheet: formal derivations and logic-analyzer traces turn ownership claims into inspectable proofs. The memorable moment is switching a normal run to the edit-before-acknowledgement race and watching the claimed `AcceptedSource` conclusion fail.

# Unresolved decisions

- Whether the marimo protocol can preserve `run_id` on terminal `idle` notifications.
