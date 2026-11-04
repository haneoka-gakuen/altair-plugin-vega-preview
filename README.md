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
| `priority` | Contribution priority. Default 100. |
| `createEngine`, `createRuntime` | Replace how the Vega engine or the whole runtime is created, for example to run the preview in an iframe or a worker. |
| `onBackgroundError` | Receives errors that happen after a session started. |

### Runtime profiles

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
