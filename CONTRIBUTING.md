# Contributing

Keep the Altair API v2 and Vega preview protocol boundaries explicit. Every
lifecycle change needs cancellation, late-resolution, and idempotent-disposal
coverage.

Runtime source may import Altair only through `@haneoka/altair/model` and
`@haneoka/altair/plugins`. Native ADV behavior belongs to the independent ADV
plugin; Vega projection behavior belongs here.

Run:

```sh
pnpm check
pnpm pack --dry-run
```

Do not add vendor runtimes, character models, game assets, media, bundled
dependencies, or implicit global DOM lookup.
