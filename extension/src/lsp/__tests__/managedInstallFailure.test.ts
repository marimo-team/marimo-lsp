import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { Uri } from "../../__mocks__/TestVsCode.ts";
import { ExtensionContext, Storage } from "../../platform/Storage.ts";
import {
  clearManagedInstallFailure,
  getManagedInstallFailure,
  matchesManagedInstallFailure,
  setManagedInstallFailure,
} from "../managedInstallFailure.ts";

const makeStorageLayer = () =>
  Storage.layer.pipe(
    Layer.provide(
      Layer.succeed(ExtensionContext, {
        globalState: new Memento(),
        workspaceState: new Memento(),
        extensionUri: Uri.parse("file:///test/extension/path", true),
        globalStorageUri: Uri.parse(
          "file:///test/extension/global-storage",
          true,
        ),
      }),
    ),
  );

it.effect(
  "persists and clears a managed installation failure",
  Effect.fn(function* () {
    const layer = makeStorageLayer();
    const failure = {
      extensionVersion: "0.16.2",
      serverVersion: "0.0.63",
      details: "certificate validation failed",
    };

    yield* Effect.gen(function* () {
      yield* setManagedInstallFailure("ty", failure);
      expect(yield* getManagedInstallFailure("ty")).toEqual(
        Option.some(failure),
      );

      yield* clearManagedInstallFailure("ty");
      expect(Option.isNone(yield* getManagedInstallFailure("ty"))).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it("matches only the current extension and server versions", () => {
  const failure = Option.some({
    extensionVersion: "0.16.2",
    serverVersion: "0.0.63",
    details: "certificate validation failed",
  });

  expect(
    matchesManagedInstallFailure(failure, {
      extensionVersion: "0.16.2",
      serverVersion: "0.0.63",
    }),
  ).toBe(true);
  expect(
    matchesManagedInstallFailure(failure, {
      extensionVersion: "0.16.3",
      serverVersion: "0.0.63",
    }),
  ).toBe(false);
  expect(
    matchesManagedInstallFailure(failure, {
      extensionVersion: "0.16.2",
      serverVersion: "0.0.64",
    }),
  ).toBe(false);
});
