import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
} from "@haneoka/altair/model";
import {
  altairAdvService,
  type AltairAdvService,
} from "@haneoka/altair-plugin-adv/services";
import {
  VEGA_ADV_OPCODE,
  VEGA_SYSTEM_OPCODE,
  type VegaAsset,
  type VegaCommand,
  type VegaJsonValue,
  type VegaProject,
  type VegaProjectPlugin,
  type VegaScene,
} from "@haneoka/vega-protocol";

export type StoryDiagnosticSeverity = "info" | "warning" | "error";
export type StoryConversionFidelity =
  "exact" | "approximate" | "preserved-only" | "unsupported";

export interface StoryDiagnostic {
  readonly severity: StoryDiagnosticSeverity;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly fidelity?: StoryConversionFidelity;
  readonly line?: number;
}

export interface CompiledAdvStory extends JsonObject {
  commands: JsonObject[];
}

export type AltairAdvCompiler = Pick<AltairAdvService, "compile">;
export type AltairAuthoringPluginPredicate = (
  plugin: Readonly<VegaProjectPlugin>,
) => boolean;

export const isOfficialAltairAuthoringPlugin = (
  plugin: Pick<VegaProjectPlugin, "id">,
): boolean => plugin.id.startsWith("haneoka.altair-");

export interface CompileVegaProjectOptions {
  /** Stable project identity used by bundles, saves, and preview sessions. */
  readonly projectId?: string;
  readonly minimumEngineVersion?: string;
  readonly engineFeatures?: readonly string[];
  readonly plugins?: readonly VegaProjectPlugin[];
  readonly assets?: Readonly<Record<string, VegaAsset>>;
  /**
   * Keep the canonical authoring project in Vega metadata. This is enabled by
   * default so opaque WebGAL statements and editor-only data can round-trip.
   */
  readonly preserveAuthoringSource?: boolean;
  /**
   * Classifies additional targetless authoring plugins. Explicit runtime
   * targets remain authoritative. Among targetless entries, reserved
   * `haneoka.altair-*` IDs are always recognized without invoking this
   * predicate.
   */
  readonly isAuthoringPlugin?: AltairAuthoringPluginPredicate;
}

export interface VegaSceneSourceMap {
  readonly commandIds: readonly string[];
  readonly commandSourceIndexes: readonly number[];
  readonly omittedCommandIds: readonly string[];
}

export interface CompileVegaProjectResult {
  readonly project: VegaProject;
  readonly diagnostics: readonly StoryDiagnostic[];
  readonly sourceMap: Readonly<Record<string, VegaSceneSourceMap>>;
}

export interface CompileVegaPreviewStoryResult {
  /** Complete, keyed AdvStory command stream consumed by VegaPreviewRuntime. */
  readonly story: VegaJsonValue;
  readonly diagnostics: readonly StoryDiagnostic[];
  /** Scene placed first in the preview stream. */
  readonly sceneId: string;
  /** Selected-scene source indexes, retained for editor cursor compatibility. */
  readonly commandSourceIndexes: readonly number[];
  /** Selected-scene source indexes mapped to the complete preview command stream. */
  readonly commandIndexes: readonly number[];
  /** Every authored runtime command mapped back to its source command. */
  readonly commandMappings: readonly VegaPreviewCommandMapping[];
}

export interface VegaPreviewCommandMapping {
  readonly commandIndex: number;
  readonly sceneId: string;
  readonly sceneCommandIndex: number;
  readonly sourceCommandIndex: number;
}

/**
 * Stable metadata keys used by Vega's Deneb adapter to reconstruct the
 * per-scene AdvStory runtime payload. These snapshots are independent of the
 * optional, editor-complete authoring source.
 */
export const ALTAIR_VEGA_METADATA_KEYS = Object.freeze({
  assets: "altair:assets",
  runtime: "altair:runtime",
  storyFields: "altair:storyFields",
  authoringSource: "altair:authoringSource",
} as const);

const storyDiagnostic = (
  severity: StoryDiagnosticSeverity,
  code: string,
  path: string,
  message: string,
  fidelity?: StoryConversionFidelity,
  line?: number,
): StoryDiagnostic => ({
  severity,
  code,
  path,
  message,
  ...(fidelity === undefined ? {} : { fidelity }),
  ...(line === undefined ? {} : { line }),
});

const json = (value: JsonValue): VegaJsonValue =>
  cloneStoryValue(value) as VegaJsonValue;

