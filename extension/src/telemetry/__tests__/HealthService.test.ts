import * as Vitest from "@effect/vitest";
import { Option } from "effect";

import { MarimoLspServer } from "../../config/Config.ts";
import * as Uv from "../../python/Uv.ts";
import * as HealthService from "../HealthService.ts";

Vitest.it("reports the bundled WASM runtime without uv diagnostics", () => {
  Vitest.expect(
    HealthService.formatMarimoLspDiagnostics({
      server: MarimoLspServer.Wasm(),
      uvBin: Option.none(),
    }),
  ).toEqual(["\tMode: WASM (bundled Pyodide)"]);
});

Vitest.it("reports the uv-provisioned native runtime", () => {
  Vitest.expect(
    HealthService.formatMarimoLspDiagnostics({
      server: MarimoLspServer.Python(),
      uvBin: Option.some(
        Uv.UvBin.Bundled({
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

Vitest.it("reports the configured native runtime", () => {
  Vitest.expect(
    HealthService.formatMarimoLspDiagnostics({
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
