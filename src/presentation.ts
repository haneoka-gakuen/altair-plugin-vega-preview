import {
  storySpeaker,
  storyCommandAtoms,
  planAutomaticStoryShots,
  isStoryCameraCommand,
  STORYBOARD_KEY,
  type StoryShot,
} from "./storyboard.js";
export * from "./storyboard.js";
import { VEGA_ADV_OPCODE, VEGA_SYSTEM_OPCODE } from "@haneoka/vega-protocol";
import {
  HANEOKA_STAGE_GEOMETRY,
  HANEOKA_CHARACTER_FRAMING,
  planHaneokaStageBlocking,
} from "@haneoka/vega-plugin-haneoka/scene-profile";
import {
  cloneStoryValue,
  type JsonObject,
  type JsonValue,
  type StoryProject,
  type StoryProjectCommand,
} from "@haneoka/altair/model";

export const PRESENTATION_KEY = "presentation";
export const PRESENTATION_ORIGIN = "haneoka.presentation.origin";
const ourNotesStage = JSON.parse(JSON.stringify(HANEOKA_STAGE_GEOMETRY)) as JsonObject;
export interface OurNotesPresentation {
  readonly mode: "our-notes";
  readonly bindings?: Readonly<Record<string, string>>;
  readonly transitionSeconds?: number;
  readonly cameraDistance?: number;
}
const object = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const text = (value: JsonValue | undefined, locale: string): string => {
  if (typeof value === "string") return value;
  const values = object(value);
  return typeof values[locale] === "string"
    ? values[locale]
    : (Object.values(values).find((value) => typeof value === "string") ?? "");
};
export const presentationTargets = (fields: JsonObject): string[] => {
  if (Array.isArray(fields.targets) && fields.targets.length)
    return fields.targets.flatMap((value) => {
      const target = object(value).target ?? object(value).targetName;
      return typeof target === "string" && target ? [target] : [];
    });
  return typeof fields.targetName === "string" && fields.targetName ? [fields.targetName] : [];
};
const targets = presentationTargets;
const manualCamera = (value: JsonValue | StoryProjectCommand): boolean => {
  const command = object(value as JsonValue),
    fields = object(command.fields ?? command);
  return isStoryCameraCommand({
    id: "",
    command: typeof command.command === "number" || typeof command.command === "string" ? command.command : null,
    fields,
    extensions: {},
  });
};

function stageModel(model: JsonObject): JsonObject {
  const profile = object(model.profile),
    placement = object(profile.placement);
  if (!Object.keys(placement).length) return model;
  const { placement: _, ...nativeProfile } = profile;
  return {
    ...model,
    profile: {
      ...nativeProfile,
      ...(JSON.parse(JSON.stringify(HANEOKA_CHARACTER_FRAMING)) as JsonObject),
    },
  };
}
const nativeStage = (value: JsonValue): JsonObject => ({ ...object(value), ...ourNotesStage, backgroundFit: "cover" });
function stageCommand(
  command: StoryProjectCommand,
  normalizeCoordinates = false,
  normalizeStage = false,
): StoryProjectCommand {
  const normalize = (fields: JsonObject): JsonObject => {
    const output = { ...fields };
    const model = object(fields.characterModel);
    if (Object.keys(model).length) output.characterModel = stageModel(model);
    if (normalizeCoordinates) {
      delete output.characterWorldPosition;
      delete output.characterWorldTransition;
    }
    if (normalizeStage) {
      if (Object.keys(object(fields.stage)).length) output.stage = nativeStage(fields.stage!);
      for (const field of ["background", "still"]) {
        const resource = object(fields[field]);
        if (Object.keys(object(resource.stage)).length)
          output[field] = { ...resource, stage: nativeStage(resource.stage!) };
      }
    }
    const group = object(fields.commandGroup);
    if (Array.isArray(group.actions))
      output.commandGroup = {
        ...group,
        actions: group.actions.map((value) => {
          const action = object(value);
          return { ...action, command: normalize(object(action.command)) };
        }),
      };
    const timeline = object(fields.timeline);
    if (Array.isArray(timeline.signals))
      output.timeline = {
        ...timeline,
        signals: timeline.signals.map((value) => {
          const signal = object(value);
          return { ...signal, episode: normalize(object(signal.episode)) };
        }),
      };
    return output;
  };
  return { ...command, fields: normalize(command.fields) };
}
function placements(fields: JsonObject): [string, number][] {
  return targets(fields).map((target) => {
    const row = Array.isArray(fields.targets)
      ? fields.targets.map(object).find((value) => (value.target ?? value.targetName) === target)
      : undefined;
    const position = row?.positionType ?? fields.positionType;
    return [target, typeof position === "number" ? position : 5];
  });
}
function stageModels(assets: JsonObject, normalizeStage = false): JsonObject {
  const output = cloneStoryValue(assets);
  for (const category of ["models", "live2d", "characters"]) {
    const entries = output[category];
    for (const entry of Array.isArray(entries) ? entries : Object.values(object(entries))) {
      const model = object(entry);
      Object.assign(model, stageModel(model));
    }
  }
  if (normalizeStage)
    for (const category of ["backgrounds", "stills"]) {
      const entries = output[category];
      for (const entry of Array.isArray(entries) ? entries : Object.values(object(entries))) {
        const resource = object(entry);
        if (Object.keys(object(resource.stage)).length) resource.stage = nativeStage(resource.stage!);
      }
    }
  return output;
}

