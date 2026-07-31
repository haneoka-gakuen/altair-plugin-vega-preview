import {
  cloneStoryValue,
} from "@haneoka/altair/model";
import type {
  AltairCompilerPassContribution,
  AltairCompilerPassRequest,
  AltairCompilerPassResult,
  AltairOperationContext,
} from "@haneoka/altair/plugins";
import {
  compileStoryProjectForVegaPreview,
  compileVegaProjectWithDiagnostics,
  type AltairAdvCompiler,
  type CompileVegaPreviewStoryResult,
  type CompileVegaProjectResult,
  type StoryDiagnostic,
} from "./projection.js";
import {
  altairAdvService,
} from "@haneoka/altair-plugin-adv/services";
import {
  ALTAIR_VEGA_COMPILER_ID,
  ALTAIR_VEGA_PREVIEW_SERVICE,
  type AltairVegaCompiledScene,
  type AltairVegaCompileRequest,
  type AltairVegaCompileProjectRequest,
} from "./contracts.js";

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ??
  new DOMException("Altair Vega compilation aborted", "AbortError");

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw abortReason(signal);
};

export const compileVegaScene = async (
  request: AltairVegaCompileRequest,
  compiler: AltairAdvCompiler = altairAdvService,
): Promise<AltairVegaCompiledScene> => {
  throwIfAborted(request.signal);
  const compiled = compiler.compile(
    request.project,
    request.sceneId ?? request.project.entrySceneId,
  );
  throwIfAborted(request.signal);
  return Object.freeze({
    story: Object.freeze(
      cloneStoryValue(compiled.story),
    ) as AltairVegaCompiledScene["story"],
    diagnostics: Object.freeze(
      cloneStoryValue(compiled.diagnostics),
    ),
    sceneId: compiled.sceneId,
    commandSourceIndexes: Object.freeze([
      ...compiled.commandSourceIndexes,
    ]),
  });
};

export const compileAltairVegaProject = async (
  request: AltairVegaCompileProjectRequest,
  compiler: AltairAdvCompiler = altairAdvService,
): Promise<CompileVegaProjectResult> => {
  throwIfAborted(request.signal);
  const compiled = compileVegaProjectWithDiagnostics(
    request.project,
    request.options,
    compiler,
  );
  throwIfAborted(request.signal);
  return Object.freeze(
    cloneStoryValue(compiled),
  ) as CompileVegaProjectResult;
};

export const compileAltairVegaPreviewStory = async (
  request: AltairVegaCompileRequest,
  compiler: AltairAdvCompiler = altairAdvService,
): Promise<CompileVegaPreviewStoryResult> => {
  throwIfAborted(request.signal);
  const compiled = compileStoryProjectForVegaPreview(
    request.project,
    request.sceneId,
    compiler,
  );
  throwIfAborted(request.signal);
  return Object.freeze(
    cloneStoryValue(compiled),
  ) as CompileVegaPreviewStoryResult;
};

const diagnosticsForCommand = (
  diagnostics: readonly StoryDiagnostic[],
  sceneIndex: number,
  commandIndex: number,
): readonly StoryDiagnostic[] => {
  const scenePrefix = `$.scenes[${sceneIndex}]`;
  const commandPrefix = `${scenePrefix}.commands[${commandIndex}]`;
  const anyCommandPrefix = `${scenePrefix}.commands[`;
  return diagnostics.filter(
    ({ path }) =>
      path === commandPrefix ||
      path.startsWith(`${commandPrefix}.`) ||
      (commandIndex === 0 && !path.startsWith(anyCommandPrefix)),
  );
};

const compileCommand = async (
  request: AltairCompilerPassRequest & { readonly signal: AbortSignal },
  context: AltairOperationContext,
): Promise<AltairCompilerPassResult> => {
  const service = context.service(ALTAIR_VEGA_PREVIEW_SERVICE);
  if (!service) {
    throw new ReferenceError("Altair Vega preview service is unavailable");
  }
  const project = cloneStoryValue(request.project);
  const sceneIndex = project.scenes.findIndex(
    ({ id }) => id === request.sceneId,
  );
  const scene = project.scenes[sceneIndex];
  if (!scene) {
    throw new RangeError(`Unknown Altair scene: ${request.sceneId}`);
  }
  scene.commands[request.commandIndex] = cloneStoryValue(request.command);
  const compiled = await service.compileScene({
    project,
    sceneId: request.sceneId,
    signal: request.signal,
  });
  const compiledIndex = compiled.commandSourceIndexes.indexOf(
    request.commandIndex,
  );
  const nativeCommand =
    compiledIndex < 0 ? undefined : compiled.story.commands[compiledIndex];
  const output =
    nativeCommand === undefined
      ? request.output ?? null
      : {
          ...cloneStoryValue(nativeCommand),
          ...(request.output ? cloneStoryValue(request.output) : {}),
        };
  const diagnostics =
    nativeCommand === undefined && request.output === null
      ? []
      : diagnosticsForCommand(
          compiled.diagnostics,
          sceneIndex,
          request.commandIndex,
        );
  return {
    output,
    diagnostics,
  };
};

export const vegaCompilerContribution: AltairCompilerPassContribution =
  Object.freeze({
    id: ALTAIR_VEGA_COMPILER_ID,
    name: "Vega ADV compiler",
    order: 10_000,
    apply: compileCommand,
  });
