"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyTreeResponse = exports.ListPackagesResponse = exports.DependencyTreeNode = exports.PackageDescription = void 0;
const effect_1 = require("effect");
/**
 * Schema for a package description containing name and version
 */
exports.PackageDescription = effect_1.Schema.Struct({
    name: effect_1.Schema.String,
    version: effect_1.Schema.String,
});
exports.DependencyTreeNode = effect_1.Schema.Struct({
    name: effect_1.Schema.String,
    version: effect_1.Schema.NullOr(effect_1.Schema.String),
    tags: effect_1.Schema.Array(effect_1.Schema.Record({ key: effect_1.Schema.String, value: effect_1.Schema.String })),
    dependencies: effect_1.Schema.Array(effect_1.Schema.suspend(() => exports.DependencyTreeNode)),
});
/**
 * Response schema for listing installed packages
 */
exports.ListPackagesResponse = effect_1.Schema.Struct({
    packages: effect_1.Schema.Array(exports.PackageDescription),
});
/**
 * Response schema for dependency tree
 */
exports.DependencyTreeResponse = effect_1.Schema.Struct({
    tree: exports.DependencyTreeNode,
});
