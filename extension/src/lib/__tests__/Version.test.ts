import { describe, expect, it } from "@effect/vitest";
import { Equal, Option, Order, Schema } from "effect";

import { Version } from "../Version.ts";

describe("Version", () => {
  const decode = Schema.decodeSync(Version.Schema);

  it("parses and canonically formats semantic versions", () => {
    expect(decode("1.2.3").toString()).toBe("1.2.3");
    expect(decode("26.2").toString()).toBe("26.2.0");
    expect(decode("0.21.0-rc1").toString()).toBe("0.21.0-rc1");
  });

  it("rejects invalid versions", () => {
    expect(Option.isNone(Schema.decodeOption(Version.Schema)("invalid"))).toBe(
      true,
    );
    expect(Option.isNone(Schema.decodeOption(Version.Schema)(""))).toBe(true);
  });

  it("provides semantic equality and ordering", () => {
    const minimum = Version.make("0.12.0");
    const isAtLeast = Order.isGreaterThanOrEqualTo(Version.Order);
    expect(isAtLeast(decode("0.11.9"), minimum)).toBe(false);
    expect(isAtLeast(decode("0.12.0"), minimum)).toBe(true);
    expect(isAtLeast(decode("0.13.0"), minimum)).toBe(true);
    expect(Equal.equals(decode("26.2"), decode("26.2.0"))).toBe(true);
    expect(
      Order.isLessThan(Version.Order)(decode("1.0.0-rc1"), decode("1.0.0")),
    ).toBe(true);
  });

  it("round-trips through its Effect schema", () => {
    const version = decode("1.2.3+build.4");
    expect(Schema.encodeSync(Version.Schema)(version)).toBe("1.2.3+build.4");
  });
});
