/**
 * Test-only helpers for constructing branded ID types from plain strings.
 *
 * In production code, branded types flow from the API (via codegen) or
 * from designated creation points (e.g. CellId.create()).
 */
import type { components as Api } from "@marimo-team/openapi/src/api";

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
