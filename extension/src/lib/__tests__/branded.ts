/**
 * Test-only helpers for constructing branded ID types and typed fixtures
 * from plain literals.
 *
 * In production code, branded types flow from the API (via codegen) or from
 * designated creation points (e.g. CellId.create()). Tests need a way to
 * construct these without routing through the real pipeline — that's what
 * this file is for.
 *
 * SAFETY: every helper here is a brand smart constructor that performs no
 * runtime check; the whole file is the authorized escape hatch for tests.
 */
/* oxlint-disable typescript/no-unsafe-type-assertion */
import type { components as Api } from "@marimo-team/openapi/src/api";
import { Schema } from "effect";

import type { RunId } from "../../kernel/CellRunReducer.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import {
  KernelSessionIdFromString,
  MarimoConfig as MarimoConfigSchema,
} from "../../schemas/Models.gen.ts";
import type { MarimoConfig } from "../../types.ts";

type Schemas = Api["schemas"];

type CellId = Schemas["CellId"];
type UIElementId = Schemas["UIElementId"];
type RequestId = Schemas["RequestId"];
type VariableName = Schemas["VariableName"];
type WidgetModelId = Schemas["WidgetModelId"];
type Base64String = Schemas["Base64String"];

export const cellId = (s: string) => s as CellId;
export const variableName = (s: string) => s as VariableName;
export const requestId = (s: string) => s as RequestId;
export const uiElementId = (s: string) => s as UIElementId;
export const widgetModelId = (s: string) => s as WidgetModelId;
export const base64String = (s: string) => s as Base64String;
export const notebookId = (s: string) => s as NotebookId;
export const runId = (s: string) => s as RunId;
export const kernelSessionId = Schema.decodeUnknownSync(
  KernelSessionIdFromString,
);

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * marimo's `DEFAULT_CONFIG`, dumped via `msgspec.to_builtins`. Fixtures merge
 * partial overrides onto this base so they satisfy the generated
 * `MarimoConfig` schema, which the client now parses responses against.
 */
const DEFAULT_MARIMO_CONFIG = {
  completion: {
    activate_on_typing: true,
    signature_hint_on_typing: false,
    copilot: false,
    auto_close_pairs: true,
  },
  display: {
    theme: "light",
    code_editor_font_size: 14,
    cell_output: "below",
    default_width: "medium",
    dataframes: "rich",
    default_table_page_size: 10,
    default_table_max_columns: 50,
    reference_highlighting: true,
  },
  formatting: { line_length: 79 },
  keymap: { preset: "default", overrides: {} },
  runtime: {
    auto_instantiate: false,
    auto_reload: "off",
    reactive_tests: true,
    on_cell_change: "autorun",
    watcher_on_save: "lazy",
    output_max_bytes: 8_000_000,
    std_stream_max_bytes: 1_000_000,
    default_sql_output: "auto",
    default_csv_encoding: "utf-8",
    show_tracebacks: false,
  },
  save: {
    autosave: "after_delay",
    autosave_delay: 1000,
    format_on_save: false,
  },
  package_management: { manager: "uv" },
  server: { browser: "default", follow_symlink: false },
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Merge a partial config onto a base, section by section, the way marimo's
 * config manager merges `PartialMarimoConfig` on `save_config`. Validates the
 * result against the generated `MarimoConfig` schema so an invalid config
 * fails loudly at the call site instead of downstream in a response decode.
 */
export const mergeMarimoConfig = (
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): MarimoConfig => {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const section = merged[key];
    merged[key] =
      isRecord(section) && isRecord(value) ? { ...section, ...value } : value;
  }
  Schema.decodeUnknownSync(MarimoConfigSchema)(merged);
  // SAFETY: validated against the generated MarimoConfig schema above; the
  // openapi MarimoConfig type derives from the same msgspec source.
  return merged as MarimoConfig;
};

/**
 * Construct a MarimoConfig fixture from a deep-partial object. Tests rarely
 * need every field; this helper merges the overrides onto marimo's defaults
 * (validated, so a fixture the real client would reject fails at test setup).
 */
export const marimoConfigFixture = (
  partial: DeepPartial<MarimoConfig>,
): MarimoConfig => mergeMarimoConfig(DEFAULT_MARIMO_CONFIG, partial);

/**
 * Unsafely cast a deliberately-invalid value so it typechecks as `T`. Use
 * only when the test's job is to feed malformed data into a function that
 * should defensively handle it. The SCREAMING_CASE name is intentional —
 * call sites should be loud enough to notice in review.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export const UNSAFE_castForNegativeTest = <T>(value: unknown): T => value as T;
