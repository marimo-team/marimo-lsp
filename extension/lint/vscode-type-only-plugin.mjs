/**
 * Oxlint plugin: Enforce type-only imports for vscode module
 * Replaces: vscode-type-only.grit
 */

const rule = {
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
};

const plugin = {
  meta: {
    name: "marimo-vscode",
  },
  rules: {
    "vscode-type-only": rule,
  },
};

export default plugin;
