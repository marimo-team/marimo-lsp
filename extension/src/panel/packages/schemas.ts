import { Schema } from "effect";

/**
 * Schema for a package description containing name and version
 */
export const PackageDescription = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
});

/**
 * Schema for a dependency tree node with recursive dependencies
 *
 * Note: Using interface + const pattern instead of Schema.Class to avoid
 * circular reference issues with TypeScript
 */
export interface DependencyTreeNode {
  readonly name: string;
  readonly version: string | null;
  readonly tags: readonly Record<string, string>[];
  readonly dependencies: readonly DependencyTreeNode[];
}

export const DependencyTreeNode: Schema.Schema<DependencyTreeNode> =
  Schema.Struct({
    name: Schema.String,
    version: Schema.NullOr(Schema.String),
    tags: Schema.Array(
      Schema.Record({ key: Schema.String, value: Schema.String }),
    ),
    dependencies: Schema.Array(Schema.suspend(() => DependencyTreeNode)),
  });

/**
 * Response schema for listing installed packages
 */
export const ListPackagesResponse = Schema.Struct({
  packages: Schema.Array(PackageDescription),
});

/**
 * Response schema for dependency tree
 */
export const DependencyTreeResponse = Schema.Struct({
  tree: DependencyTreeNode,
});
