import { VEGA_SYSTEM_OPCODE, VEGA_ADV_OPCODE } from "@haneoka/vega-protocol";
import { type JsonObject, type JsonValue, type StoryScene, type StoryProjectCommand } from "@haneoka/altair/model";

export const STORYBOARD_KEY = "haneoka.storyboard";
export type StoryShotKind = "speaker" | "reaction" | "wide" | "two" | "group" | "manual";
export type StoryIntent = "dialogue" | "quiet" | "conflict" | "ensemble";
export interface StoryShot {
  readonly id: string;
  readonly start: string;
  readonly end: string;
  readonly kind: StoryShotKind;
  readonly targetName?: string;
  readonly subjects?: readonly string[];
  readonly origin?: "author" | "automatic";
  readonly transition?: "cut" | "glide";
  readonly cameraDistance?: number;
  readonly transitionSeconds?: number;
  readonly locked?: boolean;
  readonly intent?: StoryIntent;
}
export interface StoryboardIssue {
  readonly shotId: string;
  readonly message: string;
}
const record = (value: JsonValue | undefined): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
export function sceneStoryboard(scene: Pick<StoryScene, "extensions">): readonly StoryShot[] {
  const value = record(scene.extensions[STORYBOARD_KEY]);
  return Array.isArray(value.shots) ? (value.shots as unknown as readonly StoryShot[]) : [];
}
export function validateStoryboard(scene: StoryScene): readonly StoryboardIssue[] {
  const ids = new Map(scene.commands.map((command, index) => [command.id, index]));
  const occupied = new Set<number>(),
    shotIds = new Set<string>(),
    issues: StoryboardIssue[] = [];
  for (const shot of sceneStoryboard(scene)) {
    if (!shot || typeof shot !== "object") {
      issues.push({ shotId: "", message: "Invalid shot" });
      continue;
    }
    const start = ids.get(shot.start),
      end = ids.get(shot.end);
    let message = "";
    if (!shot.id || shotIds.has(shot.id)) message = "Duplicate shot identity";
    else if (start === undefined || end === undefined || end < start) message = "Shot range no longer exists";
    else if (!["speaker", "reaction", "wide", "two", "group", "manual"].includes(shot.kind))
      message = "Invalid shot kind";
    else if (
      shot.subjects !== undefined &&
      (!Array.isArray(shot.subjects) ||
        shot.subjects.some((subject) => typeof subject !== "string" || !subject) ||
        new Set(shot.subjects).size !== shot.subjects.length)
    )
      message = "Invalid shot";
    else if (shot.transition !== undefined && !["cut", "glide"].includes(shot.transition))
      message = "Invalid shot transition";
    else if (shot.origin !== undefined && !["author", "automatic"].includes(shot.origin)) message = "Invalid shot";
    else if (
      shot.cameraDistance !== undefined &&
      (!Number.isInteger(shot.cameraDistance) || shot.cameraDistance < 0 || shot.cameraDistance > 6)
    )
      message = "Invalid shot distance";
    else if (
      shot.transitionSeconds !== undefined &&
      (!Number.isFinite(shot.transitionSeconds) || shot.transitionSeconds < 0 || shot.transitionSeconds > 2)
    )
      message = "Invalid shot transition";
    else
      for (let index = start; index <= end; index++) {
        if (occupied.has(index)) {
          message = "Shot ranges overlap";
          break;
        }
        occupied.add(index);
      }
    shotIds.add(shot.id);
    if (message) issues.push({ shotId: shot.id, message });
  }
  return issues;
}
export function storyCommandAtoms(commands: readonly StoryProjectCommand[]): StoryProjectCommand[] {
  return commands.flatMap((command) => {
    const group = record(command.fields.commandGroup);
    if (!Array.isArray(group.actions)) return [command];
    const children = group.actions
      .map((value, index) => ({ action: record(value), index }))
      .sort((a, b) => Number(a.action.atSeconds ?? 0) - Number(b.action.atSeconds ?? 0) || a.index - b.index)
      .flatMap(({ action, index }) => {
        const raw = record(action.command),
          code = raw.command;
        if (typeof code !== "number" && typeof code !== "string") return [];
        const { command: _, ...fields } = raw;
        return [
          {
            id: typeof raw.commandId === "string" ? raw.commandId : `${command.id}/action/${index}`,
            command: code,
            fields,
            extensions: {},
          },
        ];
      });
    return storyCommandAtoms(children);
  });
}

