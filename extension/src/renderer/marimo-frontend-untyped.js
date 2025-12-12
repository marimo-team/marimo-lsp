/**
 * @module
 *
 * Untyped runtime imports from @marimo-team/frontend
 *
 * WHY THIS FILE EXISTS:
 *
 * @marimo-team/frontend doesn't emit .d.ts files, so TypeScript attempts to compile
 * and type-check the entire frontend source when modules are imported. There's no way
 * to skipLibCheck for specific packages - it's an all-or-nothing setting. To properly
 * type-check marimo's frontend, we'd need to replicate their entire TypeScript config
 * (including custom paths, compiler options, etc.), which would effectively mean
 * maintaining and type-checking marimo's entire frontend codebase as part of this project.
 *
 * THE SOLUTION:
 *
 * This JavaScript file (not TypeScript) handles the raw runtime imports from marimo's
 * frontend. JavaScript files bypass TypeScript's type-checking entirely, allowing Vite
 * to resolve and bundle these modules at runtime without triggering type errors.
 *
 * The strongly-typed companion file (marimo-frontend.ts) then imports from this file
 * using `@ts-expect-error` and re-exports with proper TypeScript types. This creates
 * a type-safe boundary: we get full type safety in our code while avoiding the need
 * to type-check marimo's internals.
 *
 * ADDING NEW IMPORTS:
 *
 * When you need to import something from @marimo-team/frontend:
 *
 * 1. First try importing it directly in marimo-frontend.ts
 * 2. Run `npm run typecheck` to see if it causes type errors
 * 3. If it builds successfully, great! Keep the import there.
 * 4. If it fails type-checking, add a single export here and type it in marimo-frontend.ts
 *
 * This is a pragmatic workaround that keeps our build fast and maintainable while
 * preserving type safety where it matters. The exports are kept minimal to maintain
 * a clear boundary between typed and untyped code.
 */

export { OutputRenderer } from "@marimo-team/frontend/unstable_internal/components/editor/Output.tsx";
export { ConsoleOutput } from "@marimo-team/frontend/unstable_internal/components/editor/output/console/ConsoleOutput.tsx";
export { TooltipProvider } from "@marimo-team/frontend/unstable_internal/components/ui/tooltip.tsx";
export { UI_ELEMENT_REGISTRY } from "@marimo-team/frontend/unstable_internal/core/dom/uiregistry.ts";
export { RuntimeState } from "@marimo-team/frontend/unstable_internal/core/kernel/RuntimeState.ts";
export { initializePlugins } from "@marimo-team/frontend/unstable_internal/plugins/plugins.ts";
