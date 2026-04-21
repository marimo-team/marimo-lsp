# Schema & Data Modeling

`Schema` is the single source of truth for your domain types. One definition gives you TypeScript types, runtime validation, JSON encoding/decoding, and equality — no separate type declarations, no divergence between what you validate and what you type-check.

## Schema.Class — domain models

```ts
import { Schema } from "effect"

const UserId = Schema.String.pipe(Schema.brand("UserId"))
type UserId = typeof UserId.Type

class User extends Schema.Class<User>("User")({
  id: UserId,
  name: Schema.String,
  email: Schema.String,
  createdAt: Schema.DateFromSelf,
}) {
  // You can add computed properties and methods:
  get displayName() {
    return `${this.name} <${this.email}>`
  }
}
```

Now `User` is simultaneously:
- A TypeScript type (`User` with `.id`, `.name`, `.email`, `.createdAt`)
- A runtime validator (`Schema.decodeUnknown(User)(rawData)`)
- A JSON codec (`Schema.encode(User)(user)` / `Schema.decode(User)(json)`)
- An equality-comparable value (structural comparison via `Equal`)

## Branded types

Branded types prevent mixing primitives that represent different things:

```ts
const UserId = Schema.String.pipe(Schema.brand("UserId"))
const OrderId = Schema.String.pipe(Schema.brand("OrderId"))

type UserId = typeof UserId.Type   // string & Brand<"UserId">
type OrderId = typeof OrderId.Type // string & Brand<"OrderId">

// Compiler prevents: findUser(orderId) — types don't match
```

The guidance from the Effect community is that nearly all domain primitives should be branded — not just IDs, but emails, URLs, ports, amounts, etc.

## Schema.TaggedError — domain errors

Errors that need serialization, pattern matching, or schema validation:

```ts
class ValidationError extends Schema.TaggedError<ValidationError>("ValidationError")(
  "ValidationError",
  {
    field: Schema.String,
    message: Schema.String,
  }
) {
  // Optional: custom message getter for logging
  get message() {
    return `${this.field}: ${this.message}`
  }
}
```

These are yieldable in `Effect.gen` (short-circuits with the error) and have a `_tag` field for pattern matching with `Effect.catchTag`.

## Data.TaggedError — lightweight errors

When you don't need schema validation/serialization:

```ts
import { Data } from "effect"

class Timeout extends Data.TaggedError("Timeout")<{
  readonly duration: number
}> {}
```

Same yieldable behavior, same `_tag` for catchTag — just no schema overhead.

## Common schema combinators

```ts
// Primitives:
Schema.String, Schema.Number, Schema.Boolean, Schema.Date

// Optional fields:
Schema.optional(Schema.String)           // T | undefined
Schema.optionalWith(Schema.String, { default: () => "" })

// Unions and literals:
Schema.Union(Schema.String, Schema.Number)
Schema.Literal("admin", "user", "guest")

// Arrays and records:
Schema.Array(User)
Schema.Record({ key: Schema.String, value: Schema.Number })

// Transformations (e.g., string -> number):
Schema.NumberFromString  // decodes "42" to 42

// Filters:
Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255))
Schema.Number.pipe(Schema.int(), Schema.between(1, 65535))
```

## Encoding and decoding

```ts
import { Schema } from "effect"

// Decode unknown data (validation):
const result = Schema.decodeUnknownSync(User)({
  id: "usr_123",
  name: "Alice",
  email: "alice@example.com",
  createdAt: new Date()
})

// As an Effect (typed errors):
const decoded = yield* Schema.decodeUnknown(User)(rawData)

// Encode to JSON-safe format:
const json = Schema.encodeSync(User)(user)
```

## Where to look in the codebase

- **Schema public API**: `packages/effect/src/Schema.ts` — all constructors, combinators, class builders
- **Schema AST**: `packages/effect/src/SchemaAST.ts` — the abstract syntax tree that schemas compile to
- **ParseResult**: `packages/effect/src/ParseResult.ts` — parse error representation
- **Schema internals**: `packages/effect/src/internal/schema/` — encoding, decoding, validation logic
- **Data module**: `packages/effect/src/Data.ts` — `TaggedError`, `TaggedClass`, `Class`, structural equality helpers