export const storySpeaker = (command: StoryProjectCommand, bindings: JsonObject = {}): string => {
  const fields = command.fields;
  const names = Array.isArray(fields.targetTextNames) ? fields.targetTextNames : [];
  if (names.length > 1) return "";
  const name = names.length === 1 ? names[0] : fields.targetName;
  const speaker =
    typeof name === "string" ? name : (Object.values(record(name)).find((value) => typeof value === "string") ?? "");
  if (typeof bindings[speaker] === "string" && bindings[speaker]) return bindings[speaker] as string;
  const direct =
    Array.isArray(fields.lipSyncTargets) && fields.lipSyncTargets.length
      ? fields.lipSyncTargets
      : Array.isArray(fields.targets)
        ? fields.targets
            .map((value) => record(value).target ?? record(value).targetName)
            .filter((value) => typeof value === "string")
        : [];
  return direct.length === 1 && typeof direct[0] === "string" ? direct[0] : speaker;
};

export interface StoryShotPlannerOptions {
  readonly bindings?: JsonObject;
  readonly visible?: ReadonlyMap<string, number>;
  readonly worldPositions?: ReadonlyMap<string, number>;
  readonly cameraDistance?: number;
  readonly transitionSeconds?: number;
  readonly intent?: StoryIntent;
  readonly locale?: string;
  readonly automatic?: boolean;
  readonly entryKeys?: ReadonlySet<string>;
}

export function isStoryCameraCommand(command: StoryProjectCommand): boolean {
  const fields = command.fields;
  if (
    [
      VEGA_ADV_OPCODE.Focus,
      VEGA_ADV_OPCODE.Pan,
      VEGA_ADV_OPCODE.PanV2,
      VEGA_ADV_OPCODE.Tilt,
      VEGA_ADV_OPCODE.Pedestal,
      VEGA_ADV_OPCODE.Track,
      VEGA_ADV_OPCODE.Zoom,
    ].some((opcode) => opcode === command.command)
  )
    return true;
  if (command.command === "haneoka.webgal-runtime:stageTransform@1") return true;
  if (command.command === "haneoka.vega-core:propertyClip@1")
    return fields.target === "scene-camera" && fields.reset !== true;
  return (
    fields.targetName === "stage-main" &&
    (Object.keys(record(fields.transform)).length > 0 || (Array.isArray(fields.frames) && fields.frames.length > 0))
  );
}

interface StoryBeat {
  readonly root: StoryProjectCommand;
  readonly cast: ReadonlyMap<string, number>;
  readonly speakers: readonly string[];
  readonly duration: number;
  readonly boundary: boolean;
  readonly layoutChanged: boolean;
  readonly choice: boolean;
  readonly dialogue: boolean;
  readonly camera: boolean;
}
const targetRows = (fields: JsonObject): JsonObject[] =>
  Array.isArray(fields.targets) && fields.targets.length
    ? fields.targets.map(record)
    : [{ target: fields.targetName ?? "", positionType: fields.positionType ?? null }];