const record = (value: JsonValue | undefined): JsonObject | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;

const firstString = (
  ...values: Array<JsonValue | undefined>
): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const projectIdPart = (value: string): string =>
  value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";

const defaultProjectId = (project: StoryProject): string => {
  const extensionId = firstString(project.extensions.vegaProjectId);
  const extraId = firstString(project.meta.extra?.id);
  return (
    extensionId ??
    extraId ??
    `story-${projectIdPart(project.meta.title || project.entrySceneId)}`
  );
};

const assetTypeByCategory: Readonly<Record<string, VegaAsset["type"]>> =
  Object.freeze({
    backgrounds: "image",
    stills: "image",
    frames: "image",
    effects: "data",
    videos: "video",
    live2d: "model",
    models: "model",
    sounds: "audio",
    audio: "audio",
    fonts: "font",
    data: "data",
  });

const categoryEntries = (value: JsonValue): Array<[string, JsonObject]> => {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      const object = record(entry);
      return object ? [[String(index), object]] : [];
    });
  }
  const object = record(value);
  if (!object) return [];
  return Object.entries(object).flatMap(([key, entry]) => {
    const item = record(entry);
    return item ? [[key, item]] : [];
  });
};

const assetAliases = (fallback: string, entry: JsonObject): string[] =>
  [
    entry.resourceRef,
    entry.id,
    entry.assetId,
    entry.assetName,
    entry.live2dKey,
    entry.characterKey,
    entry.videoId,
    entry.soundId,
    entry.name,
    fallback,
  ]
    .filter(
      (value): value is string | number =>
        typeof value === "string" || typeof value === "number",
    )
    .map(String)
    .map((value) => value.trim())
    .filter(
      (value, index, values) =>
        Boolean(value) && values.indexOf(value) === index,
    );

const assetSource = (entry: JsonObject): string | undefined =>
  firstString(
    entry.source,
    entry.url,
    entry.sourcePath,
    entry.runtimePath,
    entry.modelUrl,
    entry.imageUrl,
    entry.model,
    entry.moc,
  );

const externalAssetSource = (source: string): boolean =>
  /^https?:\/\//i.test(source);

const convertStoryAssets = (
  project: StoryProject,
  diagnostics: StoryDiagnostic[],
): Readonly<Record<string, VegaAsset>> | undefined => {
  const converted: Record<string, VegaAsset> = {};
  for (const [category, value] of Object.entries(project.assets)) {
    const type = assetTypeByCategory[category];
    if (!type) continue;
    for (const [fallback, entry] of categoryEntries(value)) {
      const source = assetSource(entry);
      const aliases = assetAliases(fallback, entry);
      if (!source) {
        diagnostics.push(
          storyDiagnostic(
            "warning",
            "vega.asset.source-missing",
            `$.assets.${category}.${fallback}`,
            `Asset metadata is preserved in metadata["${ALTAIR_VEGA_METADATA_KEYS.assets}"], but no portable source URL/path could be projected; an offline bundle needs an explicit resolver`,
            "unsupported",
          ),
        );
        continue;
      }
      const asset: VegaAsset = {
        type,
        source,
        ...(typeof entry.hash === "string" ? { hash: entry.hash } : {}),
        ...(typeof entry.mediaType === "string"
          ? { mediaType: entry.mediaType }
          : {}),
        ...(typeof entry.bytes === "number" &&
        Number.isSafeInteger(entry.bytes) &&
        entry.bytes >= 0
          ? { bytes: entry.bytes }
          : {}),
      };
      for (const alias of aliases) {
        const existing = converted[alias];
        if (
          existing &&
          (existing.source !== source || existing.type !== type)
        ) {
          diagnostics.push(
            storyDiagnostic(
              "warning",
              "vega.asset.alias-collision",
              `$.assets.${category}.${fallback}`,
              `Asset alias '${alias}' resolves to more than one source; the first mapping was retained`,
              "unsupported",
            ),
          );
          continue;
        }
        converted[alias] = asset;
      }
    }
  }
  return Object.keys(converted).length ? converted : undefined;
};

