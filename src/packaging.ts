import { STORY_CHARACTER_MODELS_KEY, isStoryResourceTemplate, storyResourceTemplatePattern, scopedStoryResourceTemplate } from "@haneoka/vega/story-resources";
import { VEGA_SYSTEM_OPCODE, type VegaJsonValue, type VegaProject } from "@haneoka/vega-protocol";
import {
  directAssetField,
  directAssetLocation,
  storyResourceMetadataField,
  storyResourceDirectoryField,
  ALTAIR_VEGA_METADATA_KEYS,
} from "./projection.js";
export interface StoryPackageFile {
  readonly path: string;
  readonly blob: Pick<Blob, "size" | "text">;
}
export interface StoryResourceIssue {
  readonly source: string;
  readonly reason: "missing" | "external" | "invalid-model";
}
export interface PreparedStoryPackage {
  readonly project: VegaProject;
  readonly resources: readonly string[];
  readonly issues: readonly StoryResourceIssue[];
}
const root = "https://story.invalid/";
const localPath = (source: string, parent = "") => {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(source)) return null;
  const url = new URL(source.replaceAll("\\", "/"), new URL(parent, root));
  if (url.origin !== new URL(root).origin || url.search || url.hash) return null;
  return decodeURIComponent(url.pathname.slice(1)).normalize("NFC");
};
/** Select runtime resource fields; dialogue, labels and authoring provenance remain literal text. */
export function mapStoryResourceLocations<Value>(
  value: Value,
  map: (source: string) => string,
  projectRoot?: string,
): Value {
  const scoped = (source: string): string => {
    const mapped = map(source);
    return mapped === source && projectRoot && isStoryResourceTemplate(source) && !/^(?:[a-z][a-z\d+.-]*:|\/)/iu.test(source)
      ? scopedStoryResourceTemplate(source, projectRoot) : mapped;
  };
  const visit = (value: unknown, context = false): unknown => {
    if (typeof value === "string") return context && directAssetLocation(value) ? scoped(value) : value;
    if (Array.isArray(value)) return value.map((entry) => visit(entry, context));
    if (!value || typeof value !== "object") return value;
    const runtime = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries({ ...runtime, ...(projectRoot && runtime.format === "composite" ? { projectRoot } : {}) }).map(
        ([key, child]) => [
          key,
          storyResourceMetadataField(key) ||
          storyResourceDirectoryField(key) ||
          (key === "value" &&
            (runtime.command === VEGA_SYSTEM_OPCODE.SetVariable || runtime.command === VEGA_SYSTEM_OPCODE.SetSetting))
            ? child
            : visit(child, context || directAssetField(key) || (key.toLowerCase() === "runtime" && typeof child === "string")),
        ],
      ),
    );
  };
  return visit(value) as Value;
}
export function mapStoryProjectResources(
  project: VegaProject,
  map: (source: string) => string,
  projectRoot?: string,
): VegaProject {
  const visit = (value: unknown) => mapStoryResourceLocations(value, map, projectRoot);
  const metadata = { ...project.metadata };
  for (const key of [
    STORY_CHARACTER_MODELS_KEY,
    ALTAIR_VEGA_METADATA_KEYS.assets,
    ALTAIR_VEGA_METADATA_KEYS.runtime,
    ALTAIR_VEGA_METADATA_KEYS.storyFields,
  ])
    if (metadata[key]) metadata[key] = visit(metadata[key]) as VegaJsonValue;
  return {
    ...project,
    metadata,
    ...(project.assets
      ? {
          assets: Object.fromEntries(
            Object.entries(project.assets).map(([id, asset]) => [
              id,
              {
                ...asset,
                source: mapStoryResourceLocations({ url: asset.source }, map, projectRoot).url,
                ...(asset.variants
                  ? {
                      variants: Object.fromEntries(
                        Object.entries(asset.variants).map(([key, value]) => [key, mapStoryResourceLocations({ url: value }, map, projectRoot).url]),
                      ),
                    }
                  : {}),
              },
            ]),
          ),
        }
      : {}),
    scenes: Object.fromEntries(
      Object.entries(project.scenes).map(([id, scene]) => [
        id,
        { ...scene, commands: scene.commands.map((command) => visit(command) as typeof command) },
      ]),
    ),
  };
}
/** Build the same closed resource graph for offline export and immutable community releases. */
export async function prepareStoryPackage(
  project: VegaProject,
  files: readonly StoryPackageFile[],
): Promise<PreparedStoryPackage> {
  const byPath = new Map(files.map((file) => [file.path, file.blob]));
  const selected = new Set<string>(),
    issues = new Map<string, StoryResourceIssue>();
  const select = (source: string, parent = ""): string => {
    if (!source || source === "none") return source;
    const path = localPath(source, parent);
    if (path === null) {
      issues.set(source, { source, reason: "external" });
      return source;
    }
    if (!byPath.has(path)) {
      const pattern = storyResourceTemplatePattern(path);
      if (pattern) {
        const matches = [...byPath.keys()].filter((candidate) => pattern.test(candidate));
        if (matches.length) {
          matches.forEach((candidate) => selected.add(candidate));
          return path;
        }
      }
      const alias = !parent ? project.assets?.[source] : undefined;
      if (alias && alias.source !== source) {
        const resolved = localPath(alias.source);
        if (resolved && byPath.has(resolved)) {
          selected.add(resolved);
          return resolved;
        } else issues.set(source, { source: alias.source, reason: resolved ? "missing" : "external" });
      } else issues.set(source, { source, reason: "missing" });
    } else {
      selected.add(path);
      return path;
    }
    return source;
  };
  project = mapStoryProjectResources(project, (source) => select(source));
  const modelDocuments = new Set<string>();
  const hasModelResource = (value: unknown, resource = false): boolean => {
    if (typeof value === "string") return resource && directAssetLocation(value);
    if (Array.isArray(value)) return value.some((entry) => hasModelResource(entry, resource));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(
      ([key, child]) =>
        !storyResourceMetadataField(key) &&
        !storyResourceDirectoryField(key) &&
        hasModelResource(child, resource || directAssetField(key)),
    );
  };
  const inspectCommand = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const command = value as Record<string, unknown>;
    const definition = typeof command.characterModelRef === "string"
      ? (project.metadata?.[STORY_CHARACTER_MODELS_KEY] as Record<string, unknown> | undefined)?.[command.characterModelRef] : command.characterModel;
    if (command.characterModelRef && !definition) {
      const source = String(command.characterModelRef); issues.set(`model:${source}`, { source, reason: "invalid-model" });
    }
    if (definition && typeof definition === "object") {
      const model = definition as Record<string, unknown>,
        runtime = (model.runtime ?? {}) as Record<string, unknown>;
      const format = String(runtime.format ?? model.format ?? "").toLowerCase();
      for (const reference of [
        runtime.model,
        runtime.modelUrl,
        runtime.json,
        model.model,
        model.modelUrl,
        model.json,
      ]) {
        if (typeof reference !== "string" || /\.(?:moc3?|skel|jsonl|wmdl)$/iu.test(reference)) continue;
        if (!/\.(?:json|bytes)$/iu.test(reference) && !format.startsWith("cubism") && !format.startsWith("spine"))
          continue;
        const path = localPath(reference);
        if (path) modelDocuments.add(path);
      }
    }
    if (definition && !hasModelResource(definition)) {
      const source = String(command.targetName ?? command.commandId ?? "model");
      issues.set(`model:${source}`, { source, reason: "invalid-model" });
    }
    const group = command.commandGroup as { actions?: { command: unknown }[] } | undefined;
    group?.actions?.forEach((action) => inspectCommand(action.command));
    const timeline = command.timeline as { signals?: { episode: unknown }[] } | undefined;
    timeline?.signals?.forEach((signal) => inspectCommand(signal.episode));
  };
  Object.values(project.scenes).forEach((scene) => scene.commands.forEach(inspectCommand));
  const visited = new Set<string>();
  // Model manifests and atlases resolve their leaf dependencies relative to their own location.
  for (;;) {
    const pending = [...selected].filter((path) => !visited.has(path));
    if (!pending.length) break;
    for (const path of pending) {
      visited.add(path);
      if (/\.(?:jsonl|wmdl)$/iu.test(path)) {
        const { importJsonlModel, importWmdlModel } = await import("@haneoka/vega-plugin-composite/import");
        try {
          const result = (/\.jsonl$/iu.test(path) ? importJsonlModel : importWmdlModel)(await byPath.get(path)!.text());
          for (const part of result.document.parts)
            if (!part.optional) select(part.source, part.options?.projectRoot ? "" : path);
        } catch {
          issues.set(path, { source: path, reason: "invalid-model" });
        }
      } else if (modelDocuments.has(path) || /\.(?:model3?|physics3?|pose3?|motion3?|exp3?|json)$/iu.test(path)) {
        const blob = byPath.get(path)!;
        if (blob.size > 64 * 1024 ** 2) {
          issues.set(path, { source: path, reason: "invalid-model" });
          continue;
        }
        let value: unknown;
        try {
          value = JSON.parse(await blob.text());
        } catch {
          if (modelDocuments.has(path)) issues.set(path, { source: path, reason: "invalid-model" });
          continue;
        }
        const visit = (value: unknown, resource = false) => {
          if (typeof value === "string") {
            if (resource && directAssetLocation(value)) select(value, path);
          } else if (Array.isArray(value)) value.forEach((entry) => visit(entry, resource));
          else if (value && typeof value === "object") {
            const part = value as { source?: unknown; options?: { projectRoot?: boolean } };
            if (typeof part.source === "string" && part.options?.projectRoot) select(part.source);
            for (const [key, child] of Object.entries(value))
              if (
                !storyResourceMetadataField(key) &&
                !storyResourceDirectoryField(key) &&
                !(key === "source" && part.options?.projectRoot)
              )
                visit(
                  child,
                  resource ||
                    directAssetField(key) ||
                    /^(?:file|moc|textures?|physics|pose|sound|atlas|skeleton)$/iu.test(key),
                );
          }
        };
        visit(value);
      } else if (/\.atlas(?:\.txt)?$/iu.test(path)) {
        let page = true,
          count = 0;
        for (const line of (await byPath.get(path)!.text()).split(/\r?\n/u)) {
          const text = line.trim();
          if (!text) {
            page = true;
            continue;
          }
          if (page) {
            select(text, path);
            count++;
            page = false;
          }
        }
        if (!count) issues.set(path, { source: path, reason: "invalid-model" });
      }
    }
  }
  return { project, resources: [...selected].sort(), issues: [...issues.values()] };
}