function storyBeats(scene: StoryScene, options: StoryShotPlannerOptions): StoryBeat[] {
  const slots = new Map(options.visible),
    visible = new Map(options.visible),
    world = new Map(options.worldPositions);
  const localized = (value: JsonValue | undefined): string => {
    if (typeof value === "string") return value;
    const values = record(value);
    return String(
      (options.locale ? values[options.locale] : undefined) ??
        Object.values(values).find((v) => typeof v === "string" && v) ??
        "",
    );
  };
  const cast = () => new Map([...visible].map(([name, slot]) => [name, world.get(name) ?? (slot - 5) * 0.4]));
  return scene.commands.map((root) => {
    const previous = cast(),
      speakers: string[] = [];
    let talkingCast: Map<string, number> | undefined,
      duration = 0,
      boundary = false,
      choice = false,
      camera = false,
      dialogue = false;
    for (const command of storyCommandAtoms([root])) {
      const fields = command.fields;
      if (command.command === VEGA_ADV_OPCODE.Stage) boundary = true;
      if (options.entryKeys?.has(String(fields.key))) boundary = true;
      if (
        [VEGA_ADV_OPCODE.Character, VEGA_ADV_OPCODE.In, VEGA_ADV_OPCODE.MoveToDirection].some(
          (opcode) => opcode === command.command,
        )
      ) {
        for (const row of targetRows(fields)) {
          const name = row.target ?? row.targetName;
          if (typeof name !== "string" || !name) continue;
          const slot = Number(row.positionType ?? fields.positionType ?? slots.get(name) ?? 5);
          slots.set(name, slot);
          const point = record(row.characterWorldPosition ?? fields.characterWorldPosition);
          if (typeof point.x === "number") world.set(name, point.x);
          if (command.command === VEGA_ADV_OPCODE.In || visible.has(name)) visible.set(name, slot);
        }
      }
      if (command.command === VEGA_ADV_OPCODE.Out)
        for (const row of targetRows(fields)) {
          const name = row.target ?? row.targetName;
          if (typeof name === "string") visible.delete(name);
        }
      if (command.command === VEGA_ADV_OPCODE.Delay) duration = Math.max(duration, Number(fields.duration) || 0);
      if (command.command === VEGA_ADV_OPCODE.ChoiceShow || command.command === VEGA_SYSTEM_OPCODE.Input) choice = true;
      camera ||= isStoryCameraCommand(command);
      if (command.command === VEGA_ADV_OPCODE.Talk) {
        dialogue = true;
        talkingCast ??= cast();
        const speaker = storySpeaker(command, options.bindings);
        if (speaker) speakers.push(speaker);
        else if (Array.isArray(fields.targetTextNames) && fields.targetTextNames.length > 1) {
          const simultaneous = Array.isArray(fields.lipSyncTargets)
            ? fields.lipSyncTargets
            : targetRows(fields).map((row) => row.target ?? row.targetName);
          for (const target of simultaneous)
            if (typeof target === "string" && visible.has(target)) speakers.push(target);
        }
        const voices = Array.isArray(fields.voices) ? fields.voices.map(record) : [];
        const voiceSeconds = Math.max(
          0,
          ...voices.map((voice) => {
            const runtime = record(voice.runtime);
            return (
              Number(
                voice.durationSeconds ??
                  runtime.durationSeconds ??
                  Number(voice.durationMs ?? runtime.durationMs ?? 0) / 1000,
              ) || 0
            );
          }),
        );
        const letters = Array.from(localized(fields.text).replace(/<[^>]*>|\[[^\]]*\]/gu, "")).length;
        duration += Math.max(voiceSeconds, Math.max(2, Math.min(10, letters / 8 + 1.2)));
      }
    }
    const view = talkingCast ?? cast();
    const oldOrder = [...previous]
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name)
      .join("\0");
    const newOrder = [...view]
      .sort((a, b) => a[1] - b[1])
      .map(([name]) => name)
      .join("\0");
    const moved = [...view].some(([name, x]) => previous.has(name) && Math.abs(previous.get(name)! - x) > 0.5);
    return {
      root,
      cast: view,
      speakers: [...new Set(speakers)],
      duration,
      boundary,
      layoutChanged: oldOrder !== newOrder || moved,
      choice,
      dialogue,
      camera,
    };
  });
}

