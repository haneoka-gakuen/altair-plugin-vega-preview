import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const root = fileURLToPath(new URL(".", import.meta.url));
const externalImports = new Set([
  "@haneoka/altair/model",
  "@haneoka/altair/plugins",
  "@haneoka/altair-plugin-adv/services",
  "@haneoka/altair-plugin-adv/documents",
  "@haneoka/altair-plugin-adv/commands",
  "@haneoka/altair-plugin-adv/assets",
  "@haneoka/altair-plugin-adv/resources",
  "@haneoka/altair-preview-client",
  "@haneoka/vega/engine",
  "@haneoka/vega/web",
  "@haneoka/vega/preview",
  "@haneoka/vega/story-resources",
  "@haneoka/vega-protocol",
  "@haneoka/vega-plugin-haneoka/story-hydration",
  "@haneoka/vega-plugin-haneoka/scene-profile",
  "@haneoka/vega-plugin-composite/import",
]);

export default defineConfig({
  build: {
    lib: {
      entry: {
        packaging: resolve(root, "src/packaging.ts"),
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
          throw new Error(`Unexpected Haneoka runtime import: ${id}`);
        }
        return false;
      },
    },
    sourcemap: true,
    target: "es2022",
  },
});
