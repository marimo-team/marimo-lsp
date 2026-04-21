---
name: effect-ts
description: "Deep reference for the Effect TypeScript library. Use this skill whenever working in a codebase that imports from 'effect' or '@effect/*', when writing Effect-based TypeScript, or when the user asks about Effect patterns, services, layers, schemas, streams, fibers, or error handling. Treat Effect as foundational infrastructure — read the relevant reference doc before writing Effect code, and go deep into the source when you need to understand a primitive."
---

# Effect

Effect is not a library you call into — it is the foundation your program is built on. When you see `Effect` in a codebase, think of it the way you think of `async/await` or `Promise`: it is the core abstraction for describing what your program *does*.

Every Effect program is built from a small set of primitives that compose together. Understanding these primitives deeply — not just their API, but *why* they exist and how they fit together — is what makes the difference between fighting the framework and flowing with it.

## The core type

```ts
Effect<Success, Error, Requirements>
//       A        E         R
```

- **A** — what the effect produces on success
- **E** — what errors it can fail with (typed, not thrown)
- **R** — what services/context it needs to run

This triple is the type-level contract of every effectful computation. The compiler tracks all three, so you always know what can go wrong and what dependencies are missing.

## Primitives

When working with a specific primitive, read its reference doc — each one explains the concept, shows idiomatic usage, and points to where in the Effect codebase to look for deeper understanding.

| Primitive | What it is | Reference |
|-----------|-----------|-----------|
| **Effect** | The core computation type — `gen`, `fn`, `pipe`, running | [effect-core.md](references/effect-core.md) |
| **Services & Layers** | Typed dependency injection — `Context.Tag`, `Layer`, providing | [services-and-layers.md](references/services-and-layers.md) |
| **Error handling** | Typed errors, `Cause`, catch/recovery patterns | [error-handling.md](references/error-handling.md) |
| **Schema & Data** | Runtime validation, data classes, branded types | [schema-and-data.md](references/schema-and-data.md) |
| **Concurrency** | `Fiber`, `Deferred`, `Queue`, `PubSub`, `Ref`, `Pool` | [concurrency.md](references/concurrency.md) |
| **Streams** | Pull-based streaming — `Stream`, `Sink`, `Channel` | [streams.md](references/streams.md) |
| **Resources** | `Scope`, `acquireRelease`, finalizers | [resource-management.md](references/resource-management.md) |
| **Scheduling** | `Schedule` for retry, repeat, and recurrence | [scheduling.md](references/scheduling.md) |
| **Testing** | `@effect/vitest`, `TestClock`, test layers | [testing.md](references/testing.md) |
| **Patterns** | Idioms, anti-patterns, and common recipes | [patterns.md](references/patterns.md) |

## Philosophy

These principles inform every design decision in Effect:

1. **Errors are values, not exceptions.** Every failure mode is tracked in the type system. You handle errors explicitly, not with try/catch.

2. **Dependencies are declared, not imported.** Services are accessed through the type system (`R` parameter), wired at the edge of your program, and trivially swappable for testing.

3. **Resources clean up after themselves.** Scopes and finalizers guarantee cleanup even under interruption or failure. No dangling connections.

4. **Concurrency is structured.** Fibers form parent-child trees. Interruption propagates. No orphaned work.

5. **Composition over configuration.** Small primitives combine into complex behaviors. `pipe` chains cross-cutting concerns (retry, timeout, tracing) without modifying business logic.

## Navigating the Effect codebase

The Effect source lives in `packages/effect/src/`. The codebase follows a consistent pattern:

- **Public API** — `packages/effect/src/ModuleName.ts` exports types, constructors, and combinators. Read docstrings here for usage guidance.
- **Internal implementation** — `packages/effect/src/internal/` contains the actual logic. When you need to understand *how* something works (not just *what* it does), look here.
- **Key internal files**:
  - `internal/core.ts` / `internal/core-effect.ts` — core Effect primitives and operators
  - `internal/fiberRuntime.ts` — the fiber execution engine (~3800 lines, the heart of the runtime)
  - `internal/layer/` — Layer construction and memoization
  - `internal/stream/` — Stream implementation
  - `internal/stm/` — Software Transactional Memory

When you need to understand a primitive, start with the public module's docstrings, then follow the imports into `internal/` for the implementation.
