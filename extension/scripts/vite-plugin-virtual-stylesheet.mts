import type { Plugin } from "vite";

/**
 * Inlines the compiled stylesheet as a string via virtual module.
 * Import with: `import styles from 'virtual:stylesheet'`
 */
export default function (): Plugin {
  const needle = "__INLINE_STYLES_PLACEHOLDER__";
  return {
    name: "virtual-stylesheet",
    apply: "build",
    enforce: "post",
    resolveId(id) {
      if (id === "virtual:stylesheet") {
        return "\0virtual:stylesheet";
      }
    },
    load(id) {
      if (id === "\0virtual:stylesheet") {
        return `export default ${needle};`;
      }
    },
    async generateBundle(_, bundle) {
      const assets = Object.values(bundle).filter((e) => e.type === "asset");
      const stylesheets = assets.filter((a) => a.fileName.endsWith(".css"));
      assert(stylesheets.length === 1, "Expected one output stylesheet.");

      const asset = stylesheets[0];
      assert(typeof asset.source === "string", "Expected string stylesheet.");

      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.code.includes(needle)) {
          continue;
        }
        chunk.code = chunk.code.replace(needle, JSON.stringify(asset.source));
      }

      delete bundle[asset.fileName];
    },
  };
}

function assert(expression: unknown, msg = ""): asserts expression {
  if (!expression) throw new Error(msg);
}
