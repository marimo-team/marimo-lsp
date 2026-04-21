# Scheduling

`Schedule<Out, In, R>` describes a recurrence pattern — when and how many times to repeat or retry an effect. Schedules are composable: you build complex retry/repeat policies from simple building blocks.

## Common schedules

```ts
import { Schedule } from "effect"

Schedule.forever                          // repeat indefinitely
Schedule.once                             // run one additional time
Schedule.recurs(5)                        // repeat 5 times
Schedule.spaced("1 second")              // fixed delay between runs
Schedule.fixed("1 second")              // fixed interval (compensates for execution time)
Schedule.exponential("100 millis")       // 100ms, 200ms, 400ms, 800ms...
Schedule.exponential("100 millis", 1.5)  // custom growth factor
Schedule.fibonacci("100 millis")         // fibonacci-based delays
```

## Composing schedules

```ts
// Exponential backoff, max 5 retries:
Schedule.exponential("100 millis").pipe(
  Schedule.compose(Schedule.recurs(5))
)

// Exponential with a ceiling:
Schedule.exponential("100 millis").pipe(
  Schedule.either(Schedule.spaced("10 seconds")) // cap at 10s
)

// Add jitter to avoid thundering herd:
Schedule.exponential("100 millis").pipe(
  Schedule.jittered
)

// Union — continue while either schedule wants to continue:
Schedule.union(scheduleA, scheduleB)

// Intersection — continue only while both want to continue:
Schedule.intersect(scheduleA, scheduleB)
```

## Using with retry and repeat

```ts
// Retry a failing effect:
const result = yield* fetchData.pipe(
  Effect.retry(Schedule.exponential("100 millis").pipe(
    Schedule.compose(Schedule.recurs(3))
  ))
)

// Retry with a filter (only retry certain errors):
yield* fetchData.pipe(
  Effect.retry({
    schedule: Schedule.recurs(3),
    while: (err) => err._tag === "Timeout"
  })
)

// Repeat a succeeding effect:
yield* pollForUpdates.pipe(
  Effect.repeat(Schedule.spaced("5 seconds"))
)

// Repeat until a condition:
yield* pollForUpdates.pipe(
  Effect.repeat({
    schedule: Schedule.spaced("1 second"),
    until: (result) => result.status === "complete"
  })
)
```

## Simplified retry

For simple cases, `Effect.retry` accepts a plain object:

```ts
yield* fetchData.pipe(
  Effect.retry({ times: 3 })
)
```

## Where to look in the codebase

- **Schedule public API**: `packages/effect/src/Schedule.ts` — all constructors and combinators
- **Schedule internals**: `packages/effect/src/internal/schedule.ts`
- **ScheduleDecision**: `packages/effect/src/ScheduleDecision.ts` — continue/done decisions
- **retry/repeat**: search `Effect.ts` for `retry` and `repeat`
