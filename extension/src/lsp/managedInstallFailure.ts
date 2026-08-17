import { Effect, Option, Schema } from "effect";

import { createStorageKey, Storage } from "../platform/Storage.ts";

const ManagedInstallFailure = Schema.Struct({
  extensionVersion: Schema.String,
  serverVersion: Schema.String,
  details: Schema.String,
});

export type ManagedInstallFailure = typeof ManagedInstallFailure.Type;

const storageKey = (serverName: string) =>
  createStorageKey(
    `languageServer.${serverName}.installFailure`,
    ManagedInstallFailure,
  );

export const getManagedInstallFailure = Effect.fn("ManagedInstallFailure.get")(
  function* (serverName: string) {
    const storage = yield* Storage;
    return yield* storage.global.get(storageKey(serverName));
  },
);

export const setManagedInstallFailure = Effect.fn("ManagedInstallFailure.set")(
  function* (serverName: string, failure: ManagedInstallFailure) {
    const storage = yield* Storage;
    yield* storage.global.set(storageKey(serverName), failure);
  },
);

export const clearManagedInstallFailure = Effect.fn(
  "ManagedInstallFailure.clear",
)(function* (serverName: string) {
  const storage = yield* Storage;
  yield* storage.global.delete(storageKey(serverName));
});

export function matchesManagedInstallFailure(
  failure: Option.Option<ManagedInstallFailure>,
  current: Pick<ManagedInstallFailure, "extensionVersion" | "serverVersion">,
): failure is Option.Some<ManagedInstallFailure> {
  return (
    Option.isSome(failure) &&
    failure.value.extensionVersion === current.extensionVersion &&
    failure.value.serverVersion === current.serverVersion
  );
}
