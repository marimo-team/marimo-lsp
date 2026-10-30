import { Schema } from "effect";

/** Reject unknown wire fields on both sides of an owned protocol schema. */
export const ownedStruct = <Fields extends Schema.Struct.Fields>(
  fields: Fields,
) => {
  const knownKeys = Schema.isPropertyNames(
    Schema.Literals(Object.keys(fields)),
  );
  return (
    Schema.Struct(fields)
      .check(knownKeys)
      // Encoded-side checks run before decoding strips unknown properties.
      .pipe(Schema.flip, Schema.check(knownKeys), Schema.flip)
  );
};