const directAssetField = (key: string): boolean => {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "source" ||
    normalized === "src" ||
    normalized === "url" ||
    normalized === "uri" ||
    normalized === "path" ||
    normalized === "bgmid" ||
    normalized === "bgmref" ||
    normalized === "seid" ||
    normalized === "seref" ||
    normalized === "videoid" ||
    normalized === "voiceid" ||
    normalized === "voiceids" ||
    normalized === "live2dkey" ||
    normalized === "model" ||
    normalized === "moc" ||
    normalized === "targetassetname" ||
    normalized.endsWith("url") ||
    normalized.endsWith("uri") ||
    normalized.endsWith("path") ||
    normalized.endsWith("src") ||
    normalized.endsWith("asset") ||
    normalized.endsWith("assetname") ||
    normalized.endsWith("assetref") ||
    normalized.endsWith("imageref") ||
    normalized.endsWith("audioref") ||
    normalized.endsWith("videoref") ||
    normalized.endsWith("voiceref") ||
    normalized.endsWith("voicerefs") ||
    normalized.endsWith("backgroundref") ||
    normalized.endsWith("stillref") ||
    normalized.endsWith("frameref") ||
    normalized.endsWith("effectref") ||
    normalized.endsWith("modelref") ||
    normalized.endsWith("fontref")
  );
};

const directAssetLocation = (value: string): boolean =>
  /^(?:https?:\/\/|blob:|file:|\/|\.{1,2}\/)/i.test(value) ||
  value.includes("/") ||
  value.includes("\\") ||
  /\.(?:avif|bmp|gif|jpe?g|png|svg|webp|aac|flac|m4a|mp3|oga|ogg|opus|wav|m4v|mp4|ogv|webm|json|moc3|model3|bin|ttf|otf|woff2?)(?:[?#].*)?$/i.test(
    value,
  );

const jsonPathMember = (key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `.${key}`
    : `[${JSON.stringify(key)}]`;

interface DirectAssetReference {
  readonly path: string;
  readonly value: string;
}

const directAssetReferences = (
  command: VegaCommand,
): DirectAssetReference[] => {
  const references: DirectAssetReference[] = [];
  const visit = (
    value: VegaJsonValue | undefined,
    path: string,
    resourceContext: boolean,
  ): void => {
    if (typeof value === "string") {
      if (resourceContext && directAssetLocation(value)) {
        references.push({ path, value });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        visit(entry, `${path}[${index}]`, resourceContext),
      );
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      visit(
        entry,
        `${path}${jsonPathMember(key)}`,
        resourceContext || directAssetField(key),
      );
    }
  };
  for (const [key, value] of Object.entries(command)) {
    visit(value, jsonPathMember(key), directAssetField(key));
  }
  return references;
};

type AdvCompileResult = ReturnType<AltairAdvCompiler["compile"]>;

const compileVegaSceneProjection = (
  project: StoryProject,
  sceneId: string,
  diagnostics: StoryDiagnostic[],
  compiler: AltairAdvCompiler,
  precompiled?: AdvCompileResult,
): { scene: VegaScene; sourceMap: VegaSceneSourceMap } => {
  const sourceScene = project.scenes.find((scene) => scene.id === sceneId);
  if (!sourceScene) {
    throw new RangeError(`Story scene '${sceneId}' does not exist`);
  }
  const compiled = precompiled ?? compiler.compile(project, sceneId);
  diagnostics.push(...compiled.diagnostics);

  const commands: VegaCommand[] = [];
  const commandIds: string[] = [];
  const commandSourceIndexes: number[] = [];
  for (const [compiledIndex, value] of compiled.story.commands.entries()) {
    const sourceIndex = compiled.commandSourceIndexes[compiledIndex];
    if (sourceIndex === undefined) continue;
    const sourceCommand = sourceScene.commands[sourceIndex];
    const opcode = value.command;
    if (
      !sourceCommand ||
      typeof opcode !== "number" ||
      !Number.isSafeInteger(opcode) ||
      opcode < 0
    ) {
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "vega.command.omitted",
          `$.scenes[${project.scenes.indexOf(
            sourceScene,
          )}].commands[${sourceIndex}]`,
          "The command remains in Altair authoring metadata but cannot be emitted as a Vega runtime command",
          "unsupported",
          sourceCommand?.source?.line,
        ),
      );
      continue;
    }
    const command = cloneStoryValue(value);
    if (
      Object.hasOwn(command, "index") &&
      (typeof command.index !== "number" ||
        !Number.isSafeInteger(command.index) ||
        command.index < 0)
    ) {
      delete command.index;
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "vega.command.index-normalized",
          `$.scenes[${project.scenes.indexOf(
            sourceScene,
          )}].commands[${sourceIndex}].index`,
          "A non-numeric source index was preserved in authoring metadata and omitted from Vega runtime data",
          "approximate",
          sourceCommand.source?.line,
        ),
      );
    }
    commands.push(command as unknown as VegaCommand);
    for (const reference of directAssetReferences(
      command as unknown as VegaCommand,
    )) {
      const networkDependent = externalAssetSource(reference.value);
      diagnostics.push(
        storyDiagnostic(
          "warning",
          "vega.command.direct-asset-location",
          `$.scenes[${project.scenes.indexOf(
            sourceScene,
          )}].commands[${sourceIndex}]${reference.path}`,
          networkDependent
            ? "A direct asset URL remains network-dependent; Deneb packages only top-level Vega assets"
            : "A direct asset path remains inside command data; Deneb packages and rewrites only top-level Vega assets, so offline inclusion is not guaranteed",
          "unsupported",
          sourceCommand.source?.line,
        ),
      );
    }
    commandIds.push(sourceCommand.id);
    commandSourceIndexes.push(sourceIndex);
  }

  const emitted = new Set(commandIds);
  const omittedCommandIds = sourceScene.commands
    .filter((command) => !emitted.has(command.id))
    .map((command) => command.id);
  const metadata: Record<string, VegaJsonValue> = {
    "altair:commandIds": commandIds,
    "altair:commandSourceIndexes": commandSourceIndexes,
    "altair:extensions": json(sourceScene.extensions),
  };
  if (omittedCommandIds.length) {
    metadata["altair:omittedCommandIds"] = omittedCommandIds;
  }
  return {
    scene: {
      id: sourceScene.id,
      title: sourceScene.name,
      commands,
      metadata,
    },
    sourceMap: {
      commandIds,
      commandSourceIndexes,
      omittedCommandIds,
    },
  };
};

