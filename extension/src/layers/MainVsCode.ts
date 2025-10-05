import { Layer } from "effect";
import { LanguageClient } from "../services/LanguageClient.ts";
import { PythonExtension } from "../services/PythonExtension.ts";
import { VsCode } from "../services/VsCode.ts";
import { MainLive } from "./Main.ts";

export const MainLiveVsCode = MainLive.pipe(
  Layer.provide(PythonExtension.Default),
  Layer.provide(VsCode.Default),
  Layer.provide(LanguageClient.Default),
);