function entryCharacters(project: StoryProject): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const scenes = new Map(project.scenes.map((scene) => [scene.id, scene]));
  const hidden = new Map(
    project.scenes.map((scene) => [
      scene.id,
      new Set(
        storyCommandAtoms(scene.commands)
          .filter((command) => command.command === VEGA_ADV_OPCODE.Out)
          .flatMap((command) => targets(command.fields)),
      ),
    ]),
  );
  const calls = (command: StoryProjectCommand) =>
    command.command === VEGA_SYSTEM_OPCODE.CallScene || command.command === VEGA_SYSTEM_OPCODE.JumpScene
      ? String(command.fields.sceneId ?? "")
      : "";
  let changed = true;
  while (changed) {
    changed = false;
    for (const scene of project.scenes)
      for (const command of storyCommandAtoms(scene.commands)) {
        const child = hidden.get(calls(command));
        if (child)
          for (const target of child)
            if (!hidden.get(scene.id)!.has(target)) {
              hidden.get(scene.id)!.add(target);
              changed = true;
            }
      }
  }
  const incoming = new Map<string, Map<string, number>>([[project.entrySceneId, new Map()]]),
    queue = [project.entrySceneId];
  while (queue.length) {
    const id = queue.shift()!,
      scene = scenes.get(id);
    if (!scene) continue;
    const visible = new Map(incoming.get(id));
    for (const command of storyCommandAtoms(scene.commands)) {
      if (command.command === VEGA_ADV_OPCODE.In)
        placements(command.fields).forEach(([target, position]) => visible.set(target, position));
      if (command.command === VEGA_ADV_OPCODE.Out) targets(command.fields).forEach((target) => visible.delete(target));
      const targetScene = calls(command);
      if (!targetScene) continue;
      const previous = incoming.get(targetScene),
        next = previous
          ? new Map([...previous].filter(([target, position]) => visible.get(target) === position))
          : new Map(visible);
      if (!previous || previous.size !== next.size) {
        incoming.set(targetScene, next);
        if (!queue.includes(targetScene)) queue.push(targetScene);
      }
      if (command.command === VEGA_SYSTEM_OPCODE.CallScene)
        hidden.get(targetScene)?.forEach((target) => visible.delete(target));
      else if (!command.fields.condition) break;
    }
  }
  return incoming;
}

