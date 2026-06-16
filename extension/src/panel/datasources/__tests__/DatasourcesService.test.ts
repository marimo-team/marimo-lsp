import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { notebookId, requestId } from "../../../lib/__tests__/branded.ts";
import type {
  CatalogChildrenPreviewNotification,
  CatalogNode,
  DataSourceConnectionsNotification,
  DataTableNode,
  NamespaceNode,
  SchemaNode,
} from "../../../types.ts";
import {
  type CatalogTreeNode,
  DatasourcesService,
} from "../DatasourcesService.ts";

const withTestCtx = () =>
  Effect.sync(() => {
    const layer = Layer.empty.pipe(
      Layer.provideMerge(DatasourcesService.Default),
    );
    return { layer };
  });

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

// Mock factories for the recursive `Database.children` catalog model.
// `variable_name`/`engine` are left null and `columns` empty so the wire shape
// typechecks without minting branded values.
function dataTable(
  name: string,
  opts: { numRows?: number | null; numColumns?: number | null } = {},
): DataTableNode {
  return {
    kind: "data_table",
    name,
    source: "test",
    source_type: "connection",
    num_rows: opts.numRows ?? null,
    num_columns: opts.numColumns ?? null,
    variable_name: null,
    columns: [],
    type: "table",
  };
}

function schema(name: string, tables: DataTableNode[] | null): SchemaNode {
  return { kind: "schema", name, tables };
}

function namespace(
  name: string,
  children: CatalogNode[] | null,
): NamespaceNode {
  return { kind: "namespace", name, children };
}

// A single connection ("conn1") with a single database ("db1") whose catalog
// tree is `children`.
function connectionsOp(
  children: CatalogNode[] | null,
): DataSourceConnectionsNotification {
  return {
    op: "data-source-connections",
    connections: [
      {
        name: "conn1",
        source: "postgres",
        dialect: "postgres",
        display_name: "Conn 1",
        default_database: null,
        default_schema: null,
        databases: [
          { name: "db1", dialect: "postgres", children, engine: null },
        ],
      },
    ],
  };
}

function catalogChildrenOp(opts: {
  request: string;
  children?: CatalogNode[];
  error?: string | null;
}): CatalogChildrenPreviewNotification {
  return {
    op: "catalog-children-preview",
    request_id: requestId(opts.request),
    metadata: { connection: "conn1", database: "db1", catalog_path: [] },
    children: opts.children,
    error: opts.error ?? null,
  };
}

/** Project a catalog tree to `{ kind, name, children }` for readable snapshots. */
function summarize(
  nodes: readonly CatalogTreeNode[],
): Array<{ kind: string; name: string; children: unknown }> {
  return nodes.map((n) => ({
    kind: n.kind,
    name: n.name,
    children: summarize(n.children),
  }));
}

/** Resolve the catalog tree of conn1/db1 from a connections snapshot. */
function db1Children(
  map: Option.Option<{
    connections: Map<
      string,
      { databases: Map<string, { children: CatalogTreeNode[] }> }
    >;
  }>,
): CatalogTreeNode[] {
  assert(Option.isSome(map), "Expected connections");
  const db = map.value.connections.get("conn1")?.databases.get("db1");
  assert(db !== undefined, "Expected conn1/db1");
  return db.children;
}

