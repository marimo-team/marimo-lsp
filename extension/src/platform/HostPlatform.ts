import { type PositronApi, tryAcquirePositronApi } from "@posit-dev/positron";
import { Effect, Layer } from "effect";

import { VsCode } from "./VsCode.ts";
import { WebPreview } from "./WebPreview.ts";

const makePositronAdapter = (positron: PositronApi) =>
  Layer.mergeAll(
    Layer.effect(
      WebPreview,
      Effect.gen(function* () {
        const code = yield* VsCode;
        return WebPreview.make({
          open: Effect.fn("WebPreview.open")(function* (url: string) {
            const uri = yield* code.utils.parseUri(url);
            positron.window.previewUrl(uri);
          }),
        });
      }),
    ),
  );

/**
 * Selects host-specific implementations for extension capabilities.
 *
 * Keep product detection here so feature modules never branch on whether they
 * are running in VS Code, Positron, or another compatible editor.
 */
export const HostPlatform = {
  Live: Layer.suspend(() => {
    const positron = tryAcquirePositronApi();
    return positron ? makePositronAdapter(positron) : WebPreview.Default;
  }),
};
