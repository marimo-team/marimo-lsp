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
        "src/renderer/**",
      ],
    },
  },
  fmt: {
    printWidth: 80,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
