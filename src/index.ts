import {
  defineAltairPlugin,
  type AltairOperationContext,
  type AltairPreviewProviderContribution,
  type AltairPreviewRequest,
} from "@haneoka/altair/plugins";
import { ALTAIR_ADV_SERVICE } from "@haneoka/altair-plugin-adv/services";
import { vegaCompilerContribution } from "./compiler.js";
import {
  ALTAIR_VEGA_PREVIEW_PLUGIN_ID,
  ALTAIR_VEGA_PREVIEW_PROVIDER_ID,
  ALTAIR_VEGA_PREVIEW_SERVICE,
  type AltairVegaPreviewPluginOptions,
} from "./contracts.js";
import { createAltairVegaPreviewService } from "./preview.js";

export const createAltairVegaPreviewPlugin = (options: AltairVegaPreviewPluginOptions = {}) => {
  const priority = options.priority ?? 100;
  if (!Number.isSafeInteger(priority)) {
    throw new TypeError("Altair Vega preview priority must be an integer");
  }
  return defineAltairPlugin({
    manifest: {
      id: ALTAIR_VEGA_PREVIEW_PLUGIN_ID,
      name: "Altair Vega Preview",
      version: "0.1.0",
      apiVersion: 2,
      description: "Vega compiler and local preview runtime for Altair",
      dependencies: {
        "haneoka.altair-adv": "^0.1.0",
      },
      capabilities: ["compiler", "preview", "services"],
    },
    setup(context) {
      const adv = context.service(ALTAIR_ADV_SERVICE);
      if (!adv) {
        throw new ReferenceError("Altair ADV service is unavailable");
      }
      const service = context.use(createAltairVegaPreviewService(options, adv));
      context.provide(ALTAIR_VEGA_PREVIEW_SERVICE, service);
      context.contribute("compiler", vegaCompilerContribution, {
        priority,
        singletonPort: "vega-adv-output",
      });
      context.contribute(
        "preview",
        Object.freeze({
          id: ALTAIR_VEGA_PREVIEW_PROVIDER_ID,
          name: "Vega preview",
          create(
            request: AltairPreviewRequest & {
              readonly signal: AbortSignal;
            },
            operation: AltairOperationContext,
          ) {
            const activeService = operation.service(ALTAIR_VEGA_PREVIEW_SERVICE);
            if (!activeService) {
              throw new ReferenceError("Altair Vega preview service is unavailable");
            }
            return activeService.createPreview(request);
          },
        }) satisfies AltairPreviewProviderContribution,
        {
          priority,
          singletonPort: "vega-preview",
        },
      );
    },
  });
};

export const altairVegaPreviewPlugin = createAltairVegaPreviewPlugin();

export * from "./compiler.js";
export * from "./contracts.js";
export * from "./preview.js";
export * from "./projection.js";
export default altairVegaPreviewPlugin;
