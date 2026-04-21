import { Schema } from "effect";

import type { MarimoConfig } from "../types.ts";

// SAFETY: the schema is intentionally loose — key/value types aren't enforced
// because MarimoConfig's upstream shape changes often. Callers should not
// trust value types beyond this boundary.
// TODO: tighten once MarimoConfig stabilizes.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const MarimoConfigSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Any,
}) as unknown as Schema.Schema<MarimoConfig>;

export const MarimoConfigResponseSchema = Schema.Struct({
  config: MarimoConfigSchema,
});

export const MarimoConfigUpdateResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  config: MarimoConfigSchema,
  error: Schema.String.pipe(Schema.optional),
});