const pluginTargetsVega = (
  plugin: VegaProjectPlugin,
  isAuthoringPlugin: AltairAuthoringPluginPredicate | undefined,
): boolean => {
  const runtimes = plugin.targets?.runtimes;
  if (runtimes !== undefined) return runtimes.includes("vega");
  return (
    !isOfficialAltairAuthoringPlugin(plugin) &&
    !(isAuthoringPlugin?.(plugin) ?? false)
  );
};

const storyProjectPluginsForVega = (
  plugins: StoryProject["plugins"],
  isAuthoringPlugin: AltairAuthoringPluginPredicate | undefined,
): readonly VegaProjectPlugin[] =>
  (plugins ?? [])
    .filter(
      (plugin) =>
        plugin.enabled !== false &&
        pluginTargetsVega(plugin, isAuthoringPlugin),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(({ enabled: _enabled, ...plugin }) => cloneStoryValue(plugin));

const explicitPluginsForVega = (
  plugins: readonly VegaProjectPlugin[],
  isAuthoringPlugin: AltairAuthoringPluginPredicate | undefined,
): readonly VegaProjectPlugin[] =>
  plugins
    .filter((plugin) => pluginTargetsVega(plugin, isAuthoringPlugin))
    .map((plugin) => cloneStoryValue(plugin));

/**
 * Compile Altair's lossless authoring model into Vega's portable project
 * contract. Every scene is compiled; opaque source data remains recoverable
 * through the default authoring snapshot.
 */
export const compileVegaProjectWithDiagnostics = (
  project: StoryProject,
  options: CompileVegaProjectOptions = {},
  compiler: AltairAdvCompiler = altairAdvService,
): CompileVegaProjectResult => {
  const entryCompiled = compiler.compile(project, project.entrySceneId);
  const diagnostics: StoryDiagnostic[] = [];
  const scenes: Record<string, VegaScene> = {};
  const sourceMap: Record<string, VegaSceneSourceMap> = {};
  for (const scene of project.scenes) {
    const compiled = compileVegaSceneProjection(
      project,
      scene.id,
      diagnostics,
      compiler,
      scene.id === project.entrySceneId ? entryCompiled : undefined,
    );
    scenes[scene.id] = compiled.scene;
    sourceMap[scene.id] = compiled.sourceMap;
  }

  const metadata: Record<string, VegaJsonValue> = {
    "altair:storyProjectVersion": project.version,
    [ALTAIR_VEGA_METADATA_KEYS.assets]: json(project.assets),
    [ALTAIR_VEGA_METADATA_KEYS.runtime]: json(project.runtime),
    [ALTAIR_VEGA_METADATA_KEYS.storyFields]: json(project.storyFields),
    "altair:extensions": json(project.extensions),
  };
  if (project.meta.description !== undefined) {
    metadata.description = project.meta.description;
  }
  if (project.meta.locale !== undefined) {
    metadata.locale = project.meta.locale;
  }
  if (project.meta.releaseServer !== undefined) {
    metadata.releaseServer = project.meta.releaseServer;
  }
  if (project.meta.tags !== undefined) {
    metadata.tags = [...project.meta.tags];
  }
  if (project.meta.provenance !== undefined) {
    metadata.provenance = json(project.meta.provenance);
  }
  if (project.meta.extra !== undefined) {
    metadata["altair:metaExtra"] = json(project.meta.extra);
  }
  if (options.preserveAuthoringSource !== false) {
    metadata[ALTAIR_VEGA_METADATA_KEYS.authoringSource] = json(
      project as unknown as JsonValue,
    );
  }

  const convertedAssets =
    options.assets ?? convertStoryAssets(project, diagnostics);
  if (Object.keys(project.assets).length) {
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "vega.asset.flat-projection",
        "$.assets",
        `Legacy AdvStory assets are retained exactly in metadata["${ALTAIR_VEGA_METADATA_KEYS.assets}"]; top-level Vega assets are a flat packaging projection and do not prove that every legacy field or dependency is available offline`,
        "approximate",
      ),
    );
  }
  const externalSources = new Set<string>();
  for (const [key, asset] of Object.entries(convertedAssets ?? {})) {
    if (
      !externalAssetSource(asset.source) ||
      externalSources.has(asset.source)
    ) {
      continue;
    }
    externalSources.add(asset.source);
    diagnostics.push(
      storyDiagnostic(
        "warning",
        "vega.asset.external-source",
        `$.assets${jsonPathMember(key)}.source`,
        "This asset source remains external and is not copied into an offline Deneb bundle",
        "unsupported",
      ),
    );
  }
  const engine =
    options.minimumEngineVersion !== undefined || options.engineFeatures?.length
      ? {
          ...(options.minimumEngineVersion === undefined
            ? {}
            : {
                minimumVersion: options.minimumEngineVersion,
              }),
          ...(options.engineFeatures?.length
            ? { features: [...options.engineFeatures] }
            : {}),
        }
      : undefined;
  const plugins =
    options.plugins === undefined
      ? storyProjectPluginsForVega(
          project.plugins,
          options.isAuthoringPlugin,
        )
      : explicitPluginsForVega(
          options.plugins,
          options.isAuthoringPlugin,
        );
  const output: VegaProject = {
    format: "vega-project",
    formatVersion: 1,
    id: options.projectId ?? defaultProjectId(project),
    title: project.meta.title,
    entryScene: project.entrySceneId,
    scenes,
    metadata,
    ...(engine ? { engine } : {}),
    ...(convertedAssets ? { assets: convertedAssets } : {}),
    ...(plugins.length ? { plugins } : {}),
  };
  return { project: output, diagnostics, sourceMap };
};

