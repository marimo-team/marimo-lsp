import { Schema } from "effect";

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
