import { cloneStoryValue, type JsonObject, type JsonValue } from "@haneoka/altair/model";
import type { AltairPreviewRequest, AltairPreviewSession } from "@haneoka/altair/plugins";
import { AltairPreviewClient } from "@haneoka/altair-preview-client";
import { altairAdvService } from "@haneoka/altair-plugin-adv/services";
import { VegaEngine, type VegaPlugin } from "@haneoka/vega/engine";
import { VegaPreviewRuntime } from "@haneoka/vega/preview";
import {
  VEGA_PREVIEW_PROTOCOL,
  isVegaPreviewIdentity,
  isVegaPreviewRequest,
  type VegaPreviewCapabilities,
  type VegaPreviewCommand,
  type VegaPreviewIdentity,
} from "@haneoka/vega-protocol";
import { compileAltairVegaPreviewStory, compileAltairVegaProject, compileVegaScene } from "./compiler.js";
import type { AltairAdvCompiler } from "./projection.js";
import {
  ALTAIR_VEGA_PREVIEW_DEFAULT_MOUNT,
  type AltairVegaCompiledScene,
  type AltairVegaPreviewOptions,
  type AltairVegaPreviewPluginOptions,
  type AltairVegaRuntimeProfile,
  type AltairVegaPreviewService,
  type AltairVegaRuntimeFactoryContext,
  type AltairVegaRuntimeHandle,
} from "./contracts.js";

const DEFAULT_TIMEOUT_MS = 8_000;

interface NormalizedOptions {
  readonly defaultMountId: string;
  readonly timeoutMs: number;
  readonly officialPlugins: readonly VegaPlugin[];
  readonly plugins: readonly VegaPlugin[];
  readonly theme?: string | false;
  readonly renderBackend?: string;
  readonly createRuntime: (
    context: AltairVegaRuntimeFactoryContext,
  ) => AltairVegaRuntimeHandle | Promise<AltairVegaRuntimeHandle>;
  readonly createIdentity: (request: AltairPreviewRequest, sequence: number) => VegaPreviewIdentity;
  readonly onBackgroundError?: (error: unknown) => void;
}

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("Altair Vega preview aborted", "AbortError");

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted) throw abortReason(signal);
};

const reportBackgroundError = (handler: ((error: unknown) => void) | undefined, error: unknown): void => {
  try {
    handler?.(error);
  } catch {
    // Error reporting must never create another unhandled background failure.
  }
};

const nonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value.trim();
};

const themeSelector = (value: unknown, label: string): string | false =>
  value === false ? false : nonEmpty(value, label);

const positiveInteger = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return Number(value);
};

const commandIndex = (value: unknown, label: string): number => {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return Number(value);
};

const defaultIdentity = (request: AltairPreviewRequest, sequence: number): VegaPreviewIdentity => {
  const title = request.project?.meta.title ?? "project";
  const projectId =
    title
      .normalize("NFKC")
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  return {
    workspaceId: "altair",
    projectId,
    editorSessionId: `editor-${sequence}`,
    runtimeInstanceId: `vega-preview-${sequence}`,
  };
};

const disposeAll = async (
  resources: readonly {
    readonly label: string;
    dispose(): void | Promise<void>;
  }[],
  message: string,
): Promise<void> => {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      await resource.dispose();
    } catch (error) {
      errors.push(new Error(`Failed to dispose ${resource.label}`, { cause: error }));
    }
  }
  if (errors.length) throw new AggregateError(errors, message);
};

