import { defineConfig } from "tsup";

export default defineConfig([
  // Main entry
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    splitting: false,
    minify: false,
    external: ["react", "@pokertools/types"],
  },
  // React entry (optional)
  {
    entry: ["src/react/index.tsx"],
    outDir: "dist/react",
    format: ["cjs", "esm"],
    dts: true,
    sourcemap: true,
    treeshake: true,
    splitting: false,
    minify: false,
    external: ["react", "@pokertools/types"],
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
  },
]);

