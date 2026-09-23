import * as Vitest from "@effect/vitest";
import { Effect, Fiber } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import * as AutoExport from "../AutoExport.ts";
import * as TestAutoExport from "./TestAutoExport.ts";

const outputUriIt = EffectTest.make(TestVsCode.layer);

Vitest.describe("outputUri", () => {
  outputUriIt.effect(
    "writes beside the notebook under __marimo__",
    Effect.fn(function* () {
      const code = yield* VsCode.Service;
      const document = TestVsCode.createTestNotebookDocument("/test/report.py");
      const notebook = MarimoNotebookDocument.from(document);

      const uri = AutoExport.outputUri(code, notebook, "html");

      Vitest.expect(uri.path).toBe("/test/__marimo__/report.html");
    }),
  );
});

const it = EffectTest.make(TestAutoExport.layer);
const markdownIt = EffectTest.make(
  TestAutoExport.layerWith({ autoDownload: ["markdown"] }),
);
const noRuntimeIt = EffectTest.make(
  TestAutoExport.layerWith({ hasRuntimeSession: false }),
);
const noOutputsIt = EffectTest.make(
  TestAutoExport.layerWith({ hasOutputs: false }),
);
const blockedHtmlIt = EffectTest.make(
  TestAutoExport.layerWith({ blockHtmlExport: true }),
);

const requestKinds = (snapshot: TestAutoExport.Snapshot) =>
  snapshot.requests.map((request) => request.kind);

Vitest.describe("AutoExport", () => {
  markdownIt.effect(
    "exports Markdown to an md file",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      yield* autoExport.tick;

      const snapshot = yield* autoExport.snapshot;
      Vitest.expect(requestKinds(snapshot)).toEqual(["export-markdown"]);
      Vitest.expect(Object.fromEntries(snapshot.writes)).toEqual({
        "file:///test/__marimo__/report.md": "# Report",
      });
    }),
  );

  noRuntimeIt.effect(
    "waits for a live runtime session before creating exports",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      yield* autoExport.tick;

      Vitest.expect(yield* autoExport.snapshot).toEqual({
        requests: [],
        directories: [],
        writes: new Map(),
      });
    }),
  );

  it.effect(
    "exports enabled formats once per live-session generation",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      yield* autoExport.tick;

      const first = yield* autoExport.snapshot;
      Vitest.expect(requestKinds(first)).toEqual([
        "export-html",
        "export-ipynb",
      ]);
      Vitest.expect(Object.fromEntries(first.writes)).toEqual({
        "file:///test/__marimo__/report.html": "<html>report</html>",
        "file:///test/__marimo__/report.ipynb": "{}",
      });
      Vitest.expect(first.directories).toEqual(["file:///test/__marimo__"]);

      yield* autoExport.tick;
      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toHaveLength(2);

      yield* autoExport.completeRun;
      yield* autoExport.tick;
      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toEqual([
        "export-html",
        "export-ipynb",
        "export-html",
        "export-ipynb",
      ]);
    }),
  );

  it.effect(
    "exports a notebook once when it has multiple visible editors",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      yield* autoExport.activate;
      yield* autoExport.tick;

      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toEqual([
        "export-html",
        "export-ipynb",
      ]);
    }),
  );

  noOutputsIt.effect(
    "waits for cell output before exporting HTML",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      yield* autoExport.tick;
      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toEqual([
        "export-ipynb",
      ]);

      yield* autoExport.addOutput;
      yield* autoExport.completeRun;
      yield* autoExport.tick;

      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toEqual([
        "export-ipynb",
        "export-html",
        "export-ipynb",
      ]);
    }),
  );

  blockedHtmlIt.effect(
    "does not credit an in-flight export to a reopened notebook",
    Effect.fn(function* () {
      const autoExport = yield* TestAutoExport.Service;
      yield* autoExport.activate;
      const firstTick = yield* Effect.forkChild(autoExport.tick);
      yield* autoExport.htmlExportStarted;

      yield* autoExport.reopen;
      yield* autoExport.releaseHtmlExport;
      yield* Fiber.join(firstTick);
      yield* autoExport.tick;

      Vitest.expect(requestKinds(yield* autoExport.snapshot)).toEqual([
        "export-html",
        "export-ipynb",
        "export-html",
        "export-ipynb",
      ]);
    }),
  );
});
