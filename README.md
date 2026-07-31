# Altair Vega Preview

Compiles Altair projects and runs live Vega previews.

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-adv @haneoka/altair-plugin-vega-preview
```

```ts
import { createAltairVegaPreviewPlugin } from "@haneoka/altair-plugin-vega-preview";

await host.install(altairAdvPlugin);
await host.install(createAltairVegaPreviewPlugin({ officialPlugins }));
const mount = service.registerMount("main", previewElement);
const session = await host.createPreview("vega", {
  project,
  options: { mountId: "main", runtimeProfileId: "project" },
});
```

The preview service supports source diagnostics, live command updates, runtime profiles, themes, cancellation, and explicit session disposal. It contains no character SDKs, models, game assets, or vendor runtimes.

MPL-2.0.
