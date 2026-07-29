import { Effect } from "effect";

import type {
  MarimoApiMethod,
  MarimoApiParams,
  MarimoApiRequest,
} from "../types.ts";
import { LanguageClient } from "./LanguageClient.ts";

/**
 * Typed access to the `marimo.api` LSP command.
 *
 * This service only maps API methods to the LSP command envelope. Runtime
 * ordering, lifecycle, and operation streams belong to RuntimeSession.
 */
export class MarimoApiClient extends Effect.Service<MarimoApiClient>()(
  "MarimoApiClient",
  {
    effect: Effect.gen(function* () {
      const client = yield* LanguageClient;

      const execute = <K extends MarimoApiMethod>(
        request: MarimoApiRequest<K>,
      ) =>
        client.executeCommand({
          command: "marimo.api",
          params: request,
        });

      return {
        execute,
        serialize: (params: MarimoApiParams<"serialize">) =>
          execute({ method: "serialize", params }),
        deserialize: (params: MarimoApiParams<"deserialize">) =>
          execute({ method: "deserialize", params }),
        getConfiguration: (params: MarimoApiParams<"get-configuration">) =>
          execute({ method: "get-configuration", params }),
        updateConfiguration: (
          params: MarimoApiParams<"update-configuration">,
        ) => execute({ method: "update-configuration", params }),
        getDependencyTree: (params: MarimoApiParams<"get-dependency-tree">) =>
          execute({ method: "get-dependency-tree", params }),
        getPackageList: (params: MarimoApiParams<"get-package-list">) =>
          execute({ method: "get-package-list", params }),
        exportAsHtml: (params: MarimoApiParams<"export-as-html">) =>
          execute({ method: "export-as-html", params }),
        exportAsIpynb: (params: MarimoApiParams<"export-as-ipynb">) =>
          execute({ method: "export-as-ipynb", params }),
        setDisplayTheme: (params: MarimoApiParams<"set-display-theme">) =>
          execute({ method: "set-display-theme", params }),
      };
    }),
  },
) {}
