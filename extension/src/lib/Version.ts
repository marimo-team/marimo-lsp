import * as semver from "@std/semver";
import { Data, Effect, Order, Schema, SchemaGetter, SchemaIssue } from "effect";

/**
 * A version value with semantic-version ordering.
 *
 * Parsing, ordering, and canonical formatting live here so callers do not
 * depend on the underlying semver implementation. Two-part versions are
 * accepted for Python package releases, but this does not implement the full
 * PEP 440 grammar or ordering rules.
 */
export class Version extends Data.Class<{ readonly value: string }> {
  readonly #inner: semver.SemVer;

  private constructor(inner: semver.SemVer) {
    super({ value: semver.format(inner) });
    this.#inner = inner;
  }

  static readonly Schema = Schema.String.pipe(
    Schema.decodeTo(
      Schema.declare<Version>(
        (value): value is Version => value instanceof Version,
      ),
      {
        decode: SchemaGetter.transformOrFail((value) => {
          const parsed =
            semver.tryParse(value) ?? semver.tryParse(`${value}.0`);
          return parsed === undefined
            ? Effect.fail(
                new SchemaIssue.InvalidValue({
                  message: `Invalid semantic version: ${value}`,
                }),
              )
            : Effect.succeed(new Version(parsed));
        }),
        encode: SchemaGetter.transform((version) => version.value),
      },
    ),
  );

  static readonly Order = Order.make<Version>((self, that) =>
    semver.compare(self.#inner, that.#inner),
  );

  static make(value: string): Version {
    return Schema.decodeSync(Version.Schema)(value);
  }

  override toString(): string {
    return this.value;
  }
}
