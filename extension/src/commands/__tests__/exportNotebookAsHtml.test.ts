import { describe, expect, it } from "@effect/vitest";

import { parseRenderedOutput } from "../exportNotebookAsHtml.ts";

describe("parseRenderedOutput", () => {
  it("uses the primary rendered output when present", () => {
    const result = parseRenderedOutput(
      JSON.stringify({
        state: {
          output: {
            mimetype: "text/html",
            data: "<div>Hello</div>",
          },
          consoleOutputs: [
            {
              mimetype: "text/plain",
              data: "fallback",
            },
          ],
        },
      }),
    );

    expect(result).toEqual(["text/html", "<div>Hello</div>"]);
  });

  it("falls back to rendered console output when primary output is empty", () => {
    const result = parseRenderedOutput(
      JSON.stringify({
        state: {
          output: null,
          consoleOutputs: [
            {
              mimetype: "image/png",
              data: "base64encodedimage",
            },
          ],
        },
      }),
    );

    expect(result).toEqual(["image/png", "base64encodedimage"]);
  });
});
