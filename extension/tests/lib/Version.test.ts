import * as Vitest from "@effect/vitest";
import { Equal, Option, Order, Schema } from "effect";

import { Version } from "../../src/lib/Version.ts";

Vitest.describe("Version", () => {
  const decode = Schema.decodeSync(Version.Schema);

  Vitest.it("parses and canonically formats semantic versions", () => {
    Vitest.expect(decode("1.2.3").toString()).toBe("1.2.3");
    Vitest.expect(decode("26.2").toString()).toBe("26.2.0");
    Vitest.expect(decode("0.21.0-rc1").toString()).toBe("0.21.0-rc1");
  });

  Vitest.it("rejects invalid versions", () => {
    Vitest.expect(
      Option.isNone(Schema.decodeOption(Version.Schema)("invalid")),
    ).toBe(true);
    Vitest.expect(Option.isNone(Schema.decodeOption(Version.Schema)(""))).toBe(
      true,
    );
  });

  Vitest.it("provides semantic equality and ordering", () => {
    const minimum = Version.make("0.12.0");
    const isAtLeast = Order.isGreaterThanOrEqualTo(Version.Order);
    Vitest.expect(isAtLeast(decode("0.11.9"), minimum)).toBe(false);
    Vitest.expect(isAtLeast(decode("0.12.0"), minimum)).toBe(true);
    Vitest.expect(isAtLeast(decode("0.13.0"), minimum)).toBe(true);
    Vitest.expect(Equal.equals(decode("26.2"), decode("26.2.0"))).toBe(true);
    Vitest.expect(
      Order.isLessThan(Version.Order)(decode("1.0.0-rc1"), decode("1.0.0")),
    ).toBe(true);
  });

  Vitest.it("round-trips through its Effect schema", () => {
    const version = decode("1.2.3+build.4");
    Vitest.expect(Schema.encodeSync(Version.Schema)(version)).toBe(
      "1.2.3+build.4",
    );
  });
});
