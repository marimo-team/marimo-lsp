// SAFETY: test-only helper that presents a `Partial<T>` as `T`; any access to
// an unimplemented property throws at runtime via the Proxy `get` trap.
// Acceptable test scaffolding per the CLAUDE.md testing guidance.
/* oxlint-disable typescript/no-unsafe-type-assertion */
export function partialService<T>(service: Partial<T>): T {
  return new Proxy(service, {
    get(target, prop) {
      if (prop in target) {
        return target[prop as keyof T];
      }
      throw new Error(`Property ${String(prop)} has not been implemented`);
    },
  }) as T;
}
/* oxlint-enable typescript/no-unsafe-type-assertion */
