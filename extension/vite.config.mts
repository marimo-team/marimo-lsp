import * as process from "node:process";

import tailwindcss from "@tailwindcss/vite";
import * as vite from "vite-plus";

import stylesheet from "./scripts/vite-plugin-virtual-stylesheet.mts";

export default vite.defineConfig({
  build: {
    // Shipped in: Electron 37.7, VSCode 1.106
    target: "chrome138",
    minify: process.env.NODE_ENV === "production",
    sourcemap: process.env.NODE_ENV === "development" ? "inline" : false,
    lib: {
      entry: { renderer: "./src/renderer/renderer.tsx" },
      formats: ["es"],
    },
  },
  plugins: [tailwindcss(), stylesheet()],
  resolve: {
    dedupe: ["react", "react-dom"],
    tsconfigPaths: true,
    alias: {
      "@/": "@marimo-team/frontend/unstable_internal/",
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
    "import.meta.env.MODE": JSON.stringify("test"),
  },
  test: {
    globals: true,
    environment: "node",
    watch: false,
    // Unit tests live in src/
    include: ["src/**/*.test.ts"],
    // Extension tests live in tests/extension/
    exclude: ["tests/extension/**/*.test.ts"],
    setupFiles: ["./src/__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      include: ["src/**/*.{ts,tsx,mts}"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.d.ts",
        "src/__tests__/**",
        "src/__mocks__/**",
        "src/renderer/**",
        // Boundary wrapper around the `vscode` module; unit tests use the
        // TestVsCode stand-in (src/__tests__/TestVsCode.ts) instead.
        "src/platform/VsCode.ts",
      ],
    },
  },
  fmt: {
    ignorePatterns: ["**/coverage/**"],
    printWidth: 80,
    experimentalSortImports: {},
  },
  lint: {
    ignorePatterns: ["**/coverage/**"],
    categories: {
      correctness: "error",
      suspicious: "error",
      pedantic: "off",
      perf: "warn",
      style: "off",
      restriction: "off",
    },
    jsPlugins: ["./lint/marimo-plugin.mjs"],
    plugins: ["typescript", "react", "import"],
    rules: {
      "react/react-in-jsx-scope": "off",
      "import/extensions": ["error", "always", { ignorePackages: true }],
      "import/no-unassigned-import": [
        "error",
        { allow: ["**/*.css", "**/*.scss"] },
      ],
      "typescript/non-nullable-type-assertion-style": "error",
      "marimo/vscode-type-only": "error",
      "marimo/no-at-imports": "error",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/no-misused-spread": "off",
      "typescript/no-shadow": "off",
      // TODO: re-enable these. They started firing after inlining the oxlint
      // config into vite.config.mts (previously lived in root .oxlintrc.json).
      // Most violations are legit (missing returns in Effect.fn generators,
      // redundant Boolean/String casts) but fixing them is a separate pass.
      "typescript/consistent-return": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
