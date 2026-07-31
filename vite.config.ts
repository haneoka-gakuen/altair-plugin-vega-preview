import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const externalImports = new Set([
  "@haneoka/altair/model",
  "@haneoka/altair/plugins",
  "@haneoka/altair-plugin-adv/services",
  "@haneoka/altair-preview-client",
  "@haneoka/vega/engine",
  "@haneoka/vega/preview",
  "@haneoka/vega-protocol",
]);

export default defineConfig({
  build: {
    lib: {
      entry: {
        compiler: resolve(root, "src/compiler.ts"),
        index: resolve(root, "src/index.ts"),
        preview: resolve(root, "src/preview.ts"),
        projection: resolve(root, "src/projection.ts"),
      },
      fileName: (_format, entry) => `${entry}.js`,
      formats: ["es"],
    },
    rollupOptions: {
      external(id) {
        if (externalImports.has(id)) return true;
        if (id.startsWith("@haneoka/")) {
          throw new Error(
            `Unexpected Haneoka runtime import: ${id}`,
          );
        }
        return false;
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
