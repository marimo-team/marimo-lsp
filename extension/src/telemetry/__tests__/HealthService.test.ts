import { expect, it } from "@effect/vitest";
import { Option } from "effect";

import { MarimoLspServer } from "../../config/Config.ts";
import { UvBin } from "../../python/Uv.ts";
import { formatMarimoLspDiagnostics } from "../HealthService.ts";

it("reports the bundled WASM runtime without uv diagnostics", () => {
  expect(
    formatMarimoLspDiagnostics({
      server: MarimoLspServer.Wasm(),
      uvBin: Option.none(),
    }),
  ).toEqual(["\tMode: WASM (bundled Pyodide)"]);
});

it("reports the uv-provisioned native runtime", () => {
  expect(
    formatMarimoLspDiagnostics({
      server: MarimoLspServer.Python(),
      uvBin: Option.some(
        UvBin.Bundled({
          executable: "/extension/bundled/uv",
          version: Option.none(),
        }),
      ),
    }),
  ).toEqual([
    "\tMode: Native (uv)",
    "\tUV Bin: Bundled (/extension/bundled/uv)",
    "\tUV: Version unknown",
    "\tUsing bundled marimo-lsp via uvx",
  ]);
});

it("reports the configured native runtime", () => {
  expect(
    formatMarimoLspDiagnostics({
      server: MarimoLspServer.Custom({
        command: ["/opt/marimo-lsp", "--stdio"],
      }),
      uvBin: Option.none(),
    }),
  ).toEqual([
    "\tMode: Native (configured)",
    "\tCustom path: /opt/marimo-lsp --stdio",
  ]);
});
