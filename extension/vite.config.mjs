/// <reference types="vitest" />
// @ts-check

import tailwindcss from "@tailwindcss/vite";
import * as process from "node:process";
import * as vite from "vite";

import stylesheet from "./scripts/vite-plugin-virtual-stylesheet.mjs";

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
  experimental: {
    enableNativePlugin: true,
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
  },
});
