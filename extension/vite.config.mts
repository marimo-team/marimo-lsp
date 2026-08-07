import * as process from "node:process";

import tailwindcss from "@tailwindcss/vite";
import * as vite from "vite-plus";

import stylesheet from "./scripts/vite-plugin-virtual-stylesheet.mts";

export default vite.defineConfig({
  build: {
    // The extension bundle shares dist/ and is built independently by Turbo.
    // Output cleanup happens once in scripts/run-turbo.mjs before cache restore.
    emptyOutDir: false,
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
    dedupe: ["react", "react-dom", "jotai"],
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
    plugins: [
      "typescript",
      "react",
      "import",
      // @ts-expect-error -- Vite+ 0.2.7 predates Effect's patched plugin.
      "effecttsgo",
    ],
    rules: {
      "eslint/no-underscore-dangle": "off",
      "react/react-in-jsx-scope": "off",
      "import/extensions": ["error", "always", { ignorePackages: true }],
      "import/no-unassigned-import": [
        "error",
        { allow: ["**/*.css", "**/*.scss"] },
      ],
      "marimo/vscode-type-only": "error",
      "marimo/no-at-imports": "error",
      "marimo/no-marimo-command-id-literals": "error",
      "typescript/no-non-null-assertion": "error",
      "typescript/no-misused-spread": "off",
      "typescript/no-shadow": "off",
    },
    overrides: [
      {
        files: ["src/**/__tests__/**/*.ts", "src/**/*.test.ts"],
        rules: {
          // Effect.provide is the application boundary for independently
          // constructed test layers that cannot be shared through it.layer.
          "effecttsgo/strict-effect-provide": "off",
        },
      },
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
