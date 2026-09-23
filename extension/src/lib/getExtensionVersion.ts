import { Effect, Option, Schema } from "effect";

import * as VsCode from "../platform/VsCode.ts";
import { EXTENSION_PACKAGE } from "./extension.ts";

const PackageJsonSchema = Schema.Struct({ version: Schema.String });

export const getExtensionVersion = Effect.fn("getExtensionVersion")(
  function* () {
    const code = yield* VsCode.Service;
    return code.extensions.getExtension(EXTENSION_PACKAGE.fullName).pipe(
      Option.map((ext) => ext.packageJSON),
      Option.flatMap(Schema.decodeOption(PackageJsonSchema)),
      Option.map((pkg) => pkg.version),
    );
  },
);
