/// <reference types="vite/client" />

declare module "virtual:stylesheet" {
  const styles: string;
  export default styles;
}

/**
 * Required for type-checking marimo network types
 *
 * Import chain:
 *   ./marimo-frontend.ts
 *     └─> @marimo-team/frontend/unstable_internal/core/network/types.ts
 *          └─> @/utils/invariant
 *
 * This declaration satisfies the transitive dependency when
 * type-checking the network types import.
 */
declare module "@/utils/invariant" {
  export function invariant(
    condition: unknown,
    message: string,
  ): asserts condition;
}

/**
 * Required for type-checking marimo cell helpers
 *
 * Import chain:
 *   ./marimo-frontend.ts
 *     └─> @marimo-team/frontend/unstable_internal/core/cells/types.ts
 *          └─> @/utils/times
 */
declare module "@/utils/time" {
  export type Milliseconds = number & { __type__: "milliseconds" };
  export type Seconds = number & { __type__: "seconds" };
}