function nativeBlocking(project: StoryProject): StoryProject {
  const incoming = entryCharacters(project);
  const stage = HANEOKA_STAGE_GEOMETRY;
  return {
    ...project,
    scenes: project.scenes.map((scene) => {
      const shown = new Map(incoming.get(scene.id));
      const placed = new Map<string, number>();
      const ids = new Set([...scene.commands, ...storyCommandAtoms(scene.commands)].map((command) => command.id));
      const uniqueId = (value: string) => {
        while (ids.has(value)) value += ".";
        ids.add(value);
        return value;
      };
      const place = (original: StoryProjectCommand): StoryProjectCommand[] => {
        const source = stageCommand(original, true);
        const group = object(source.fields.commandGroup);
        if (Array.isArray(group.actions)) {
          const replacements = new Map<number, JsonValue[]>();
          for (const { action, index } of group.actions
            .map((value, index) => ({ action: object(value), index }))
            .sort((a, b) => Number(a.action.atSeconds ?? 0) - Number(b.action.atSeconds ?? 0) || a.index - b.index)) {
            const raw = object(action.command);
            if (typeof raw.command !== "number" && typeof raw.command !== "string") continue;
            const { command, ...fields } = raw;
            replacements.set(
              index,
              place({
                id: String(raw.commandId ?? `${source.id}/action/${index}`),
                command,
                fields,
                extensions: {},
              }).map((child) => ({
                ...action,
                ...(child.extensions[PRESENTATION_ORIGIN] ? { role: "event" } : {}),
                ...(child.extensions.nativeLayoutOrigin || child.extensions[PRESENTATION_ORIGIN]
                  ? {
                      nativeLayout: {
                        nodeId: String(child.extensions.nativeLayoutOrigin ?? child.extensions[PRESENTATION_ORIGIN]),
                        kind: String(child.extensions.nativeLayoutKind ?? "reflow"),
                      },
                    }
                  : {}),
                command: { ...child.fields, command: child.command, commandId: child.id },
              })),
            );
          }
          return [
            {
              ...source,
              fields: {
                ...source.fields,
                commandGroup: {
                  ...group,
                  actions: group.actions.flatMap((action, index) => replacements.get(index) ?? [action]),
                },
              },
            },
          ];
        }
        const entering = source.command === VEGA_ADV_OPCODE.In;
        const leaving = source.command === VEGA_ADV_OPCODE.Out;
        const moving = source.command === VEGA_ADV_OPCODE.MoveToDirection;
        if (!entering && !leaving && !moving) return [source];
        if (entering || moving)
          for (const [target, position] of placements(source.fields))
            if (entering || shown.has(target)) shown.set(target, position);
        if (leaving)
          for (const target of targets(source.fields)) {
            shown.delete(target);
            placed.delete(target);
          }
        const ordered = [...shown].sort((a, b) => a[1] - b[1]);
        const positions = new Map(
          [...planHaneokaStageBlocking(ordered.map(([target, order]) => ({ target, order })))].map(
            ([target, point]) => [target, point.x - stage.characterFieldPosition.x],
          ),
        );
        const world = (x: number): JsonObject => ({
          x: stage.characterFieldPosition.x + x,
          y: stage.characterFieldPosition.y + stage.characterBasePosition.y * stage.characterFieldScale,
          z: stage.characterFieldPosition.z + stage.characterBasePosition.z * stage.characterFieldScale,
        });
        const direct = entering || moving ? targets(source.fields).filter((target) => positions.has(target)) : [];
        const { key: _, ...unlabelled } = source.fields;
        const output: StoryProjectCommand[] = direct.length
          ? direct.map((target, index) => ({
              ...source,
              ...(index
                ? {
                    id: uniqueId(`${source.id}/target/${index}`),
                    extensions: { ...source.extensions, nativeLayoutOrigin: source.id, nativeLayoutKind: "target" },
                  }
                : {}),
              fields: {
                ...(index ? unlabelled : source.fields),
                targetName: target,
                targets: [{ target }],
                positionType: shown.get(target)!,
                characterWorldPosition: world(positions.get(target)!),
              },
            }))
          : [source];
        for (const [target, x] of positions) {
          if (!direct.includes(target) && placed.get(target) !== x)
            output.push({
              id: uniqueId(`presentation:${source.id}:blocking:${encodeURIComponent(target)}`),
              command: VEGA_ADV_OPCODE.MoveToDirection,
              fields: {
                targetName: target,
                targets: [{ target }],
                positionType: shown.get(target)!,
                characterWorldPosition: world(x),
                duration: typeof source.fields.duration === "number" ? source.fields.duration : 0.25,
                noWait: true,
                ...(source.fields.condition ? { condition: source.fields.condition } : {}),
              },
              extensions: { [PRESENTATION_ORIGIN]: source.id },
            });
          placed.set(target, x);
        }
        return output;
      };
      return { ...scene, commands: scene.commands.flatMap(place) };
    }),
  };
}

