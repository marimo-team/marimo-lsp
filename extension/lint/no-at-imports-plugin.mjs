/**
 * Oxlint plugin: Disallow @/* imports
 * Replaces: no-at-imports.grit
 */

const rule = {
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
        if (typeof source === "string" && /^@\//.test(source)) {
          context.report({
            node: node.source,
            messageId: "noAtImports",
          });
        }
      },
    };
  },
};

const plugin = {
  meta: {
    name: "marimo-imports",
  },
  rules: {
    "no-at-imports": rule,
  },
};

export default plugin;
