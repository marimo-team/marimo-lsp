/**
 * @module
 *
 * Runtime imports from @marimo-team/frontend
 *
 * Since @marimo-team/frontend doesn't emit .d.ts files, TypeScript attempts to
 * compile the entire frontend source when these modules are imported. There's no
 * way to skipLibCheck for specific packages, which would require our TypeScript
 * config to match marimo's exactly and type-check the entire frontend codebase.
 *
 * As a workaround is to use a JS file to resolve runtime imports. This should be used sparingly.
 * We keep the exports of this module minimal to maintain a clear, type-safe boundary.
 */

export { OutputRenderer } from "@marimo-team/frontend/unstable_internal/components/editor/Output.tsx";
export { ConsoleOutput } from "@marimo-team/frontend/unstable_internal/components/editor/output/ConsoleOutput.tsx";
export { TooltipProvider } from "@marimo-team/frontend/unstable_internal/components/ui/tooltip.tsx";
export { UI_ELEMENT_REGISTRY } from "@marimo-team/frontend/unstable_internal/core/dom/uiregistry.ts";
export { RuntimeState } from "@marimo-team/frontend/unstable_internal/core/kernel/RuntimeState.ts";
export { initializePlugins } from "@marimo-team/frontend/unstable_internal/plugins/plugins.ts";
