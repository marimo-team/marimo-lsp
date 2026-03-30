import * as semver from "@std/semver";
import { ParseResult, Schema } from "effect";

export const SemVerFromString = Schema.transformOrFail(
  Schema.String,
  Schema.Struct({
    major: Schema.Number,
    minor: Schema.Number,
    patch: Schema.Number,
  }),
  {
    decode: (from) => {
      const parsed = semver.tryParse(from);
      if (parsed) {
        return ParseResult.succeed(parsed);
      }
      // some PyPI versions aren't valid
      const parsed2 = semver.tryParse(`${from}.0`);
      if (parsed2) {
        return ParseResult.succeed(parsed2);
      }
      return ParseResult.fail(
        new ParseResult.Type(
          Schema.String.ast,
          from,
          `Invalid semver string: ${from}`,
        ),
      );
    },
    encode: (to) => ParseResult.succeed(semver.format(to)),
  },
);