export const compileVegaProject = (
  project: StoryProject,
  options: CompileVegaProjectOptions = {},
  compiler: AltairAdvCompiler = altairAdvService,
): VegaProject =>
  compileVegaProjectWithDiagnostics(project, options, compiler).project;

const PREVIEW_SCENE_KEY_PREFIX = "vega:scene:";
const PREVIEW_COMMAND_KEY_PREFIX = "vega:command:";

const previewSceneKey = (sceneId: string): string =>
  `${PREVIEW_SCENE_KEY_PREFIX}${encodeURIComponent(sceneId)}`;

const previewCommandKey = (sceneId: string, key: string): string =>
  `${PREVIEW_COMMAND_KEY_PREFIX}${encodeURIComponent(
    sceneId,
  )}:${encodeURIComponent(key)}`;

const previewReturnKey = (sceneId: string, commandIndex: number): string =>
  `vega:return:${encodeURIComponent(sceneId)}:${commandIndex}`;

const previewTargetKey = (
  value: string,
  sceneId: string,
  sceneKeys: ReadonlyMap<string, string>,
): string => {
  if (sceneKeys.has(value)) return sceneKeys.get(value)!;
  if (
    value.startsWith(PREVIEW_SCENE_KEY_PREFIX) ||
    value.startsWith(PREVIEW_COMMAND_KEY_PREFIX)
  ) {
    return value;
  }
  return previewCommandKey(sceneId, value);
};

