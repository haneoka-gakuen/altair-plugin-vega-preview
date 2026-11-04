# Altair Vega Preview

Altair Vega Preview runs your story in [Vega](https://github.com/haneoka-gakuen/vega)
right inside the [Altair](https://github.com/haneoka-gakuen/altair) editor.
Edit a line and the preview updates without a reload; put the cursor on a
command and the preview jumps there; play from any point, pause, step through
with breakpoints, or drag a character on the stage and read its exact
transform back into the command. What you see is the same engine your players
will run — not an approximation.

The plugin also owns the compiler that turns an Altair project into Vega's
story format, so the build and the preview always agree.

## Install

```sh
pnpm add @haneoka/altair @haneoka/altair-plugin-adv @haneoka/altair-plugin-vega-preview @haneoka/vega @haneoka/vega-protocol
```

Requires Altair ADV (`haneoka.altair-adv ^0.1.0`), which must be installed
first. ESM only; the preview runs in a browser.

## Use it in Altair

```ts
import { AltairPluginHost } from "@haneoka/altair/plugins";
import { altairAdvPlugin } from "@haneoka/altair-plugin-adv";
import {
  ALTAIR_VEGA_PREVIEW_SERVICE,
  createAltairVegaPreviewPlugin,
} from "@haneoka/altair-plugin-vega-preview";

const host = new AltairPluginHost();
await host.install(altairAdvPlugin);
await host.install(createAltairVegaPreviewPlugin({ officialPlugins: [threePlugin, cubismPlugin] }));

const preview = host.service(ALTAIR_VEGA_PREVIEW_SERVICE);
preview.registerMount("main", document.querySelector("#preview")!);

const session = await host.createPreview("vega", {
  project,
  options: { mountId: "main", sceneId: "opening", commandIndex: 0 },
});
await session.request({ name: "runtime.play" });
```

The plugin (`haneoka.altair-vega-preview`) contributes:

| Contribution | Id / port | What it does |
| --- | --- | --- |
| Compiler | `vega-adv`, port `vega-adv-output` | Compiles a project to Vega's story format. |
| Preview provider | `vega`, port `vega-preview` | Creates preview sessions. |
| Service | `ALTAIR_VEGA_PREVIEW_SERVICE` | Compilation, mounts and runtime profiles. |

### Options

| Option | Meaning |
| --- | --- |
| `officialPlugins` | Vega plugins trusted as part of your distribution (renderer, Cubism, theme…). |
| `plugins` | Other Vega plugins, loaded with third-party authority. |
| `theme` | Theme contribution to use, or `false` for none. |
| `renderBackend` | Render contribution or backend to use. |
| `defaultMountId` | Mount used when a request names none. Default `"default"`. |
| `timeoutMs` | How long starting a preview may take. Default 8 000 ms. |
| `sceneTimeoutMs` | Time allowed for loading, replaying or executing a scene snippet. Default 120 000 ms; these operations also accept cancellation. |
| `priority` | Contribution priority. Default 100. |
| `createEngine`, `createRuntime` | Replace how the Vega engine or the whole runtime is created, for example to run the preview in an iframe or a worker. |
| `onBackgroundError` | Receives errors that happen after a session started. |

### Runtime profiles

Native project languages are exported as Vega's `vega:localization` metadata.
The editor preview, community runtime, and standalone game use the same declared
language list and default language.

Reimported Vega games restore shared model definitions into the native asset
catalogue. Scene commands reference that catalogue, so repeated appearances keep
one editable model definition.

Different projects need different Vega plugins. Register a named profile with
the plugins, theme and backend it should use, then pick it per preview:

```ts
preview.registerRuntimeProfile("first-light", { plugins: [richTextPlugin], theme: "haneoka" });
await host.createPreview("vega", { project, options: { runtimeProfileId: "first-light" } });
```

The service never loads plugins from a catalog itself; it only uses modules
the host already decided to trust.

## Preview options

`options` on `createPreview`:

| Option | Meaning |
| --- | --- |
| `mountId` | Which registered element to render into. |
| `sceneId` | Scene to open. |
| `commandIndex` | Command to start at. |
| `sceneRevision` | The editor's revision, so late updates for older text are ignored. |
| `autoSync` | Follow edits automatically (default `true`). |
| `runtimeProfileId` | Profile registered with `registerRuntimeProfile`. |

## Talking to a session

`session.request(command)` sends a preview command and resolves with its
response. `session.capabilities` lists what the running engine supports, and
`session.onEvent(listener)` receives events such as position changes.

| Command | Purpose |
| --- | --- |
| `runtime.load`, `runtime.patch` | Load a compiled story, or patch it in place. |
| `runtime.play`, `runtime.pause`, `runtime.seek` | Playback. |
| `runtime.snapshot`, `runtime.dispose` | State and cleanup. |
| `editor.sync-scene` | Send the edited scene; the preview updates in place. |
| `editor.run-scene`, `editor.run-from`, `editor.run-snippet` | Play a scene, play from a command, or try a few commands without saving them. |
| `stage.snapshot`, `stage.transform.get`, `stage.transform.set`, `stage.reference-frame` | Inspect and move things on stage (when `stage-inspection` is supported). |
| `debug.breakpoints.set`, `debug.step`, `debug.continue`, `debug.variables` | Debugging (when `debugging` is supported). |

`dispose()` ends the session and frees the engine. Aborting the signal passed
to `createPreview` cancels a slow start without leaving a stray runtime.

## Compiling without a preview

```ts
const { story, diagnostics, commandSourceIndexes } = await preview.compileScene({ project, sceneId: "opening" });
const result = await preview.compileProject({ project });
```

`commandSourceIndexes` maps every compiled command back to the authored
command, which is how the editor highlights the line that is playing.

## What is not included

No character SDKs, models, game assets or vendor runtimes. Supply them as Vega
plugins (for example [Vega Cubism](https://github.com/haneoka-gakuen/vega-plugin-cubism)).

## License

MPL-2.0. See [LICENSE](LICENSE).

## Storyboard ranges

Automatic direction plans scene coverage around authored shot ranges.
`planAutomaticStoryShots` uses character visibility, speaker
bindings, scene changes, choices, silent replies and upcoming dialogue turns.
It establishes a new location, holds brief replies within a shot, returns to
ensemble coverage, and gradually pushes in on sustained monologues. Generated
ranges have deterministic command identities and appear directly in Studio's
editable storyboard. Preview, community compilation and game export lower the
same plan to native camera commands; playback does not call a model service.
Generated `altair/…` source anchors keep their seek identities without restarting
the current shot. Labels and source anchors referenced by control flow
remain camera entry points.

Whole-scene compilation and selected-range planning use one deterministic
planner. Native camera commands retain ownership until a scene boundary or an
explicit author override. Automatic ranges fill gaps between author ranges;
editing one range stores that override alone. Partial-range replanning retains
both outside fragments, and scene edits re-anchor author ranges in the same
undo transaction.

Two-person and group coverage carries `subjects` into native `Focus.focusTargets`.
Three fits the subjects' actual head and body bounds to the stage viewport.
Reaction coverage targets a listener, ordinary action commands hold the current
shot, and intent is authored rather than inferred from punctuation. Inline voice
duration metadata takes priority over text-based timing when available.

The planner follows the separation between shot selection and geometric camera
placement described in [The Virtual Cinematographer](https://grail.cs.washington.edu/wp-content/uploads/2015/08/he-1996-tvc.pdf).
Dialogue length estimates shot duration; punctuation identifies pauses and
emphasis. Authors can supply explicit ranges and retain ownership of native
camera commands through the next scene change.

Import converts foreign model placement into Haneoka's native stage coordinates
and model profiles. The saved authoring document owns these coordinates,
ordinary motion commands, resource bindings and camera settings. Source
metadata is retained for attribution and format export. Cubism providers expose stable geometry sampled before
animation, so blinking and motion do not resize the actor or move the camera
anchor. Existing native model profiles keep their authored calibration.
Imported figures share native blocking: visible actors retain their left-to-right
order, with spacing derived from the native eye/body scale and the narrower
viewport. Entrances, exits and slot changes emit ordinary native world-position
commands for the cast. Bestdori, Sekai and WebGAL therefore use the same spacing
in preview, community publication and exported games. Reopening an older project
materializes its layout once, preserving authored IDs, locks, unknown fields and
editable script text. All origins use the same native project serializer.
Targeted focus commands for actors with native world coordinates store a
character anchor; explicit slot anchors remain editable and retain their value.

`scene.extensions["haneoka.storyboard"]` stores version 1 shot ranges anchored by
stable command IDs. Each shot has `id`, `start`, `end`, and `kind` (`speaker`,
`reaction`, `wide`, `manual`), with optional `targetName`, `cameraDistance`,
`transitionSeconds`, `intent`, and `locked`. Ranges are inclusive and cannot
overlap. Compilation reports deleted anchors and invalid shot settings.
`planStoryShots` regenerates a selected range and retains locked shots.

The Our Notes presentation lowers these ranges into the same native Focus
commands used by hand-authored stories. Manual camera spans retain ownership.
Studio can bake a scene's derived cameras into ordinary editable commands in
one document operation. `scene.extensions["haneoka.presentation"].cameraMode`
selects automatic or manual direction for any scene; legacy baked flags migrate
to this common setting. The original source sidecar remains available for source
format export.

The preview protocol's `stage.capture` command returns a renderer-owned WebP
frame at the current native aspect. Studio uses the scene command map to seek
and capture shot thumbnails; changing the compiled story invalidates them.

Projects with model descriptors compile to Vega project format 2. One immutable
model definition serves repeated appearances, reducing preview and release
payloads without removing the editable motion catalogue. Export, resource
closure, preview, runtime playback and source recovery use the same definitions.
The compiler validates the final Vega structure, including optional command
labels, before returning an artifact.

Native presentation also visits timed command groups. Derived camera actions
retain the source cue time and use the same scene clock. Shot ranges continue
to use the authored group IDs; their actors and speakers are available in the
same storyboard and binding controls as ordinary scene commands.
