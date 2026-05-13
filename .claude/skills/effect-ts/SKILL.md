---
name: effect-ts
description: Idiomatic Effect-TS patterns for the marimo-lsp extension. Use when writing or reviewing Effect code in `extension/src` — grounded in this repo's actual usage and citing into vendored Effect source at `repos/effect/`.
---

# Effect-TS patterns (marimo-lsp)

This skill is an index. Each file in `patterns/` is a short, code-heavy reference for one slice of the Effect API, with worked examples from `extension/src` and cites into `repos/effect/packages/effect/src/`.

Run `just vendor-effect` first if `repos/effect/` is empty — the pattern files reference paths inside it.

## When to read which file

| Working on | Read |
|---|---|
| A new service or wiring `MainLive` | [`patterns/layers-services.md`](patterns/layers-services.md) |
| A function in the `Effect` channel (entry point, span, log) | [`patterns/effect-core.md`](patterns/effect-core.md) |
| Parsing data at a boundary (LSP, config, file) | [`patterns/schema.md`](patterns/schema.md) |
| Typed domain errors / `catchTag` / `Cause` / `Exit` | [`patterns/data-errors.md`](patterns/data-errors.md) |
| Consuming or producing a `Stream` (e.g. `marimo/operation`) | [`patterns/streams.md`](patterns/streams.md) |
| Replacing a nullable type or `Either` flow | [`patterns/option-either.md`](patterns/option-either.md) |
| Holding state inside a service (`Ref`, `SubscriptionRef`, `Deferred`) | [`patterns/state.md`](patterns/state.md) |
| Writing a test (`it.effect`, `TestClock`, mocks) | [`patterns/testing.md`](patterns/testing.md) |

## Conventions

Every pattern file follows the same shape: TL;DR, constructors/combinators table, worked examples from this repo, worked examples from Effect itself, error handling, and a "what to avoid" section. Code samples honor the repo conventions in `CLAUDE.md` (named `Effect.fn`, `annotateLogs` over interpolation, `withSpan` on external calls, no `as T` without `// SAFETY:`).

When a pattern file disagrees with `repos/effect/` source, trust the source — file an issue or open a PR to fix the pattern doc.