const defaultRuntimeFactory = (options: AltairVegaPreviewPluginOptions): NormalizedOptions["createRuntime"] => {
  const createEngine =
    options.createEngine ??
    (({
      identity,
      officialPlugins,
      plugins,
    }: {
      readonly identity: VegaPreviewIdentity;
      readonly officialPlugins: readonly VegaPlugin[];
      readonly plugins: readonly VegaPlugin[];
      readonly renderBackend?: string;
    }) =>
      new VegaEngine({
        id: identity.runtimeInstanceId,
        officialPlugins,
        plugins,
      }));
  return async (context) => {
    throwIfAborted(context.signal);
    let engine: VegaEngine | undefined;
    try {
      engine = await createEngine({
        identity: context.identity,
        signal: context.signal,
        officialPlugins: context.officialPlugins,
        plugins: context.plugins,
        ...(context.renderBackend ? { renderBackend: context.renderBackend } : {}),
      });
      throwIfAborted(context.signal);
      const runtime = new VegaPreviewRuntime({
        identity: context.identity,
        mount: context.mount,
        port: context.port,
        engine,
        ...(context.theme === undefined ? {} : { theme: context.theme }),
        ...(context.renderBackend ? { renderBackend: context.renderBackend } : {}),
      });
      let disposal: Promise<void> | undefined;
      return {
        start: () => runtime.start(),
        dispose() {
          disposal ??= disposeAll(
            [
              {
                label: "Vega preview runtime",
                dispose: () => runtime.dispose(),
              },
              { label: "Vega engine", dispose: () => engine!.dispose() },
            ],
            "Failed to dispose the Altair Vega runtime",
          );
          return disposal;
        },
      };
    } catch (error) {
      if (engine) {
        try {
          await engine.dispose();
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Failed to initialize and dispose the Vega engine");
        }
      }
      throw error;
    }
  };
};

const normalizeOptions = (options: AltairVegaPreviewPluginOptions): NormalizedOptions => {
  const defaultMountId = nonEmpty(
    options.defaultMountId ?? ALTAIR_VEGA_PREVIEW_DEFAULT_MOUNT,
    "Altair Vega default mount id",
  );
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "Altair Vega preview timeout");
  if (options.createRuntime !== undefined && typeof options.createRuntime !== "function") {
    throw new TypeError("Altair Vega createRuntime must be a function");
  }
  if (options.createEngine !== undefined && typeof options.createEngine !== "function") {
    throw new TypeError("Altair Vega createEngine must be a function");
  }
  if (options.createIdentity !== undefined && typeof options.createIdentity !== "function") {
    throw new TypeError("Altair Vega createIdentity must be a function");
  }
  if (options.onBackgroundError !== undefined && typeof options.onBackgroundError !== "function") {
    throw new TypeError("Altair Vega onBackgroundError must be a function");
  }
  const renderBackend =
    options.renderBackend === undefined ? undefined : nonEmpty(options.renderBackend, "Altair Vega renderBackend");
  const theme = options.theme === undefined ? undefined : themeSelector(options.theme, "Altair Vega theme");
  return Object.freeze({
    defaultMountId,
    timeoutMs,
    officialPlugins: Object.freeze([...(options.officialPlugins ?? [])]),
    plugins: Object.freeze([...(options.plugins ?? [])]),
    ...(theme === undefined ? {} : { theme }),
    ...(renderBackend ? { renderBackend } : {}),
    createRuntime: options.createRuntime ?? defaultRuntimeFactory(options),
    createIdentity: options.createIdentity ?? defaultIdentity,
    ...(options.onBackgroundError ? { onBackgroundError: options.onBackgroundError } : {}),
  });
};

const parsePreviewOptions = (
  value: JsonObject | undefined,
  defaults: NormalizedOptions,
): Required<Pick<AltairVegaPreviewOptions, "mountId" | "autoSync">> &
  Pick<AltairVegaPreviewOptions, "sceneId" | "sceneRevision" | "commandIndex" | "runtimeProfileId"> => {
  const options = value ?? {};
  const mountId =
    options.mountId === undefined ? defaults.defaultMountId : nonEmpty(options.mountId, "Altair Vega preview mountId");
  const autoSync = options.autoSync === undefined ? true : options.autoSync;
  if (typeof autoSync !== "boolean") {
    throw new TypeError("Altair Vega preview autoSync must be a boolean");
  }
  return Object.freeze({
    mountId,
    autoSync,
    ...(options.sceneId === undefined
      ? {}
      : {
          sceneId: nonEmpty(options.sceneId, "Altair Vega preview sceneId"),
        }),
    ...(options.sceneRevision === undefined
      ? {}
      : {
          sceneRevision: nonEmpty(options.sceneRevision, "Altair Vega preview sceneRevision"),
        }),
    ...(options.commandIndex === undefined
      ? {}
      : {
          commandIndex: commandIndex(options.commandIndex, "Altair Vega preview commandIndex"),
        }),
    ...(options.runtimeProfileId === undefined
      ? {}
      : {
          runtimeProfileId: nonEmpty(options.runtimeProfileId, "Altair Vega preview runtimeProfileId"),
        }),
  });
};

