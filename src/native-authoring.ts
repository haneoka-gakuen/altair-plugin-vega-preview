import type { AltairAuthoredNode, AltairAuthoredWorkspace, AltairDocumentRegistry } from "@haneoka/altair/documents";
import { cloneStoryValue, type JsonObject, type JsonValue, type StoryProjectCommand } from "@haneoka/altair/model";
import { advCommandToAuthoredNode } from "@haneoka/altair-plugin-adv/documents";
import { commandDescriptor } from "@haneoka/altair-plugin-adv/commands";
import { VEGA_COMMAND_GROUP_OPCODE } from "@haneoka/vega-protocol";
import { canonicalizeNativeStage, PRESENTATION_ORIGIN } from "./presentation.js";

const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
const flatten = (nodes: readonly AltairAuthoredNode[]): AltairAuthoredNode[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
interface NativeCommand extends StoryProjectCommand {
  layout?: { nodeId: string; kind: string; role?: string };
}
function commands(values: readonly StoryProjectCommand[]): NativeCommand[] {
  return values.flatMap((command) => {
    const origin = command.extensions.nativeLayoutOrigin ?? command.extensions[PRESENTATION_ORIGIN];
    const group = object(command.fields.commandGroup);
    const nested =
      command.command === VEGA_COMMAND_GROUP_OPCODE && Array.isArray(group.actions)
        ? group.actions.flatMap((value, index) => {
            const action = object(value),
              raw = object(action.command),
              { command: opcode, commandId, ...fields } = raw;
            if (typeof opcode !== "number" && typeof opcode !== "string") return [];
            const layout = object(action.nativeLayout);
            const child: NativeCommand = {
              id: typeof commandId === "string" ? commandId : `${command.id}/action/${index}`,
              command: opcode,
              fields,
              extensions: {},
            };
            if (typeof layout.nodeId === "string")
              child.layout = {
                nodeId: layout.nodeId,
                kind: String(layout.kind ?? "reflow"),
                role: String(action.role ?? "event"),
              };
            return [child, ...commands([child]).slice(1)];
          })
        : [];
    return [
      {
        ...command,
        ...(typeof origin === "string"
          ? { layout: { nodeId: origin, kind: String(command.extensions.nativeLayoutKind ?? "reflow") } }
          : {}),
      },
      ...nested,
    ];
  });
}
function field(
  node: AltairAuthoredNode,
  key: string,
  value: JsonValue | undefined,
  command: StoryProjectCommand,
): AltairAuthoredNode {
  const descriptor = commandDescriptor(command.command)?.fields.find(
    (field) => (field.sourceKey ?? field.key) === key && field.parameterIndex === undefined,
  );
  const args = { ...node.arguments },
    fields = { ...object(node.extensions?.fields) };
  if (descriptor) {
    delete fields[key];
    if (value === undefined) delete args[descriptor.key];
    else args[descriptor.key] = cloneStoryValue(value);
  } else {
    delete args[key];
    if (value === undefined) delete fields[key];
    else fields[key] = cloneStoryValue(value);
  }
  return { ...node, arguments: args, extensions: { ...node.extensions, fields } };
}

export function isCanonicalNativeWorkspace(workspace: AltairAuthoredWorkspace): boolean {
  const settings = object(workspace.project.runtime.presentation);
  const nodes = workspace.scenes.flatMap((scene) => flatten(scene.nodes)).filter((node) => !node.disabled);
  const worldTargets = new Set(
    nodes.flatMap((node) => {
      const fields = { ...object(node.extensions?.fields), ...node.arguments };
      return Object.keys(object(fields.characterWorldPosition)).length && typeof fields.targetName === "string"
        ? [fields.targetName]
        : [];
    }),
  );
  const legacyFocus = nodes.some((node) => {
    const fields = { ...object(node.extensions?.fields), ...node.arguments };
    return (
      node.type.plugin === "haneoka.altair-adv" &&
      node.type.name === "Focus" &&
      fields.cameraAnchor === undefined &&
      typeof fields.targetName === "string" &&
      worldTargets.has(fields.targetName)
    );
  });
  const models = ["models", "live2d", "characters"]
    .flatMap((key) => {
      const entries = workspace.project.assets[key];
      return Array.isArray(entries) ? entries : Object.values(object(entries));
    })
    .concat(
      workspace.scenes.flatMap((scene) =>
        flatten(scene.nodes)
          .filter((node) => !node.disabled)
          .map((node) => object(node.extensions?.fields).characterModel ?? null),
      ),
    );
  const legacyModels = models.some((model) => Object.hasOwn(object(object(model).profile), "placement"));
  return (
    !legacyModels &&
    !legacyFocus &&
    !workspace.scenes.some((scene) => Object.hasOwn(scene.extensions ?? {}, "presentationBaked")) &&
    settings.mode === "our-notes" &&
    settings.version === 2 &&
    settings.blocking === "native" &&
    settings.stageVersion === 2
  );
}

/** Converts stage data in place while retaining authored topology, IDs, locks and unknown node metadata. */
export function canonicalizeNativeWorkspace(
  workspace: AltairAuthoredWorkspace,
  registry: AltairDocumentRegistry,
): AltairAuthoredWorkspace {
  if (isCanonicalNativeWorkspace(workspace)) return workspace;
  const source = registry.compile(workspace);
  const compiled = {
    ...source,
    runtime: { ...source.runtime, presentation: { ...object(source.runtime.presentation), mode: "our-notes" } },
  };
  const canonical = canonicalizeNativeStage(compiled);
  if (canonical.runtime.presentation === undefined) return workspace;
  const oldCommands = new Map(
    commands(compiled.scenes.flatMap((scene) => scene.commands)).map((command) => [command.id, command]),
  );
  const nextCommands = commands(canonical.scenes.flatMap((scene) => scene.commands));
  const nextById = new Map(nextCommands.map((command) => [command.id, command]));
  const authoredIds = new Set(workspace.scenes.flatMap((scene) => flatten(scene.nodes).map((node) => node.id)));
  const extras = new Map<string, NativeCommand[]>();
  for (const command of nextCommands)
    if (!authoredIds.has(command.id) && command.layout) {
      extras.set(command.layout.nodeId, [...(extras.get(command.layout.nodeId) ?? []), command]);
    }
  const extraNode = (command: NativeCommand) => {
    const node = advCommandToAuthoredNode(command);
    return {
      ...node,
      extensions: {
        ...node.extensions,
        "haneoka.authoring.generated": { tool: "stage-layout", nodeId: command.layout!.nodeId },
      },
    };
  };
  const spatial = ["targetName", "positionType", "targets", "characterWorldPosition", "characterWorldTransition"];
  const rewrite = (node: AltairAuthoredNode, owner?: (command: NativeCommand) => void): AltairAuthoredNode[] => {
    if (node.disabled) return [node];
    let next = node;
    const before = oldCommands.get(node.id),
      after = nextById.get(node.id);
    if (before && after && node.type.plugin === "haneoka.altair-adv") {
      const owned = object(node.extensions?.fields);
      const keys = new Set<string>(
        ["characterModel", "background", "still", "stage"].filter((key) => Object.hasOwn(owned, key)),
      );
      if (["In", "Out", "MoveToDirection"].includes(node.type.name)) spatial.forEach((key) => keys.add(key));
      if (node.type.name === "Focus") keys.add("cameraAnchor");
      for (const key of keys) {
        const materializeAnchor =
          key === "cameraAnchor" &&
          node.arguments.cameraAnchor === undefined &&
          owned.cameraAnchor === undefined &&
          after.fields.cameraAnchor === "character";
        if (!materializeAnchor && JSON.stringify(before.fields[key]) === JSON.stringify(after.fields[key])) continue;
        let value = after.fields[key];
        if (key === "targets" && Array.isArray(value)) {
          const previous = Array.isArray(before.fields.targets) ? before.fields.targets : [];
          value = value.map((target) => ({
            ...object(previous.find((old) => object(old).target === object(target).target)),
            ...object(target),
          }));
        }
        next = field(next, key, value, after);
      }
    }
    if (next.children) {
      if (next.type.plugin === "haneoka.altair" && next.type.name === "timeline") {
        const extraChildren: AltairAuthoredNode[] = [],
          tracks: JsonValue[] = [];
        const byId = new Map(next.children.map((child) => [child.id, child]));
        const children = new Map<string, AltairAuthoredNode>();
        for (const value of Array.isArray(next.arguments.tracks) ? next.arguments.tracks : []) {
          const track = object(value),
            child = byId.get(String(track.nodeId));
          if (!child) throw new Error(`Timeline node is missing: ${track.nodeId}`);
          const attached: NativeCommand[] = [];
          const result = rewrite(child, (command) => attached.push(command));
          result.forEach((child) => children.set(child.id, child));
          tracks.push(track);
          for (const command of attached) {
            const child = extraNode(command);
            extraChildren.push(child);
            tracks.push({
              ...track,
              nodeId: child.id,
              role: command.layout?.role ?? (command.layout?.kind === "reflow" ? "event" : (track.role ?? "lifetime")),
            });
          }
        }
        next = {
          ...next,
          children: [...next.children.map((child) => children.get(child.id) ?? child), ...extraChildren],
          arguments: { ...next.arguments, tracks },
        };
      } else next = { ...next, children: next.children.flatMap((child) => rewrite(child, owner)) };
    }
    const added = extras.get(node.id) ?? [];
    if (owner) {
      added.forEach(owner);
      return [next];
    }
    return [next, ...added.map(extraNode)];
  };
  return {
    project: {
      ...workspace.project,
      assets: canonical.assets,
      runtime: {
        ...canonical.runtime,
        presentation: {
          ...object(canonical.runtime.presentation),
          mode: "our-notes",
          version: 2,
          blocking: "native",
          stageVersion: 2,
        },
      },
    },
    scenes: workspace.scenes.map((scene) => ({
      ...scene,
      extensions: canonical.scenes.find((value) => value.id === scene.id)!.extensions,
      nodes: scene.nodes.flatMap((node) => rewrite(node)),
    })),
  };
}
