import { defineAltairService, type AltairPreviewRequest, type AltairPreviewSession } from "@haneoka/altair/plugins";
import type { JsonObject, StoryProject } from "@haneoka/altair/model";
import type {
  CompileVegaPreviewStoryResult,
  CompileVegaProjectOptions,
  CompileVegaProjectResult,
  StoryDiagnostic,
} from "./projection.js";
import type { VegaPlugin } from "@haneoka/vega/engine";
import type { VegaEngine } from "@haneoka/vega/web";
import type { VegaPreviewIdentity } from "@haneoka/vega-protocol";

export const ALTAIR_VEGA_PREVIEW_PLUGIN_ID = "haneoka.altair-vega-preview" as const;
export const ALTAIR_VEGA_COMPILER_ID = "vega-adv" as const;
export const ALTAIR_VEGA_PREVIEW_PROVIDER_ID = "vega" as const;
export const ALTAIR_VEGA_PREVIEW_SERVICE_ID = "haneoka.altair.services.vega-preview" as const;
export const ALTAIR_VEGA_PREVIEW_DEFAULT_MOUNT = "default" as const;

export interface AltairVegaCompileRequest {
  readonly project: StoryProject;
  readonly sceneId?: string;
  readonly signal?: AbortSignal;
}

export interface AltairVegaCompileProjectRequest {
  readonly project: StoryProject;
  readonly options?: CompileVegaProjectOptions;
  readonly signal?: AbortSignal;
}

export interface AltairVegaCompiledScene {
  readonly story: JsonObject & {
    readonly commands: readonly JsonObject[];
  };
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly sceneId: string;
  /** Compiled-command index to authored-command index. */
  readonly commandSourceIndexes: readonly number[];
}

export interface AltairVegaPreviewService {
  compileProject(request: AltairVegaCompileProjectRequest): Promise<CompileVegaProjectResult>;
  compilePreviewStory(request: AltairVegaCompileRequest): Promise<CompileVegaPreviewStoryResult>;
  compileScene(request: AltairVegaCompileRequest): Promise<AltairVegaCompiledScene>;
  registerMount(id: string, mount: HTMLElement): { dispose(): void };
  /**
   * Registers already-authorized Vega modules for one preview profile.
   * Catalog loading and permission review remain the host's responsibility.
   */
  registerRuntimeProfile(id: string, profile: AltairVegaRuntimeProfile): { dispose(): void };
  createPreview(request: AltairPreviewRequest & { readonly signal: AbortSignal }): Promise<AltairPreviewSession>;
  dispose(): Promise<void>;
}

export const ALTAIR_VEGA_PREVIEW_SERVICE =
  defineAltairService<AltairVegaPreviewService>(ALTAIR_VEGA_PREVIEW_SERVICE_ID);

export interface AltairVegaEngineFactoryContext {
  readonly identity: VegaPreviewIdentity;
  readonly signal: AbortSignal;
  readonly officialPlugins: readonly VegaPlugin[];
  readonly plugins: readonly VegaPlugin[];
  readonly renderBackend?: string;
}

export interface AltairVegaRuntimeFactoryContext {
  readonly identity: VegaPreviewIdentity;
  readonly mount: HTMLElement;
  readonly port: MessagePort;
  readonly signal: AbortSignal;
  readonly officialPlugins: readonly VegaPlugin[];
  readonly plugins: readonly VegaPlugin[];
  /** Theme contribution id selected for every player in this preview. */
  readonly theme?: string | false;
  readonly renderBackend?: string;
}

export interface AltairVegaRuntimeProfile {
  readonly officialPlugins?: readonly VegaPlugin[];
  readonly plugins?: readonly VegaPlugin[];
  /** Theme contribution id selected for this preview profile. */
  readonly theme?: string | false;
  /** Render contribution id or backend selected for this preview profile. */
  readonly renderBackend?: string;
}

/**
 * Runtime handles must tolerate `dispose()` racing `start()`. This lets an
 * Altair AbortSignal cancel slow host initialization without leaking a late
 * runtime.
 */
export interface AltairVegaRuntimeHandle {
  start(): void | Promise<void>;
  dispose(): void | Promise<void>;
}

export interface AltairVegaPreviewPluginOptions {
  readonly externalPlaybackControls?: boolean;
  readonly defaultMountId?: string;
  readonly timeoutMs?: number;
  readonly sceneTimeoutMs?: number;
  readonly priority?: number;
  readonly officialPlugins?: readonly VegaPlugin[];
  readonly plugins?: readonly VegaPlugin[];
  /** Default theme contribution id for previews without a profile override. */
  readonly theme?: string | false;
  readonly renderBackend?: string;
  readonly createEngine?: (context: AltairVegaEngineFactoryContext) => VegaEngine | Promise<VegaEngine>;
  readonly createRuntime?: (
    context: AltairVegaRuntimeFactoryContext,
  ) => AltairVegaRuntimeHandle | Promise<AltairVegaRuntimeHandle>;
  readonly createIdentity?: (request: AltairPreviewRequest, sequence: number) => VegaPreviewIdentity;
  readonly onBackgroundError?: (error: unknown) => void;
}

export interface AltairVegaPreviewOptions extends JsonObject {
  readonly mountId?: string;
  readonly sceneId?: string;
  readonly sceneRevision?: string;
  readonly commandIndex?: number;
  readonly autoSync?: boolean;
  readonly runtimeProfileId?: string;
}
