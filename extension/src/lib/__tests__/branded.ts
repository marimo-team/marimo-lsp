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
 * See CLAUDE.md § "Prefer Schema or type guards over type assertions" — the
 * testing paragraph explicitly allows test-scoped brand helpers.
 */
/* oxlint-disable typescript/no-unsafe-type-assertion */
import type { components as Api } from "@marimo-team/openapi/src/api";

import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
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

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Construct a MarimoConfig fixture from a deep-partial object. Tests rarely
 * need every field; this helper avoids spelling out the full shape at every
 * call site, including on nested sub-configs like `runtime`.
 */
export const marimoConfigFixture = (
  partial: DeepPartial<MarimoConfig>,
): MarimoConfig => partial as MarimoConfig;

/**
 * Unsafely cast a deliberately-invalid value so it typechecks as `T`. Use
 * only when the test's job is to feed malformed data into a function that
 * should defensively handle it. The SCREAMING_CASE name is intentional —
 * call sites should be loud enough to notice in review.
 */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters
export const UNSAFE_castForNegativeTest = <T>(value: unknown): T => value as T;
