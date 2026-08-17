import { expect, it } from "@effect/vitest";
import { ChildProcess } from "effect/unstable/process";

import { LanguageServerInstallError, UvUnknownError } from "../Uv.ts";

it("includes uv stderr in language-server installation diagnostics", () => {
  const error = new LanguageServerInstallError({
    server: { name: "ty", version: "0.0.63" },
    targetPath: "/managed/libs",
    attempts: [
      {
        strategy: "default",
        error: new UvUnknownError({
          command: ChildProcess.make("uv", ["pip", "install", "ty"]),
          stderr: "certificate validation failed for the configured proxy",
        }),
      },
    ],
  });

  expect(error.format()).toBe(
    [
      "Failed to install ty@0.0.63",
      "Target: /managed/libs",
      "  [default] exit code unknown: certificate validation failed for the configured proxy",
    ].join("\n"),
  );
  expect(error.message).toBe(error.format());
});
