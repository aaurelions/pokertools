import { defineConfig } from "tsup";

export default defineConfig([
  // Main entry
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    // Do not clean here: both configs build in parallel and tsup's clean also
    // deletes declaration files under dist/react while that entry is emitting
    // them. The build script removes dist once before tsup starts.
    clean: false,
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
