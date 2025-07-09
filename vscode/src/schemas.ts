import * as z from "zod/v4";

const Header = z.object({
  value: z.string().nullable(),
});

const AppInstantiation = z.object({
  options: z.record(z.string(), z.unknown()),
});

const CellDef = z.object({
  code: z.string(),
  name: z.string().nullable().default("_"),
  options: z.record(z.string(), z.unknown()),
});

const Violation = z.object({
  description: z.string(),
  lineno: z.number().int().nullable().default(0),
  col_offset: z.number().int().nullable().default(0),
});

export type NotebookSerialization = z.infer<typeof NotebookSerialization>;

export const NotebookSerialization = z.object({
  app: AppInstantiation,
  header: Header.nullable(),
  version: z.string().nullable(),
  cells: z.array(CellDef),
  violations: z.array(Violation),
  valid: z.boolean(),
});