const hashText = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const sceneRevision = (compiled: AltairVegaCompiledScene, explicit: string | undefined): string =>
  explicit ?? `vega-${hashText(JSON.stringify(compiled.story))}`;

const normalizeIdentity = (
  request: AltairPreviewRequest,
  options: NormalizedOptions,
  sequence: number,
): VegaPreviewIdentity => {
  const value = request.identity ?? options.createIdentity(request, sequence);
  if (!isVegaPreviewIdentity(value)) {
    throw new TypeError(
      "Altair Vega preview identity requires workspaceId, projectId, editorSessionId, and runtimeInstanceId",
    );
  }
  return Object.freeze({
    workspaceId: value.workspaceId.trim(),
    projectId: value.projectId.trim(),
    editorSessionId: value.editorSessionId.trim(),
    runtimeInstanceId: value.runtimeInstanceId.trim(),
  });
};

const commandFromJson = (command: JsonObject, identity: VegaPreviewIdentity): VegaPreviewCommand => {
  const envelope = {
    protocol: VEGA_PREVIEW_PROTOCOL,
    kind: "request",
    identity,
    requestId: "altair-validation",
    revision: 0,
    command,
  };
  if (!isVegaPreviewRequest(envelope)) {
    throw new TypeError("Invalid Vega preview command");
  }
  return envelope.command;
};

const capabilityList = (capabilities: VegaPreviewCapabilities): readonly string[] =>
  Object.freeze([
    "vega-preview-protocol@1",
    ...capabilities.commands,
    ...(capabilities.stageInspection ? ["stage-inspection"] : []),
    ...(capabilities.revisionCancellation ? ["revision-cancellation"] : []),
    ...(capabilities.debugging ? ["debugging"] : []),
    ...(capabilities.stageTransforms ? ["stage-transforms"] : []),
  ]);

const asJsonValue = (value: unknown): JsonValue => cloneStoryValue(value) as JsonValue;

const abortableResource = <T extends AltairVegaRuntimeHandle>(
  operation: T | PromiseLike<T>,
  signal: AbortSignal,
  onBackgroundError: ((error: unknown) => void) | undefined,
): Promise<T> => {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (resource) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          void Promise.resolve(resource.dispose()).catch((error) => reportBackgroundError(onBackgroundError, error));
          return;
        }
        settled = true;
        resolve(resource);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) {
          reportBackgroundError(onBackgroundError, error);
          return;
        }
        settled = true;
        reject(error);
      },
    );
  });
};

const abortable = <T>(operation: T | PromiseLike<T>, signal: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        reject(error);
      },
    );
  });
};

class VegaPreviewService implements AltairVegaPreviewService {
  private readonly options: NormalizedOptions;
  private readonly compiler: AltairAdvCompiler;
  private readonly mounts = new Map<string, HTMLElement>();
  private readonly activeMounts = new Map<HTMLElement, symbol>();
  private readonly runtimeProfiles = new Map<
    string,
    Readonly<{
      readonly officialPlugins: readonly VegaPlugin[];
      readonly plugins: readonly VegaPlugin[];
      readonly theme?: string | false;
      readonly renderBackend?: string;
    }>
  >();
  private readonly sessions = new Set<() => Promise<void>>();
  private sequence = 0;
  private disposed = false;
  private disposal: Promise<void> | undefined;

  constructor(options: AltairVegaPreviewPluginOptions, compiler: AltairAdvCompiler) {
    this.options = normalizeOptions(options);
    this.compiler = compiler;
  }

  compileProject(
    request: Parameters<AltairVegaPreviewService["compileProject"]>[0],
  ): ReturnType<AltairVegaPreviewService["compileProject"]> {
    this.assertActive();
    return compileAltairVegaProject(request, this.compiler);
  }

  compilePreviewStory(
    request: Parameters<AltairVegaPreviewService["compilePreviewStory"]>[0],
  ): ReturnType<AltairVegaPreviewService["compilePreviewStory"]> {
    this.assertActive();
    return compileAltairVegaPreviewStory(request, this.compiler);
  }

  compileScene(
    request: Parameters<AltairVegaPreviewService["compileScene"]>[0],
  ): ReturnType<AltairVegaPreviewService["compileScene"]> {
    this.assertActive();
    return compileVegaScene(request, this.compiler);
  }

