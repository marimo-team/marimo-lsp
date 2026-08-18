import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber, Latch, Ref, Scope } from "effect";

import { notebookId } from "../../lib/__tests__/branded.ts";
import { makeNotebookExecutor } from "../NotebookExecutor.ts";

describe("NotebookExecutor", () => {
  it.effect(
    "keeps admitted work after its caller stops waiting",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const started = yield* Latch.make();
      const release = yield* Latch.make();
      const completed = yield* Latch.make();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebook = notebookId("notebook");

      const caller = yield* executor
        .submit(
          notebook,
          Effect.gen(function* () {
            yield* started.open;
            yield* release.await;
            yield* Ref.update(order, (events) => [...events, "first"]);
            yield* completed.open;
          }),
        )
        .pipe(Effect.forkChild);

      yield* started.await;
      yield* Fiber.interrupt(caller);
      yield* executor.post(
        notebook,
        Ref.update(order, (events) => [...events, "second"]),
      );

      assert.deepStrictEqual(yield* Ref.get(order), []);
      yield* release.open;
      yield* completed.await;
      yield* Effect.yieldNow;
      assert.deepStrictEqual(yield* Ref.get(order), ["first", "second"]);
    }),
  );

  it.effect(
    "interrupts active and buffered replies when its scope closes",
    Effect.fn(function* () {
      const scope = yield* Scope.make();
      const executor = yield* makeNotebookExecutor<never>().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const started = yield* Latch.make();
      const bufferedStarted = yield* Ref.make(false);
      const notebook = notebookId("notebook");

      const active = yield* executor
        .submit(notebook, started.open.pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkDetach);
      yield* started.await;

      const buffered = yield* executor
        .submit(
          notebook,
          Ref.set(bufferedStarted, true).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkDetach);
      yield* Effect.yieldNow;

      yield* Scope.close(scope, Exit.void);
      const [activeExit, bufferedExit] = yield* Effect.all([
        Fiber.await(active),
        Fiber.await(buffered),
      ]);

      assert.isTrue(Exit.hasInterrupts(activeExit));
      assert.isTrue(Exit.hasInterrupts(bufferedExit));
      assert.isFalse(yield* Ref.get(bufferedStarted));

      const afterClose = yield* Effect.exit(
        executor.submit(notebook, Effect.void),
      );
      assert.isTrue(Exit.hasInterrupts(afterClose));

      const postAfterClose = yield* Effect.exit(
        executor.post(notebook, Effect.void),
      );
      assert.isTrue(Exit.hasInterrupts(postAfterClose));
    }),
  );

  it.effect(
    "keeps processing after a posted defect or interruption",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const notebook = notebookId("notebook");

      yield* executor.post(notebook, Effect.die("posted defect"));
      yield* executor.post(notebook, Effect.interrupt);

      const result = yield* executor.submit(notebook, Effect.succeed("done"));
      assert.strictEqual(result, "done");
    }),
  );

  it.effect(
    "interrupts a retired worker that is still draining",
    Effect.fn(function* () {
      const scope = yield* Scope.make();
      const executor = yield* makeNotebookExecutor<never>().pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const blockerStarted = yield* Latch.make();
      const releaseBlocker = yield* Latch.make();
      const routed = yield* Latch.make();
      const trailingStarted = yield* Latch.make();
      const bufferedStarted = yield* Ref.make(false);
      const notebook = notebookId("notebook");

      yield* executor.post(
        notebook,
        blockerStarted.open.pipe(Effect.andThen(releaseBlocker.await)),
      );
      yield* blockerStarted.await;

      yield* executor.retire(notebook);
      const trailing = yield* executor
        .submit(
          notebook,
          trailingStarted.open.pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkDetach);
      const buffered = yield* executor
        .submit(
          notebook,
          Ref.set(bufferedStarted, true).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Effect.forkDetach);

      // Work for another notebook proves the coordinator routed everything
      // above while the first actor was still blocked. The retire marker will
      // remove that actor from the lookup map before its trailing work runs.
      yield* executor.post(notebookId("barrier"), routed.open);
      yield* routed.await;
      yield* releaseBlocker.open;
      yield* trailingStarted.await;

      yield* Scope.close(scope, Exit.void);
      const [trailingExit, bufferedExit] = yield* Effect.all([
        Fiber.await(trailing),
        Fiber.await(buffered),
      ]);

      assert.isTrue(Exit.hasInterrupts(trailingExit));
      assert.isTrue(Exit.hasInterrupts(bufferedExit));
      assert.isFalse(yield* Ref.get(bufferedStarted));
    }),
  );

  it.effect(
    "retires a notebook after draining admitted work",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebook = notebookId("notebook");

      yield* executor.post(
        notebook,
        Ref.update(order, (events) => [...events, "before"]),
      );
      yield* executor.retire(notebook);
      yield* executor.post(
        notebook,
        Ref.update(order, (events) => [...events, "after"]),
      );

      const result = yield* executor.submit(notebook, Effect.succeed("done"));
      assert.strictEqual(result, "done");
      assert.deepStrictEqual(yield* Ref.get(order), ["before", "after"]);
    }),
  );
});
