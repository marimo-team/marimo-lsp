import * as semver from "@std/semver";
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";

export const SemVerFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Struct({
      major: Schema.Number,
      minor: Schema.Number,
      patch: Schema.Number,
    }),
    {
      decode: SchemaGetter.transformOrFail((from: string) => {
        const parsed = semver.tryParse(from);
        if (parsed) {
          return Effect.succeed(parsed);
        }
        // some PyPI versions aren't valid
        const parsed2 = semver.tryParse(`${from}.0`);
        if (parsed2) {
          return Effect.succeed(parsed2);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue({
            message: `Invalid semver string: ${from}`,
          }),
        );
      }),
      encode: SchemaGetter.transform((to) => semver.format(to)),
    },
  ),
);
