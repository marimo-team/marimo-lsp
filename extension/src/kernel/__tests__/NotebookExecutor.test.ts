import * as Vitest from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Latch, Ref, Scope } from "effect";

import { makeScopedResourceCounter } from "../../__tests__/lib/scopedResourceCounter.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import {
  makeNotebookExecutor,
  NotebookExecutionScopeClosedError,
} from "../NotebookExecutor.ts";

Vitest.describe("NotebookExecutor", () => {
  Vitest.it.effect(
    "keeps admitted work after its caller stops waiting",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const started = yield* Latch.make();
      const release = yield* Latch.make();
      const completed = yield* Latch.make();
      const secondCompleted = yield* Latch.make();
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
        Ref.update(order, (events) => [...events, "second"]).pipe(
          Effect.andThen(secondCompleted.open),
        ),
      );

      Vitest.assert.deepStrictEqual(yield* Ref.get(order), []);
      yield* release.open;
      yield* completed.await;
      yield* secondCompleted.await;
      Vitest.assert.deepStrictEqual(yield* Ref.get(order), ["first", "second"]);
    }),
  );

  Vitest.it.effect(
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
        .pipe(Effect.forkDetach({ startImmediately: true }));

      yield* Scope.close(scope, Exit.void);
      const [activeExit, bufferedExit] = yield* Effect.all([
        Fiber.await(active),
        Fiber.await(buffered),
      ]);

      Vitest.assert.isTrue(Exit.hasInterrupts(activeExit));
      Vitest.assert.isTrue(Exit.hasInterrupts(bufferedExit));
      Vitest.assert.isFalse(yield* Ref.get(bufferedStarted));

      const afterClose = yield* Effect.exit(
        executor.submit(notebook, Effect.void),
      );
      Vitest.assert.isTrue(Exit.hasInterrupts(afterClose));

      const postAfterClose = yield* Effect.exit(
        executor.post(notebook, Effect.void),
      );
      Vitest.assert.isTrue(Exit.hasInterrupts(postAfterClose));
    }),
  );

  Vitest.it.effect(
    "interrupts work owned by a document scope without closing the executor",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const documentScope = yield* Scope.make();
      const started = yield* Latch.make();
      const bufferedStarted = yield* Ref.make(false);
      const notebook = notebookId("notebook");

      const active = yield* executor
        .submitScoped(notebook, started.open.pipe(Effect.andThen(Effect.never)))
        .pipe(Scope.provide(documentScope))
        .pipe(Effect.forkDetach);
      yield* started.await;

      const buffered = yield* executor
        .submitScoped(
          notebook,
          Ref.set(bufferedStarted, true).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(Scope.provide(documentScope))
        .pipe(Effect.forkDetach({ startImmediately: true }));

      yield* Scope.close(documentScope, Exit.void);
      const [activeExit, bufferedExit] = yield* Effect.all([
        Fiber.await(active),
        Fiber.await(buffered),
      ]);

      for (const exit of [activeExit, bufferedExit]) {
        Vitest.assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) continue;
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        Vitest.assert.instanceOf(
          failure?.error,
          NotebookExecutionScopeClosedError,
        );
        Vitest.expect(failure?.error).toMatchObject({ notebookId: notebook });
      }
      Vitest.assert.isFalse(yield* Ref.get(bufferedStarted));

      const result = yield* executor.submit(notebook, Effect.succeed("done"));
      Vitest.assert.strictEqual(result, "done");
    }),
  );

  Vitest.it.effect(
    "rejects queued scoped work as soon as its scope closes",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const documentScope = yield* Scope.make();
      const blockerStarted = yield* Latch.make();
      const releaseBlocker = yield* Latch.make();
      const queuedStarted = yield* Ref.make(false);
      const notebook = notebookId("notebook");

      yield* executor.post(
        notebook,
        blockerStarted.open.pipe(Effect.andThen(releaseBlocker.await)),
      );
      yield* blockerStarted.await;

      const queued = yield* executor
        .submitScoped(
          notebook,
          Ref.set(queuedStarted, true).pipe(Effect.andThen(Effect.never)),
        )
        .pipe(
          Scope.provide(documentScope),
          Effect.forkDetach({ startImmediately: true }),
        );

      yield* Scope.close(documentScope, Exit.void);
      const exit = yield* Fiber.await(queued);
      Vitest.assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        Vitest.assert.instanceOf(
          failure?.error,
          NotebookExecutionScopeClosedError,
        );
      }

      yield* releaseBlocker.open;
      Vitest.assert.strictEqual(
        yield* executor.submit(notebook, Effect.succeed("done")),
        "done",
      );
      Vitest.assert.isFalse(yield* Ref.get(queuedStarted));
    }),
  );

  Vitest.it.effect(
    "releases resources owned by completed scoped submissions",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const documentScope = yield* Scope.make();
      const notebook = notebookId("notebook");
      const resources = yield* makeScopedResourceCounter();

      for (let index = 0; index < 100; index++) {
        yield* executor
          .submitScoped(notebook, resources.track(Effect.void))
          .pipe(Scope.provide(documentScope));
      }

      Vitest.assert.deepStrictEqual(yield* resources.counts, {
        acquired: 100,
        released: 100,
        active: 0,
      });
      yield* Scope.close(documentScope, Exit.void);
    }),
  );

  Vitest.it.effect(
    "preserves self-interruption while the owning scope remains open",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const documentScope = yield* Scope.make();
      const notebook = notebookId("notebook");

      const submitted = yield* executor
        .submitScoped(notebook, Effect.interrupt)
        .pipe(Scope.provide(documentScope), Effect.forkDetach);

      Vitest.assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(submitted)));
      yield* Scope.close(documentScope, Exit.void);
    }),
  );

  Vitest.it.effect(
    "keeps processing after a posted defect or interruption",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const notebook = notebookId("notebook");

      yield* executor.post(notebook, Effect.die("posted defect"));
      yield* executor.post(notebook, Effect.interrupt);

      const result = yield* executor.submit(notebook, Effect.succeed("done"));
      Vitest.assert.strictEqual(result, "done");
    }),
  );

  Vitest.it.effect(
    "preserves FIFO while idle workers retire",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebook = notebookId("notebook");

      for (let index = 0; index < 100; index++) {
        yield* executor.submit(
          notebook,
          Ref.update(order, (events) => [...events, String(index)]),
        );
      }

      Vitest.assert.deepStrictEqual(
        yield* Ref.get(order),
        Array.from({ length: 100 }, (_, index) => String(index)),
      );
    }),
  );
});