export function nativePresentationPolicy(
  settings: JsonObject,
  models: readonly JsonValue[],
  baked = false,
  legacyProvider?: JsonValue,
): JsonObject {
  if (settings.version === 2) return settings;
  const automatic =
    !baked &&
    (models.some((model) => Boolean(object(object(model).profile).placement)) ||
      legacyProvider === "bestdori" ||
      legacyProvider === "sekai");
  const { blockingVersion: _, ...current } = settings;
  return {
    ...current,
    version: 2,
    blocking: settings.blocking ?? (automatic ? "automatic" : "native"),
    cameraMode: settings.cameraMode ?? "automatic",
  };
}

/** Migrates old import hints into editable native settings. Provenance is not a render setting. */
export function normalizeNativePresentation(project: StoryProject): StoryProject {
  const settings = object(project.runtime[PRESENTATION_KEY]);
  if (settings.mode !== "our-notes" || settings.version === 2) return project;
  const models = ["models", "live2d", "characters"]
    .flatMap((category) => {
      const entries = project.assets[category];
      return Array.isArray(entries) ? entries : Object.values(object(entries));
    })
    .concat(
      project.scenes.flatMap((scene) =>
        storyCommandAtoms(scene.commands).map((command) => command.fields.characterModel ?? null),
      ),
    );
  const baked =
    settings.blockingVersion === 1 && project.scenes.every((scene) => scene.extensions.presentationBaked === true);
  return {
    ...project,
    runtime: {
      ...project.runtime,
      [PRESENTATION_KEY]: nativePresentationPolicy(
        settings,
        models,
        baked,
        object(project.extensions.archiveSource).provider,
      ),
    },
  };
}

/** Materialize native actor coordinates at an import boundary; saved actors no longer depend on an adapter. */
export function canonicalizeNativeStage(input: StoryProject): StoryProject {
  const previous = object(input.runtime[PRESENTATION_KEY]);
  const project = normalizeNativePresentation({
      ...input,
      runtime: {
        ...input.runtime,
        [PRESENTATION_KEY]: {
          ...previous,
          mode: "our-notes",
          ...(previous.mode === "source" ? { cameraMode: "manual" } : {}),
        },
      },
    }),
    settings = object(project.runtime[PRESENTATION_KEY]);
  const automatic = settings.blocking === "automatic";
  const positioned = automatic ? nativeBlocking(project) : project;
  const worldTargets = new Set(
    positioned.scenes.flatMap((scene) =>
      storyCommandAtoms(scene.commands).flatMap((command) =>
        Object.keys(object(command.fields.characterWorldPosition)).length ? targets(command.fields) : [],
      ),
    ),
  );
  const stages = Object.fromEntries(
    Object.entries(object(positioned.runtime.stages)).map(([id, stage]) => [
      id,
      automatic ? nativeStage(stage) : cloneStoryValue(stage),
    ]),
  );
  const postEffects = cloneStoryValue(object(positioned.runtime.postEffects));
  const bind = (value: JsonValue | undefined): JsonValue | undefined => {
    const resource = object(value),
      stage = object(resource.stage);
    for (const [id, profile] of Object.entries(object(resource.postEffects)))
      postEffects[id] ??= cloneStoryValue(profile);
    if (typeof resource.stageRef !== "string" || !Object.keys(stage).length) return value;
    stages[resource.stageRef] ??= cloneStoryValue(stage);
    const { stage: _, postEffects: _profiles, ...reference } = resource;
    return reference;
  };
  const assets = stageModels(positioned.assets, automatic);
  for (const kind of ["backgrounds", "stills"]) {
    const collection = assets[kind];
    if (Array.isArray(collection)) assets[kind] = collection.map((value) => bind(value)!);
    else if (collection && typeof collection === "object")
      assets[kind] = Object.fromEntries(Object.entries(collection).map(([key, value]) => [key, bind(value)!]));
  }
  const fields = (value: JsonObject, opcode = value.command): JsonObject => {
    const result = { ...value };
    if (
      opcode === VEGA_ADV_OPCODE.Focus &&
      result.cameraAnchor === undefined &&
      typeof result.targetName === "string" &&
      worldTargets.has(result.targetName)
    )
      result.cameraAnchor = "character";
    for (const key of ["background", "still"]) if (result[key]) result[key] = bind(result[key])!;
    const group = object(result.commandGroup);
    if (Array.isArray(group.actions))
      result.commandGroup = {
        ...group,
        actions: group.actions.map((value) => {
          const action = object(value);
          return { ...action, command: fields(object(action.command)) };
        }),
      };
    const timeline = object(result.timeline);
    if (Array.isArray(timeline.signals))
      result.timeline = {
        ...timeline,
        signals: timeline.signals.map((value) => {
          const signal = object(value);
          return { ...signal, episode: fields(object(signal.episode)) };
        }),
      };
    return result;
  };
  return {
    ...positioned,
    scenes: positioned.scenes.map((scene) => ({
      ...scene,
      extensions: (() => {
        const { presentationBaked, ...extensions } = scene.extensions;
        return presentationBaked === true
          ? {
              ...extensions,
              "haneoka.presentation": {
                cameraMode: "manual",
                ...object(extensions["haneoka.presentation"]),
              },
            }
          : extensions;
      })(),
      commands: scene.commands.map((command) => {
        const native = stageCommand(command, false, automatic);
        return { ...native, fields: fields(native.fields, native.command ?? undefined) };
      }),
    })),
    assets,
    runtime: {
      ...positioned.runtime,
      stage: {
        ...object(positioned.runtime.stage),
        ...ourNotesStage,
        ...(automatic ? { backgroundFit: "cover" } : {}),
      },
      stages,
      postEffects,
      presentation: { ...settings, version: 2, blocking: "native", stageVersion: 2 },
    },
  };
}

