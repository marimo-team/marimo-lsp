import type { Option } from "effect";

/** The interpreter and exact marimo version observed before kernel launch. */
export interface KernelEnvironment {
  readonly executable: string;
  readonly marimoVersion: Option.Option<string>;
}