it.effect(
  "normalizes a nested catalog tree (schema, namespace, root table)",
  Effect.fn(function* () {
    const { layer } = yield* withTestCtx();

    const children = yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(
        NOTEBOOK_URI,
        connectionsOp([
          schema("public", [dataTable("users"), dataTable("orders")]),
          namespace("iceberg_ns", [
            schema("nested", [dataTable("t1")]),
            // deferred namespace: children not yet discovered
            namespace("deep", null),
          ]),
          // root-level table directly under the database
          dataTable("root_tbl"),
          // deferred schema: tables not yet discovered
          schema("lazy", null),
        ]),
      );
      return db1Children(yield* service.getConnections(NOTEBOOK_URI));
    }).pipe(Effect.provide(layer));

    expect(summarize(children)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "children": [
    	      {
    	        "children": [],
    	        "kind": "data_table",
    	        "name": "users",
    	      },
    	      {
    	        "children": [],
    	        "kind": "data_table",
    	        "name": "orders",
    	      },
    	    ],
    	    "kind": "schema",
    	    "name": "public",
    	  },
    	  {
    	    "children": [
    	      {
    	        "children": [
    	          {
    	            "children": [],
    	            "kind": "data_table",
    	            "name": "t1",
    	          },
    	        ],
    	        "kind": "schema",
    	        "name": "nested",
    	      },
    	      {
    	        "children": [],
    	        "kind": "namespace",
    	        "name": "deep",
    	      },
    	    ],
    	    "kind": "namespace",
    	    "name": "iceberg_ns",
    	  },
    	  {
    	    "children": [],
    	    "kind": "data_table",
    	    "name": "root_tbl",
    	  },
    	  {
    	    "children": [],
    	    "kind": "schema",
    	    "name": "lazy",
    	  },
    	]
    `);
  }),
);

it.effect(
  "flattens a deferred top-level catalog (children === null) to []",
  Effect.fn(function* () {
    const { layer } = yield* withTestCtx();

    const children = yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(NOTEBOOK_URI, connectionsOp(null));
      return db1Children(yield* service.getConnections(NOTEBOOK_URI));
    }).pipe(Effect.provide(layer));

    expect(children).toEqual([]);
  }),
);

it.effect(
  "preserves table metadata on data_table leaves",
  Effect.fn(function* () {
    const { layer } = yield* withTestCtx();

    const children = yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(
        NOTEBOOK_URI,
        connectionsOp([
          schema("public", [
            dataTable("users", { numRows: 42, numColumns: 3 }),
          ]),
        ]),
      );
      return db1Children(yield* service.getConnections(NOTEBOOK_URI));
    }).pipe(Effect.provide(layer));

    const table = children[0]?.children[0];
    expect(table?.kind).toBe("data_table");
    expect(table?.table?.num_rows).toBe(42);
    expect(table?.table?.num_columns).toBe(3);
  }),
);

it.effect(
  "stores catalog children previews and ignores error responses",
  Effect.fn(function* () {
    const { layer } = yield* withTestCtx();

    const result = yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;

      // Successful preview is stored.
      yield* service.updateCatalogChildrenPreview(
        NOTEBOOK_URI,
        catalogChildrenOp({
          request: "req-ok",
          children: [schema("public", [dataTable("users")])],
        }),
      );

      // An errored preview for a *new* request stores nothing.
      yield* service.updateCatalogChildrenPreview(
        NOTEBOOK_URI,
        catalogChildrenOp({ request: "req-err", error: "boom" }),
      );

      // An errored preview must not erase a previously cached success.
      yield* service.updateCatalogChildrenPreview(
        NOTEBOOK_URI,
        catalogChildrenOp({ request: "req-ok", error: "transient" }),
      );

      return {
        ok: yield* service.getCatalogChildrenPreview(NOTEBOOK_URI, "req-ok"),
        err: yield* service.getCatalogChildrenPreview(NOTEBOOK_URI, "req-err"),
      };
    }).pipe(Effect.provide(layer));

    expect(summarize(result.ok)).toMatchInlineSnapshot(`
    	[
    	  {
    	    "children": [
    	      {
    	        "children": [],
    	        "kind": "data_table",
    	        "name": "users",
    	      },
    	    ],
    	    "kind": "schema",
    	    "name": "public",
    	  },
    	]
    `);
    expect(result.err).toEqual([]);
  }),
);

it.effect(
  "clears all catalog state for a notebook",
  Effect.fn(function* () {
    const { layer } = yield* withTestCtx();

    const after = yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(
        NOTEBOOK_URI,
        connectionsOp([schema("public", [dataTable("users")])]),
      );
      yield* service.updateCatalogChildrenPreview(
        NOTEBOOK_URI,
        catalogChildrenOp({
          request: "req-ok",
          children: [dataTable("root_tbl")],
        }),
      );

      yield* service.clearNotebook(NOTEBOOK_URI);

      return {
        connections: yield* service.getConnections(NOTEBOOK_URI),
        preview: yield* service.getCatalogChildrenPreview(
          NOTEBOOK_URI,
          "req-ok",
        ),
      };
    }).pipe(Effect.provide(layer));

    expect(Option.isNone(after.connections)).toBe(true);
    expect(after.preview).toEqual([]);
  }),
);
