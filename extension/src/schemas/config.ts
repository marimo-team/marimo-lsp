import { Schema } from "effect";

import type { MarimoConfig } from "../types.ts";

export const MarimoConfigSchema = Schema.Record({
  key: Schema.String,
  value: Schema.Any,
  // TODO: maybe validate more
}) as unknown as Schema.Schema<MarimoConfig>;

export const MarimoConfigResponseSchema = Schema.Struct({
  config: MarimoConfigSchema,
});

export const MarimoConfigUpdateResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  config: MarimoConfigSchema,
  error: Schema.String.pipe(Schema.optional),
});
