# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary reader is a maintainer of `marimo-lsp` reviewing PRs #756–#759. They are reading privately and want to understand the conceptual architecture before deciding whether the stack is sound.

## Product Purpose

This standalone explainer compares the previous and proposed cell-execution architectures, walks through each PR in sequence, and makes the gains and unresolved causal risks concrete. Success means the reader can explain what moved, why it moved, and which guarantees the stack does or does not yet earn.

## Positioning

The explainer derives every claim from the actual PR stack and uses executable-looking TypeScript sketches and event timelines rather than generic architecture advice.

## Operating Context

The artifact is opened locally in a desktop browser while reviewing the GitHub PR stack and repository source. It must remain useful offline and on a narrow viewport.

## Capabilities and Constraints

- Cover the complete #756–#759 stack, not only the first PR.
- Compare previous and proposed ownership, Interfaces, state, ordering, and test surfaces.
- Explain `CellRunReducer`, `CellExecutions`, `Drive`, `VsCodeCellDrive`, accepted source, run identity, and notebook lifecycle.
- Separate architectural gains from guarantees that remain incomplete.
- Use no build step, external scripts, remote fonts, or fabricated runtime claims.
- This is a private teaching artifact, not canonical project documentation.

## Evidence on Hand

- GitHub PRs #756–#759 and their final stacked source at commit `640f43a`.
- Current repository source before the stack.
- Existing reducer, execution, staleness, operation-order, and lifecycle tests.
- No project `CONTEXT.md` or architecture decision records are present.

## Product Principles

- Begin with the conceptual delta before showing implementation detail.
- Let the reader replay causality instead of asking them to infer it from static boxes.
- Use the repository's real names and compact code sketches.
- Mark fact, interpretation, gain, and unresolved risk distinctly.
- Make every architectural claim inspectable from more than one view.

## Accessibility & Inclusion

Keyboard navigation, visible focus, semantic headings, sufficient contrast, reduced-motion support, and layouts that remain legible without color are required.
