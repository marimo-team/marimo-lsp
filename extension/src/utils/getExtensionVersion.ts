import { Effect, Option, Schema } from "effect";
import { VsCode } from "../services/VsCode.ts";
import { EXTENSION_PACKAGE } from "./extension.ts";

const PackageJsonSchema = Schema.Struct({ version: Schema.String });

export const getExtensionVersion = Effect.fn("getExtensionVersion")(
  function* () {
    const code = yield* VsCode;
    return code.extensions.getExtension(EXTENSION_PACKAGE.fullName).pipe(
      Option.flatMap((ext) =>
        Schema.decodeOption(PackageJsonSchema)(ext.packageJSON),
      ),
      Option.map((pkgJson) => pkgJson.version),
    );
  },
);
