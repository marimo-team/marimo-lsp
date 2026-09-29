// @ts-check
import { definePlugin, defineRule } from "@oxlint/plugins";

import pkg from "../package.json" with { type: "json" };

const marimoCommandIds = new Set(
  pkg.contributes.commands.map(({ command }) => command),
);

const vscodeTypeOnly = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Enforce type-only imports for vscode module",
    },
    fixable: "code",
    messages: {
      useTypeOnly:
        "Use type-only imports for vscode module. Change to: import type {{ suggestion }}",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        // Check if importing from "vscode"
        if (node.source.value !== "vscode") {
          return;
        }

        // Skip if already a type-only import
        if (node.importKind === "type") {
          return;
        }

        // Check for namespace imports: import * as vscode from "vscode"
        const namespaceSpecifier = node.specifiers.find(
          (s) => s.type === "ImportNamespaceSpecifier",
        );
        if (namespaceSpecifier) {
          context.report({
            node: namespaceSpecifier,
            messageId: "useTypeOnly",
            data: {
              suggestion: `* as ${namespaceSpecifier.local.name} from 'vscode'`,
            },
            fix(fixer) {
              const sourceCode = context.sourceCode;
              const importText = sourceCode.getText(node);
              return fixer.replaceText(
                node,
                importText.replace("import *", "import type *"),
              );
            },
          });
          return;
        }

        // Check for named imports: import { ... } from "vscode"
        const namedSpecifiers = node.specifiers.filter(
          (s) => s.type === "ImportSpecifier",
        );
        if (namedSpecifiers.length > 0) {
          // Check if all named specifiers are already type imports
          const hasNonTypeImports = namedSpecifiers.some(
            (s) => s.importKind !== "type",
          );
          if (hasNonTypeImports) {
            const names = namedSpecifiers.map((s) => s.local.name).join(", ");
            context.report({
              node: node,
              messageId: "useTypeOnly",
              data: {
                suggestion: `{ ${names} } from 'vscode'`,
              },
              fix(fixer) {
                const sourceCode = context.sourceCode;
                const importText = sourceCode.getText(node);
                return fixer.replaceText(
                  node,
                  importText.replace("import {", "import type {"),
                );
              },
            });
          }
          return;
        }

        // Check for default imports: import vscode from "vscode"
        const defaultSpecifier = node.specifiers.find(
          (s) => s.type === "ImportDefaultSpecifier",
        );
        if (defaultSpecifier) {
          context.report({
            node: defaultSpecifier,
            messageId: "useTypeOnly",
            data: {
              suggestion: `${defaultSpecifier.local.name} from 'vscode'`,
            },
            fix(fixer) {
              const sourceCode = context.sourceCode;
              const importText = sourceCode.getText(node);
              return fixer.replaceText(
                node,
                importText.replace(/^import\s+/, "import type "),
              );
            },
          });
        }
      },
    };
  },
});

const noAtImports = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow @/* imports",
    },
    messages: {
      noAtImports:
        "Do not use @/* imports. Use @marimo-team/frontend/unstable_internal/* instead, preferably with type-only imports. Use sparingly and with caution.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const source = node.source.value;

        // Check if the import path starts with @/ (but not @marimo-team/ or other scoped packages)
        if (source.startsWith("@/")) {
          context.report({
            node: node.source,
            messageId: "noAtImports",
          });
        }
      },
    };
  },
});

const noMarimoCommandIdLiterals = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require typed command tokens instead of contributed command wire IDs",
    },
    messages: {
      useToken:
        "Use the matching MarimoCommands token; raw contributed command IDs belong only in generated commands.",
    },
  },
  create(context) {
    if (
      context.filename
        .replaceAll("\\", "/")
        .endsWith("/src/commands/MarimoCommands.gen.ts")
    ) {
      return {};
    }
    return {
      Literal(node) {
        if (
          typeof node.value === "string" &&
          marimoCommandIds.has(node.value)
        ) {
          context.report({ node, messageId: "useToken" });
        }
      },
      TemplateLiteral(node) {
        const value = node.quasis[0]?.value.cooked;
        if (
          node.expressions.length === 0 &&
          typeof value === "string" &&
          marimoCommandIds.has(value)
        ) {
          context.report({ node, messageId: "useToken" });
        }
      },
    };
  },
});

const effectArchitecture = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect services and runtimes at their owning module",
    },
    messages: {
      identity: "Prefix production Context.Service identities with @marimo/.",
      layer: "Export layer from the module instead of a static class field.",
      runtime:
        "Create ManagedRuntime only at the application root (features/Main.ts) or in tests.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (
      !filename.includes("/src/") ||
      /\/(?:__tests__|__mocks__)\//.test(filename) ||
      filename.endsWith(".test.ts")
    ) {
      return {};
    }
    const imports = new Map();
    /**
     * Whether `node` names the Effect module `module`, either through a
     * named import or as a member of a namespace import.
     * @param {import("@oxlint/plugins").ESTree.Expression} node
     * @param {string} module
     */
    const isModule = (node, module) =>
      (node.type === "Identifier" && imports.get(node.name) === module) ||
      (node.type === "MemberExpression" &&
        !node.computed &&
        node.object.type === "Identifier" &&
        imports.get(node.object.name) === "*" &&
        node.property.type === "Identifier" &&
        node.property.name === module);
    /**
     * @param {import("@oxlint/plugins").ESTree.Expression} node
     * @param {string} module
     * @param {string} method
     */
    const isMember = (node, module, method) =>
      node.type === "MemberExpression" &&
      !node.computed &&
      isModule(node.object, module) &&
      node.property.type === "Identifier" &&
      node.property.name === method;
    return {
      ImportDeclaration(node) {
        if (node.source.value !== "effect") return;
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            imports.set(specifier.local.name, "*");
          } else if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.type === "Identifier"
          ) {
            imports.set(specifier.local.name, specifier.imported.name);
          }
        }
      },
      CallExpression(node) {
        if (
          isMember(node.callee, "ManagedRuntime", "make") &&
          !filename.endsWith("/src/features/Main.ts")
        ) {
          context.report({ node, messageId: "runtime" });
        }
        if (
          node.callee.type === "CallExpression" &&
          isMember(node.callee.callee, "Context", "Service")
        ) {
          const identity = node.arguments[0];
          if (
            identity?.type !== "Literal" ||
            typeof identity.value !== "string" ||
            !identity.value.startsWith("@marimo/")
          ) {
            context.report({ node, messageId: "identity" });
          }
        }
      },
      PropertyDefinition(node) {
        if (
          node.static &&
          node.key.type === "Identifier" &&
          node.key.name === "layer"
        ) {
          context.report({ node, messageId: "layer" });
        }
      },
    };
  },
});

export default definePlugin({
  meta: {
    name: "marimo",
  },
  rules: {
    "vscode-type-only": vscodeTypeOnly,
    "no-at-imports": noAtImports,
    "no-marimo-command-id-literals": noMarimoCommandIdLiterals,
    "effect-architecture": effectArchitecture,
  },
});