  registerMount(id: string, mount: HTMLElement): { dispose(): void } {
    this.assertActive();
    const key = nonEmpty(id, "Altair Vega preview mount id");
    if (!mount || typeof mount !== "object" || typeof mount.replaceChildren !== "function") {
      throw new TypeError("Altair Vega preview mount must be an HTMLElement");
    }
    if (this.mounts.has(key)) {
      throw new Error(`Altair Vega preview mount is already registered: ${key}`);
    }
    this.mounts.set(key, mount);
    let active = true;
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.mounts.get(key) === mount) this.mounts.delete(key);
      },
    });
  }

  registerRuntimeProfile(id: string, profile: AltairVegaRuntimeProfile): { dispose(): void } {
    this.assertActive();
    const key = nonEmpty(id, "Altair Vega runtime profile id");
    if (!profile || typeof profile !== "object") {
      throw new TypeError("Altair Vega runtime profile must be an object");
    }
    if (this.runtimeProfiles.has(key)) {
      throw new Error(`Altair Vega runtime profile is already registered: ${key}`);
    }
    const snapshot = Object.freeze({
      officialPlugins: Object.freeze([...(profile.officialPlugins ?? [])]),
      plugins: Object.freeze([...(profile.plugins ?? [])]),
      ...(profile.theme === undefined
        ? {}
        : {
            theme: themeSelector(profile.theme, "Altair Vega runtime profile theme"),
          }),
      ...(profile.renderBackend === undefined
        ? {}
        : {
            renderBackend: nonEmpty(profile.renderBackend, "Altair Vega runtime profile renderBackend"),
          }),
    });
    this.runtimeProfiles.set(key, snapshot);
    let active = true;
    return Object.freeze({
      dispose: () => {
        if (!active) return;
        active = false;
        if (this.runtimeProfiles.get(key) === snapshot) {
          this.runtimeProfiles.delete(key);
        }
      },
    });
  }

  async createPreview(request: AltairPreviewRequest & { readonly signal: AbortSignal }): Promise<AltairPreviewSession> {
    this.assertActive();
    throwIfAborted(request.signal);
    const settings = parsePreviewOptions(request.options, this.options);
    const backgroundErrorHandler = this.options.onBackgroundError;
    const mount = this.mounts.get(settings.mountId);
    if (!mount) {
      throw new ReferenceError(`No Altair Vega preview mount is registered as '${settings.mountId}'`);
    }
    if (this.activeMounts.has(mount)) {
      throw new Error(`Altair Vega preview mount '${settings.mountId}' is already in use`);
    }
    const profile = settings.runtimeProfileId ? this.runtimeProfiles.get(settings.runtimeProfileId) : undefined;
    if (settings.runtimeProfileId && !profile) {
      throw new ReferenceError(`No Altair Vega runtime profile is registered as '${settings.runtimeProfileId}'`);
    }
    const officialPlugins = Object.freeze([...(profile?.officialPlugins ?? this.options.officialPlugins ?? [])]);
    const plugins = Object.freeze([...(profile?.plugins ?? this.options.plugins ?? [])]);
    const theme = profile?.theme ?? this.options.theme;
    const renderBackend = profile?.renderBackend ?? this.options.renderBackend;
    const reservation = Symbol(settings.mountId);
    this.activeMounts.set(mount, reservation);
    let channel: MessageChannel | undefined;
    let runtime: AltairVegaRuntimeHandle | undefined;
    let client: AltairPreviewClient | undefined;
    let disposal: Promise<void> | undefined;
    let removeAbort: () => void = () => undefined;
    let disposeSession = async (): Promise<void> => undefined;
    try {
      const identity = normalizeIdentity(request, this.options, ++this.sequence);
      const activeChannel = new MessageChannel();
      channel = activeChannel;
      runtime = await abortableResource(
        this.options.createRuntime({
          identity,
          mount,
          port: activeChannel.port1,
          signal: request.signal,
          officialPlugins,
          plugins,
          ...(theme === undefined ? {} : { theme }),
          ...(renderBackend ? { renderBackend } : {}),
        }),
        request.signal,
        backgroundErrorHandler,
      );
      client = new AltairPreviewClient({
        identity,
        port: activeChannel.port2,
        timeoutMs: this.options.timeoutMs,
        ...(backgroundErrorHandler
          ? {
              onListenerError: (error: unknown) => reportBackgroundError(backgroundErrorHandler, error),
            }
          : {}),
      });
      await abortable(runtime.start(), request.signal);
      const capabilities = await client.waitUntilReady({
        signal: request.signal,
        timeoutMs: this.options.timeoutMs,
      });

      let compiled: AltairVegaCompiledScene | undefined;
      if (request.project && settings.autoSync) {
        compiled = await this.compileScene({
          project: request.project,
          ...(settings.sceneId ? { sceneId: settings.sceneId } : {}),
          signal: request.signal,
        });
        const response = await client.syncScene(
          compiled.sceneId,
          sceneRevision(compiled, settings.sceneRevision),
          compiled.story,
          settings.commandIndex,
          { signal: request.signal },
        );
        if (response.status !== "executed") {
          throw new Error("Initial Vega preview scene was superseded before the session became ready");
        }
      }
      throwIfAborted(request.signal);

      const activeClient = client;
      const activeRuntime = runtime;
      const initialDiagnostics = compiled?.diagnostics.length
        ? asJsonValue({
            type: "altair.vega.compile-diagnostics",
            sceneId: compiled.sceneId,
            diagnostics: compiled.diagnostics,
          })
        : undefined;
      disposeSession = (): Promise<void> => {
        disposal ??= (async () => {
          removeAbort();
          activeClient.close("Altair Vega preview disposed");
          try {
            await activeRuntime.dispose();
          } finally {
            activeChannel.port1.close();
            this.sessions.delete(disposeSession);
            if (this.activeMounts.get(mount) === reservation) {
              this.activeMounts.delete(mount);
            }
          }
        })();
        return disposal;
      };
      this.sessions.add(disposeSession);
      const onAbort = () => {
        void disposeSession().catch((error) => reportBackgroundError(backgroundErrorHandler, error));
      };
      request.signal.addEventListener("abort", onAbort, { once: true });
      removeAbort = () => request.signal.removeEventListener("abort", onAbort);

      return Object.freeze({
        capabilities: capabilityList(capabilities),
        async request(command: JsonObject, options: { readonly signal?: AbortSignal } = {}): Promise<JsonValue> {
          const response = await activeClient.request(
            commandFromJson(command, identity),
            options.signal ? { signal: options.signal } : {},
          );
          return asJsonValue(response);
        },
        onEvent(listener: (event: JsonValue) => void): () => void {
          const remove = activeClient.onEvent((event) => listener(asJsonValue(event)));
          let active = true;
          if (initialDiagnostics !== undefined) {
            queueMicrotask(() => {
              if (!active) return;
              try {
                listener(cloneStoryValue(initialDiagnostics));
              } catch (error) {
                reportBackgroundError(backgroundErrorHandler, error);
              }
            });
          }
          return () => {
            if (!active) return;
            active = false;
            remove();
          };
        },
        dispose: disposeSession,
      });
    } catch (error) {
      let failure = error;
      client?.close("Altair Vega preview failed to start");
      try {
        if (runtime) {
          await runtime.dispose();
        }
      } catch (cleanupError) {
        failure = new AggregateError(
          [error, cleanupError],
          "Altair Vega preview failed to start and dispose its runtime",
        );
      } finally {
        channel?.port1.close();
        channel?.port2.close();
        if (this.activeMounts.get(mount) === reservation) {
          this.activeMounts.delete(mount);
        }
      }
      throw failure;
    }
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.disposal = (async () => {
      const errors: unknown[] = [];
      for (const dispose of [...this.sessions]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      this.sessions.clear();
      this.activeMounts.clear();
      this.mounts.clear();
      this.runtimeProfiles.clear();
      if (errors.length) {
        throw new AggregateError(errors, "Failed to dispose Altair Vega preview sessions");
      }
    })();
    return this.disposal;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new ReferenceError("Altair Vega preview service is disposed");
    }
  }
}

export const createAltairVegaPreviewService = (
  options: AltairVegaPreviewPluginOptions = {},
  compiler: AltairAdvCompiler = altairAdvService,
): AltairVegaPreviewService => new VegaPreviewService(options, compiler);
