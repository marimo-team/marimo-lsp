import {
  FetchHttpClient,
  HttpApi,
  HttpApiClient,
  HttpApiEndpoint,
  HttpApiGroup,
} from "@effect/platform";
import { Data, Effect, Schema } from "effect";

const Package = Schema.Struct({
  name: Schema.String,
});

const PackageMetadata = Schema.Struct({
  info: Schema.Struct({
    provides_extra: Schema.String.pipe(Schema.Array, Schema.NullOr),
  }),
  releases: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const PyPiApi = HttpApi.make("PyPiApi").add(
  HttpApiGroup.make("Packages").add(
    HttpApiEndpoint.get("getMetadata", "/:name/json")
      .setPath(Package)
      .addSuccess(PackageMetadata),
  ),
);

class PyPiClientError extends Data.TaggedError("PyPiClientError")<{
  cause: unknown;
}> {}

export class PyPiClient extends Effect.Service<PyPiClient>()("PyPiClient", {
  dependencies: [FetchHttpClient.layer],
  effect: Effect.gen(function* () {
    const client = yield* HttpApiClient.make(PyPiApi, {
      baseUrl: "https://pypi.org/pypi",
    });
    return {
      getPackageMetadata: (name: string) =>
        Effect.gen(function* () {
          const cleanedName = cleanPythonModuleName(name);
          const raw = yield* client.Packages.getMetadata({
            path: { name: cleanedName },
          });
          return {
            extras: raw.info.provides_extra ?? [],
            versions: Object.keys(raw.releases).toSorted(reverseSemverSort),
          };
        }).pipe(Effect.mapError((cause) => new PyPiClientError({ cause }))),
    };
  }),
}) {}

/* Copyright 2024 Marimo. All rights reserved. */

function semverSort(a: string, b: string) {
  const semverRegex = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?(?:\+([\w.-]+))?$/;

  const parseSemver = (version: string) => {
    const match = version.match(semverRegex);
    if (!match) {
      return null;
    }

    const [, major, minor, patch, preRelease] = match;
    return {
      major: Number.parseInt(major, 10),
      minor: Number.parseInt(minor, 10),
      patch: Number.parseInt(patch, 10),
      preRelease: preRelease || "",
    };
  };

  try {
    const aParsed = parseSemver(a);
    const bParsed = parseSemver(b);

    if (!aParsed || !bParsed) {
      return a.localeCompare(b, undefined, {
        numeric: true,
        sensitivity: "base",
      });
    }

    if (aParsed.major !== bParsed.major) {
      return aParsed.major - bParsed.major;
    }
    if (aParsed.minor !== bParsed.minor) {
      return aParsed.minor - bParsed.minor;
    }
    if (aParsed.patch !== bParsed.patch) {
      return aParsed.patch - bParsed.patch;
    }

    if (aParsed.preRelease === "" && bParsed.preRelease !== "") {
      return 1;
    }
    if (aParsed.preRelease !== "" && bParsed.preRelease === "") {
      return -1;
    }

    return aParsed.preRelease.localeCompare(bParsed.preRelease);
  } catch {
    return a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }
}

const reverseSemverSort = (a: string, b: string) => semverSort(b, a);

/**
 * Remove any `[` and `]` characters from the module name. For example:
 * `ibis-framework[duckdb]` -> `ibis-framework`
 */
function cleanPythonModuleName(name: string) {
  return name.replaceAll(/\[.*]/g, "").trim();
}
