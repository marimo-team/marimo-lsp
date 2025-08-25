// @ts-check
import * as process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import * as vite from "vite";
import stylesheet from "./scripts/vite-plugin-virtual-stylesheet.mjs";

export default vite.defineConfig({
  build: {
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
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
    "import.meta.env.MODE": JSON.stringify("test"),
  },
  experimental: {
    enableNativePlugin: true,
  },
});