const rewritePreviewCommand = (
  source: VegaCommand,
  sceneId: string,
  localIndex: number,
  sceneKeys: ReadonlyMap<string, string>,
): JsonObject => {
  const command = cloneStoryValue(source as unknown as JsonValue) as JsonObject;
  const opcode = Number(source.command);
  command.index = localIndex;
  command.sceneSource = sceneId;
  command.sceneCommandIndex = localIndex;
  if (
    opcode !== VEGA_SYSTEM_OPCODE.JumpScene &&
    opcode !== VEGA_SYSTEM_OPCODE.CallScene
  ) {
    command.sceneId = sceneId;
  }
  if (source.key) {
    command.key = previewCommandKey(sceneId, source.key);
  }

  if (
    opcode === VEGA_ADV_OPCODE.GoTo &&
    Array.isArray(source.params) &&
    source.params[0] !== undefined
  ) {
    command.params = [
      previewCommandKey(sceneId, String(source.params[0])),
      ...source.params.slice(1).map(String),
    ];
  }
  if (Array.isArray(command.choices)) {
    command.choices = command.choices.map((choice) => {
      const choiceObject = record(choice);
      if (!choiceObject) return choice;
      const nextKey = choiceObject.nextKey;
      return typeof nextKey === "string" && nextKey
        ? {
            ...choiceObject,
            nextKey: previewTargetKey(nextKey, sceneId, sceneKeys),
          }
        : choiceObject;
    });
  }
  for (const field of ["targetKey", "thenKey", "elseKey"] as const) {
    const value = source[field];
    if (typeof value === "string" && value) {
      command[field] = previewTargetKey(value, sceneId, sceneKeys);
    }
  }
  for (const field of ["sceneId", "thenScene", "elseScene"] as const) {
    const value = source[field];
    if (typeof value === "string" && value && !sceneKeys.has(value)) {
      throw new RangeError(
        `Scene ${sceneId} command ${localIndex} references missing scene ${value}`,
      );
    }
  }
  return command;
};

/**
 * Compile every scene into the same keyed command stream used by Vega/Deneb.
 * The selected scene is ordered first so seek, run-scene, calls, jumps, and
 * breakpoints all work through one preview session.
 */
export const compileStoryProjectForVegaPreview = (
  project: StoryProject,
  sceneId = project.entrySceneId,
  compiler: AltairAdvCompiler = altairAdvService,
): CompileVegaPreviewStoryResult => {
  const compiled = compileVegaProjectWithDiagnostics(project, {}, compiler);
  const selectedScene = compiled.project.scenes[sceneId];
  if (!selectedScene) {
    throw new RangeError(`Story scene '${sceneId}' does not exist`);
  }

  const sceneOrder = [
    sceneId,
    ...Object.keys(compiled.project.scenes).filter(
      (candidate) => candidate !== sceneId,
    ),
  ];
  const sceneKeys = new Map(
    sceneOrder.map((candidate) => [candidate, previewSceneKey(candidate)]),
  );
  const commands: JsonObject[] = [];
  const commandMappings: VegaPreviewCommandMapping[] = [];

  for (const currentSceneId of sceneOrder) {
    const scene = compiled.project.scenes[currentSceneId]!;
    commands.push({
      command: VEGA_SYSTEM_OPCODE.SceneMarker,
      key: sceneKeys.get(currentSceneId)!,
      sceneId: currentSceneId,
      name: "SceneMarker",
    });

    scene.commands.forEach((source, localIndex) => {
      const command = rewritePreviewCommand(
        source,
        currentSceneId,
        localIndex,
        sceneKeys,
      );
      if (Number(source.command) === VEGA_SYSTEM_OPCODE.CallScene) {
        command.currentScene = currentSceneId;
        command.returnKey = previewReturnKey(currentSceneId, localIndex);
      }
      const commandIndex = commands.length;
      commands.push(command);
      const sourceCommandIndex =
        compiled.sourceMap[currentSceneId]?.commandSourceIndexes[localIndex];
      if (sourceCommandIndex !== undefined) {
        commandMappings.push({
          commandIndex,
          sceneId: currentSceneId,
          sceneCommandIndex: localIndex,
          sourceCommandIndex,
        });
      }
      if (Number(source.command) === VEGA_SYSTEM_OPCODE.CallScene) {
        commands.push({
          command: VEGA_SYSTEM_OPCODE.SceneMarker,
          key: previewReturnKey(currentSceneId, localIndex),
          sceneId: currentSceneId,
          returnMarker: true,
          name: "SceneReturnMarker",
        });
      }
    });

    const lastOpcode = Number(scene.commands.at(-1)?.command);
    if (
      lastOpcode !== VEGA_SYSTEM_OPCODE.JumpScene &&
      lastOpcode !== VEGA_SYSTEM_OPCODE.ReturnScene &&
      lastOpcode !== VEGA_SYSTEM_OPCODE.End
    ) {
      commands.push({
        command: VEGA_SYSTEM_OPCODE.End,
        sceneId: currentSceneId,
        returnIfCalled: true,
        name: "SceneEnd",
      });
    }
  }

  const portableStory = cloneStoryValue(project.storyFields);
  delete portableStory.commands;
  delete portableStory.runtime;
  delete portableStory.assets;
  const selectedMappings = commandMappings.filter(
    (mapping) => mapping.sceneId === sceneId,
  );
  const story: JsonObject = {
    ...portableStory,
    commands,
    assets: cloneStoryValue(project.assets),
    runtime: cloneStoryValue(project.runtime),
    ...(compiled.project.assets
      ? {
          vegaAssets: json(compiled.project.assets as unknown as JsonValue),
        }
      : {}),
    vegaEntryKey: sceneKeys.get(sceneId)!,
    vegaProject: {
      id: compiled.project.id,
      title: json(compiled.project.title as unknown as JsonValue),
      entryScene: sceneId,
      formatVersion: compiled.project.formatVersion,
    },
  };
  return {
    story: json(story),
    diagnostics: compiled.diagnostics,
    sceneId,
    commandSourceIndexes: selectedMappings.map(
      ({ sourceCommandIndex }) => sourceCommandIndex,
    ),
    commandIndexes: selectedMappings.map(({ commandIndex }) => commandIndex),
    commandMappings,
  };
};