/** Derive runtime commands while retaining the original authoring project and source identities. */
export function prepareStoryPresentation(project: StoryProject): StoryProject {
  project = normalizeNativePresentation(project);
  const settings = object(project.runtime[PRESENTATION_KEY]);
  if (settings.mode !== "our-notes") return project;
  const bindings = object(settings.bindings),
    locale = project.meta.locale ?? "und";
  const transition =
    typeof settings.transitionSeconds === "number" ? Math.max(0, Math.min(2, settings.transitionSeconds)) : 0.35;
  const shot =
    typeof settings.cameraDistance === "number" ? Math.max(0, Math.min(6, Math.round(settings.cameraDistance))) : 2;
  const automaticBlocking = settings.blocking === "automatic";
  if (automaticBlocking) project = nativeBlocking(project);
  const inherited = entryCharacters(project);
  const atoms = project.scenes.flatMap((scene) => storyCommandAtoms(scene.commands));
  const sourceKeys = new Set(
    project.scenes
      .flatMap((scene) => [...scene.commands, ...storyCommandAtoms(scene.commands)])
      .map((command) => command.fields.key)
      .filter((key): key is string => typeof key === "string"),
  );
  const referencedKeys = new Set<string>();
  const references = (value: JsonValue): void => {
    if (typeof value === "string" && sourceKeys.has(value)) referencedKeys.add(value);
    else if (Array.isArray(value)) value.forEach(references);
    else if (value && typeof value === "object") Object.values(value).forEach(references);
  };
  for (const command of atoms)
    for (const [field, value] of Object.entries(command.fields)) if (field !== "key") references(value);
  const isEntry = (command: StoryProjectCommand) => {
    const key = command.fields.key;
    return typeof key === "string" && referencedKeys.has(key);
  };
  const normalizeCoordinates = false;
  const scenes = project.scenes.map((scene) => {
    const sceneSettings = object(scene.extensions["haneoka.presentation"]);
    const cameraMode =
      sceneSettings.cameraMode ?? (scene.extensions.presentationBaked === true ? "manual" : settings.cameraMode);
    if (!scene.commands.length)
      return {
        ...scene,
        commands: scene.commands.map((command) => stageCommand(command, normalizeCoordinates, automaticBlocking)),
      };
    const commands: StoryProjectCommand[] = [],
      shown = new Map(inherited.get(scene.id));
    let manualOwned = false,
      appliedShotId: string | undefined;
    const storyboard = planAutomaticStoryShots(scene, {
      bindings,
      visible: inherited.get(scene.id) ?? new Map(),
      locale,
      automatic: cameraMode !== "manual",
      entryKeys: referencedKeys,
      ...(typeof settings.cameraDistance === "number" ? { cameraDistance: shot } : {}),
      ...(typeof settings.transitionSeconds === "number" ? { transitionSeconds: transition } : {}),
    });
    const commandIndexes = new Map(scene.commands.map((command, index) => [command.id, index]));
    const shotAt = (index: number) =>
      storyboard.find((shot) => index >= commandIndexes.get(shot.start)! && index <= commandIndexes.get(shot.end)!);
    const ids = new Set([...scene.commands, ...storyCommandAtoms(scene.commands)].map((command) => command.id));
    const focus = (
      source: StoryProjectCommand,
      target: string,
      initial = false,
      authoredShot?: StoryShot,
    ): StoryProjectCommand => {
      let id = `presentation:${source.id}:${initial ? "wide" : "focus"}`;
      while (ids.has(id)) id += ".";
      ids.add(id);
      return {
        id,
        command: VEGA_ADV_OPCODE.Focus,
        fields: {
          targetName: target,
          cameraAnchor: "character",
          positionType: target ? (shown.get(target) ?? 5) : 5,
          cameraDistance: authoredShot?.cameraDistance ?? (target ? shot : 0),
          ...(authoredShot?.subjects?.length
            ? { focusTargets: [...authoredShot.subjects] }
            : authoredShot && ["wide", "two", "group"].includes(authoredShot.kind)
              ? { focusTargets: ["*"] }
              : {}),
          duration: initial || authoredShot?.transition === "cut" ? 0 : (authoredShot?.transitionSeconds ?? transition),
          params: ["", "6"],
          noWait: true,
          fallbackToWide: true,
          ...(source.fields.condition ? { condition: source.fields.condition } : {}),
          ...(source.fields.key && !initial ? { key: source.fields.key } : {}),
        },
        extensions: { [PRESENTATION_ORIGIN]: source.id },
      };
    };
    if (cameraMode !== "manual") commands.push(focus(scene.commands[0]!, "", true));
    const present = (original: StoryProjectCommand, authoredShot?: StoryShot): StoryProjectCommand[] => {
      const derived: StoryProjectCommand[] = [];
      let source = stageCommand(original, normalizeCoordinates, automaticBlocking);
      if (authoredShot && source.id === authoredShot.start) manualOwned = authoredShot.kind === "manual";
      const group = object(source.fields.commandGroup);
      if (Array.isArray(group.actions)) {
        const replacements = new Map<number, JsonValue[]>();
        const ordered = group.actions
          .map((value, index) => ({ action: object(value), index }))
          .sort((a, b) => Number(a.action.atSeconds ?? 0) - Number(b.action.atSeconds ?? 0) || a.index - b.index);
        for (const { action, index } of ordered) {
          const raw = object(action.command),
            code = raw.command;
          if (typeof code !== "number" && typeof code !== "string") continue;
          const { command: _, ...fields } = raw;
          const child: StoryProjectCommand = {
            id: typeof raw.commandId === "string" ? raw.commandId : `${source.id}/action/${index}`,
            command: code,
            fields,
            extensions: {},
          };
          replacements.set(
            index,
            present(child, authoredShot).map((command) => ({
              ...action,
              ...(command.extensions[PRESENTATION_ORIGIN] ? { role: "event" } : {}),
              command: { ...command.fields, command: command.command, commandId: command.id },
            })),
          );
        }
        return [
          {
            ...source,
            fields: {
              ...source.fields,
              commandGroup: {
                ...group,
                actions: group.actions.flatMap((action, index) => replacements.get(index) ?? [action]),
              },
            },
          },
        ];
      }

      if (
        authoredShot &&
        authoredShot.origin !== "automatic" &&
        authoredShot.kind !== "manual" &&
        manualCamera(source)
      ) {
        source = {
          ...source,
          command: VEGA_ADV_OPCODE.Delay,
          fields: {
            duration: 0,
            ...(source.fields.key ? { key: source.fields.key } : {}),
            ...(source.fields.condition ? { condition: source.fields.condition } : {}),
          },
        };
      }
      if (source.command === VEGA_ADV_OPCODE.In)
        for (const [target, position] of placements(source.fields)) shown.set(target, position);
      if (source.command === VEGA_ADV_OPCODE.Out) for (const target of targets(source.fields)) shown.delete(target);
      if (source.command === VEGA_ADV_OPCODE.MoveToDirection)
        for (const [target, position] of placements(source.fields)) if (shown.has(target)) shown.set(target, position);
      if (source.command === VEGA_ADV_OPCODE.Stage) manualOwned = false;
      if (manualCamera(source)) manualOwned = true;
      if (authoredShot && source.id === authoredShot.start) manualOwned = authoredShot.kind === "manual";
      if (
        authoredShot &&
        authoredShot.kind !== "manual" &&
        !manualOwned &&
        (appliedShotId !== authoredShot.id || isEntry(source))
      ) {
        const firstTalk = storyCommandAtoms(
          scene.commands.slice(commandIndexes.get(authoredShot.start), commandIndexes.get(authoredShot.end)! + 1),
        ).find((command) => command.command === VEGA_ADV_OPCODE.Talk);
        const speaker = firstTalk ? storySpeaker(firstTalk, bindings) : "";
        const target =
          authoredShot.kind === "wide" || authoredShot.kind === "two" || authoredShot.kind === "group"
            ? ""
            : authoredShot.targetName ||
              (authoredShot.subjects?.length === 1 ? authoredShot.subjects[0] : "") ||
              (authoredShot.kind === "reaction"
                ? ([...shown.keys()].find((target) => target !== speaker) ?? "")
                : speaker);
        if (
          source.command === VEGA_ADV_OPCODE.In &&
          (!authoredShot.subjects?.length || authoredShot.subjects.every((name) => shown.has(name)))
        ) {
          const entryFocus = focus(source, shown.has(target) ? target : "", false, authoredShot);
          const { key: _entryKey, ...fields } = entryFocus.fields;
          return [source, { ...entryFocus, fields }];
        }
        if (
          !firstTalk ||
          source.command === VEGA_ADV_OPCODE.Talk ||
          source.command === VEGA_ADV_OPCODE.ChoiceShow ||
          source.command === VEGA_SYSTEM_OPCODE.Input
        ) {
          derived.push(focus(source, shown.has(target) ? target : "", false, authoredShot));
          appliedShotId = authoredShot.id;
          const { key: _, ...fields } = source.fields;
          derived.push({ ...source, fields });
          return derived;
        }
      }
      derived.push(source);
      return derived;
    };
    for (const [index, source] of scene.commands.entries()) commands.push(...present(source, shotAt(index)));
    return {
      ...scene,
      commands,
      extensions: {
        ...scene.extensions,
        [STORYBOARD_KEY]: { version: 1, automatic: true, shots: storyboard as unknown as JsonValue[] },
      },
    };
  });
  return {
    ...project,
    scenes,
    assets: stageModels(project.assets, automaticBlocking),
    runtime: {
      ...project.runtime,
      stage: {
        ...object(project.runtime.stage),
        ...ourNotesStage,
        ...(automaticBlocking ? { backgroundFit: "cover" } : {}),
      },
      ...(automaticBlocking
        ? {
            stages: Object.fromEntries(
              Object.entries(object(project.runtime.stages)).map(([id, stage]) => [id, nativeStage(stage)]),
            ),
          }
        : {}),
      presentation: { ...settings, mode: "our-notes", version: 2 },
      layout: {
        ...object(project.runtime.layout),
        designViewportAspect: 13 / 6,
        landscapeTargetAspect: 13 / 6,
        portraitTargetAspect: 16 / 9,
      },
    },
  };
}