/** One deterministic planner owns whole-scene, selected-range and compiler coverage. */
export function planAutomaticStoryShots(
  scene: StoryScene,
  options: StoryShotPlannerOptions = {},
): readonly StoryShot[] {
  const beats = storyBeats(scene, options),
    indexes = new Map(scene.commands.map((c, i) => [c.id, i]));
  const invalid = new Set(validateStoryboard(scene).map((issue) => issue.shotId));
  const authored = sceneStoryboard(scene).filter((shot) => shot && !invalid.has(shot.id));
  const fixed = new Map<number, StoryShot>();
  for (const shot of authored)
    for (let i = indexes.get(shot.start)!; i <= indexes.get(shot.end)!; i++) fixed.set(i, shot);
  const shots: StoryShot[] = [];
  const sceneSettings = record(scene.extensions["haneoka.presentation"]);
  const intent = options.intent ?? (sceneSettings.intent as StoryIntent | undefined) ?? "dialogue";
  const hold = intent === "quiet" ? 4 : intent === "conflict" ? 1.8 : intent === "ensemble" ? 3.5 : 2.5;
  let current: StoryShot | undefined,
    elapsed = 0,
    started = 0,
    establishing = true,
    nativeOwned = false;
  let lastSpeaker = "",
    runSeconds = 0,
    runLines = 0,
    reactionUsed = false,
    pushed = false,
    turns = 0;
  const recent: string[] = [];
  const subjects = (shot: StoryShot | undefined) => shot?.subjects ?? (shot?.targetName ? [shot.targetName] : []);
  const start = (index: number, kind: StoryShotKind, names: readonly string[], distance: number, glide = false) => {
    const root = beats[index]!.root;
    current = {
      id: `auto:${scene.id}:${root.id}`,
      start: root.id,
      end: root.id,
      kind,
      origin: "automatic",
      ...(names.length ? { subjects: [...names] } : {}),
      ...(names.length === 1 ? { targetName: names[0] } : {}),
      cameraDistance: distance,
      transition: glide ? "glide" : "cut",
      transitionSeconds: glide ? (options.transitionSeconds ?? (intent === "quiet" ? 0.8 : 0.65)) : 0,
      intent,
    };
    shots.push(current);
    started = elapsed;
  };
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]!,
      island = fixed.get(i);
    if (beat.boundary) {
      nativeOwned = false;
      establishing = true;
      turns = 0;
      lastSpeaker = "";
      runSeconds = 0;
      runLines = 0;
      reactionUsed = false;
      pushed = false;
    }
    if (beat.camera) nativeOwned = true;
    const speaker = beat.speakers.length === 1 && beat.cast.has(beat.speakers[0]!) ? beat.speakers[0]! : "";
    if (beat.dialogue && speaker) {
      if (lastSpeaker !== speaker) {
        if (lastSpeaker) turns++;
        runSeconds = 0;
        runLines = 0;
        reactionUsed = false;
        pushed = false;
      }
    }
    if (island) {
      if (current?.id !== island.id) {
        shots.push(island);
        current = island;
        started = elapsed;
      }
    } else if (nativeOwned || options.automatic === false) {
      if (beat.camera || current?.kind !== "manual" || current.origin !== "automatic") start(i, "manual", [], 0);
      else {
        current = { ...current, end: beat.root.id };
        shots[shots.length - 1] = current;
      }
    } else {
      const names = [...beat.cast].sort((a, b) => a[1] - b[1]).map(([name]) => name);
      const coverage = (): [StoryShotKind, readonly string[], number] =>
        names.length === 2
          ? ["two", names, 1]
          : names.length > 2
            ? ["group", names, 0]
            : names.length === 1
              ? ["speaker", names, 1]
              : ["wide", [], 0];
      let [kind, targets, distance] = coverage();
      let pushIn = false;
      const age = elapsed - started,
        oldSubjects = subjects(current),
        missing = oldSubjects.some((name) => !beat.cast.has(name));
      const group = beat.speakers.length > 1 || names.length > 2;
      const future = beats[i + 1],
        nextSpeaker = future?.speakers.length === 1 ? future.speakers[0] : "";
      if (beat.choice) {
        kind = "wide";
        targets = names;
        distance = 0;
      } else if (speaker && !establishing && !beat.layoutChanged && !beat.boundary) {
        const sustained = runLines > 0 || beat.duration >= 7;
        if (
          (!group && (names.length < 2 || turns >= 2 || runSeconds >= 5)) ||
          (group && sustained && intent !== "ensemble")
        ) {
          kind = "speaker";
          targets = [speaker];
          distance = options.cameraDistance ?? 2;
          if (runSeconds >= 12 && !pushed && current?.targetName === speaker) {
            distance = Math.min(4, (current.cameraDistance ?? distance) + 1);
            pushIn = true;
          } else if (pushed && current?.targetName === speaker) distance = current.cameraDistance ?? distance;
          const listener =
            recent.find((name) => name !== speaker && beat.cast.has(name)) ??
            names
              .filter((name) => name !== speaker)
              .sort(
                (a, b) =>
                  Math.abs(beat.cast.get(a)! - beat.cast.get(speaker)!) -
                  Math.abs(beat.cast.get(b)! - beat.cast.get(speaker)!),
              )[0];
          if (
            listener &&
            !reactionUsed &&
            runLines >= 1 &&
            runSeconds >= 3 &&
            nextSpeaker === speaker &&
            (runSeconds + beat.duration + (future?.duration ?? 0) >= 10 || runLines >= 2)
          ) {
            kind = "reaction";
            targets = [listener];
            distance = 3;
          }
        }
      } else if (!speaker && beat.dialogue && current && !missing && (age < hold || beat.speakers.length === 1)) {
        kind = current.kind;
        targets = oldSubjects;
        distance = current.cameraDistance ?? 0;
      }
      if (!beat.dialogue && !beat.boundary && !beat.choice && current && (!beat.layoutChanged || !names.length)) {
        kind = current.kind;
        targets = oldSubjects;
        distance = current.cameraDistance ?? 0;
      }
      if (beat.dialogue && runSeconds >= 20 && names.length > 1) [kind, targets, distance] = coverage();
      const changed =
        !current ||
        current.kind !== kind ||
        subjects(current).join("\0") !== targets.join("\0") ||
        current.cameraDistance !== distance;
      const force =
        beat.boundary ||
        (beat.layoutChanged && names.length > 0) ||
        beat.choice ||
        (missing && names.length > 0) ||
        current?.kind === "manual" ||
        (beat.speakers.length > 1 && beat.speakers.some((name) => beat.cast.has(name) && !oldSubjects.includes(name)));
      if (!current || force || (changed && age >= hold)) {
        const glide = Boolean(
          current &&
          !force &&
          targets.length &&
          targets.some((name) => oldSubjects.includes(name)) &&
          current.kind !== "reaction" &&
          kind !== "reaction",
        );
        start(i, kind, targets, distance, glide);
        if (kind === "reaction") reactionUsed = true;
        if (pushIn && kind === "speaker") pushed = true;
      }
      if (current) {
        current = { ...current, end: beat.root.id };
        shots[shots.length - 1] = current;
      }
    }
    elapsed += beat.duration;
    if (beat.dialogue && speaker) {
      runSeconds += beat.duration;
      runLines++;
      lastSpeaker = speaker;
      const at = recent.indexOf(speaker);
      if (at >= 0) recent.splice(at, 1);
      recent.unshift(speaker);
    } else if (beat.dialogue || beat.choice) {
      lastSpeaker = "";
      runSeconds = 0;
      runLines = 0;
      reactionUsed = false;
      pushed = false;
      turns = 0;
    }
    if (beat.dialogue && elapsed - started >= hold) establishing = false;
  }
  return shots;
}