/**
 * Reference projection used by Vega/Deneb adapters. It rebuilds the complete
 * AdvStory runtime envelope without requiring `altair:authoringSource`; it is
 * not an authoring-model round trip.
 */
export const projectVegaSceneToAdvStory = (
  project: VegaProject,
  sceneId = project.entryScene,
): CompiledAdvStory => {
  if (project.format !== "vega-project" || project.formatVersion !== 1) {
    throw new TypeError("Unsupported Vega project format");
  }
  const scene = project.scenes[sceneId];
  if (!scene) {
    throw new RangeError(`Vega project scene '${sceneId}' does not exist`);
  }
  const metadata = project.metadata ?? {};
  const projectionRecord = (key: string): JsonObject | undefined => {
    const value = metadata[key] as JsonValue | undefined;
    if (value === undefined) return undefined;
    const object = record(value);
    if (!object) {
      throw new TypeError(`Vega project metadata '${key}' must be an object`);
    }
    return object;
  };
  const storyFields = projectionRecord(ALTAIR_VEGA_METADATA_KEYS.storyFields);
  const assets = projectionRecord(ALTAIR_VEGA_METADATA_KEYS.assets);
  const runtime = projectionRecord(ALTAIR_VEGA_METADATA_KEYS.runtime);
  const story: CompiledAdvStory = {
    ...(storyFields ? cloneStoryValue(storyFields) : {}),
    commands: cloneStoryValue(scene.commands) as unknown as JsonObject[],
  };
  if (assets) story.assets = cloneStoryValue(assets);
  if (runtime) story.runtime = cloneStoryValue(runtime);
  return story;
};

/** Restore the exact Altair model when a Vega project carries its snapshot. */
export const restoreStoryProjectFromVegaProject = (
  project: VegaProject,
  compiler: AltairAdvCompiler = altairAdvService,
): StoryProject => {
  if (project.format !== "vega-project" || project.formatVersion !== 1) {
    throw new TypeError("Unsupported Vega project format");
  }
  const source = project.metadata?.[ALTAIR_VEGA_METADATA_KEYS.authoringSource];
  if (!source) {
    throw new TypeError(
      "Vega project does not contain an Altair authoring snapshot",
    );
  }
  const restored = cloneStoryValue(source) as unknown as StoryProject;
  compiler.compile(restored, restored.entrySceneId);
  return restored;
};
