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
