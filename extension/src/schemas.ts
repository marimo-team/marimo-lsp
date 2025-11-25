import * as semver from "@std/semver";
import { ParseResult, Schema } from "effect";

export * from "./schemas/packages.ts";
export * from "./schemas/vscode-notebook.ts";

const Header = Schema.Struct({
  value: Schema.String.pipe(Schema.optionalWith({ nullable: true })),
});

const AppInstantiation = Schema.Struct({
  options: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const CellDef = Schema.Struct({
  code: Schema.String,
  name: Schema.String.pipe(
    Schema.optionalWith({ nullable: true }),
    Schema.withDecodingDefault(() => "_"),
  ),
  options: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

const Violation = Schema.Struct({
  description: Schema.String,
  lineno: Schema.Int.pipe(
    Schema.optionalWith({ nullable: true }),
    Schema.withDecodingDefault(() => 0),
  ),
  col_offset: Schema.Int.pipe(
    Schema.optionalWith({ nullable: true }),
    Schema.withDecodingDefault(() => 0),
  ),
});

/**
 * Our internal IR for a marimo notebook used to send over the wire
 */
export const MarimoNotebook = Schema.Struct({
  app: AppInstantiation,
  header: Header.pipe(Schema.NullOr),
  version: Schema.String.pipe(Schema.NullOr),
  cells: Schema.Array(CellDef),
  violations: Schema.Array(Violation),
  valid: Schema.Boolean,
});

export type MarimoNotebook = typeof MarimoNotebook.Type;

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