/** Retain both outside pieces when a selected range overlaps an editable author shot. */
export function storyShotsOutsideRange(scene: StoryScene, start: number, end: number): readonly StoryShot[] {
  const indexes = new Map(scene.commands.map((command, i) => [command.id, i]));
  return sceneStoryboard(scene).flatMap((shot) => {
    const head = indexes.get(shot.start),
      tail = indexes.get(shot.end);
    if (head === undefined || tail === undefined || shot.locked || tail < start || head > end) return [shot];
    const parts: StoryShot[] = [];
    if (head < start) parts.push({ ...shot, end: scene.commands[start - 1]!.id });
    if (tail > end)
      parts.push({
        ...shot,
        id: head < start ? `${shot.id}:tail:${scene.commands[end + 1]!.id}` : shot.id,
        start: scene.commands[end + 1]!.id,
      });
    return parts;
  });
}

export function planStoryShots(
  scene: StoryScene,
  options: StoryShotPlannerOptions & {
    readonly start: string;
    readonly end: string;
    readonly intent: StoryIntent;
  },
): readonly StoryShot[] {
  const indexes = new Map(scene.commands.map((command, i) => [command.id, i]));
  const start = indexes.get(options.start),
    end = indexes.get(options.end);
  if (start === undefined || end === undefined || end < start) throw new RangeError("Shot range no longer exists");
  const kept = storyShotsOutsideRange(scene, start, end);
  const candidate = {
    ...scene,
    extensions: { ...scene.extensions, [STORYBOARD_KEY]: { version: 1, shots: kept as unknown as JsonValue[] } },
  };
  const planned = planAutomaticStoryShots(candidate, options)
    .filter((shot) => shot.origin === "automatic")
    .flatMap((shot) => {
      const head = Math.max(start, indexes.get(shot.start)!),
        tail = Math.min(end, indexes.get(shot.end)!);
      return tail < head
        ? []
        : [
            {
              ...shot,
              id: `auto:${scene.id}:${scene.commands[head]!.id}`,
              start: scene.commands[head]!.id,
              end: scene.commands[tail]!.id,
              origin: "author" as const,
            },
          ];
    });
  return [...kept, ...planned].sort((a, b) => (indexes.get(a.start) ?? 0) - (indexes.get(b.start) ?? 0));
}

/** Re-anchor author ranges inside the same edit transaction as their scene. */
export function reanchorStoryShots(
  before: readonly string[],
  after: readonly string[],
  extensions: JsonObject,
): JsonObject {
  const story = record(extensions[STORYBOARD_KEY]);
  if (!Array.isArray(story.shots)) return extensions;
  const nextIndexes = new Map(after.map((id, i) => [id, i]));
  const shots = story.shots.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
    const shot = value as unknown as StoryShot,
      head = before.indexOf(shot.start),
      tail = before.indexOf(shot.end);
    if (
      head < 0 ||
      tail < head ||
      (nextIndexes.has(shot.start) &&
        nextIndexes.has(shot.end) &&
        nextIndexes.get(shot.start)! <= nextIndexes.get(shot.end)!)
    )
      return [value];
    const surviving = before
      .slice(head, tail + 1)
      .filter((id) => nextIndexes.has(id))
      .sort((a, b) => nextIndexes.get(a)! - nextIndexes.get(b)!);
    return surviving.length ? [{ ...record(value), start: surviving[0]!, end: surviving[surviving.length - 1]! }] : [];
  });
  return JSON.stringify(shots) === JSON.stringify(story.shots)
    ? extensions
    : { ...extensions, [STORYBOARD_KEY]: { ...story, shots } };
}
