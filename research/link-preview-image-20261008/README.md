# Why github.com's share image came back null in the guarded probe

Probe `probe-only-20261008T064807524Z.json` (snapshot ae59e7db1): page preview for
github.com/composio-community/open-dot was non-null with `og:image`, the icon came back
(image/png, 33,270 bytes), the page image was `null` after 180 ms. Earlier runs the day before passed
(image 86,493 / 86,409 bytes).

## Finding

The image is `https://opengraph.githubassets.com/<hash>/composio-community/open-dot`, an on-demand
image service. Our rules accept it: no redirect, `image/png`, 86,986 bytes (cap 2 MiB), public
addresses (185.199.108-111.154), PNG sniffs fine. `svc.mts` runs the real `createLinkPreviewService`
over Node's `fetch`/`dns` and gets a 116 KB data URL in 112 ms; `repro.mjs` shows the plain HTTP
exchange.

`burst.mjs` reproduces the null: 40 quick requests to that host gave 35 x 200 and 5 x 429
(`/1/composio-community/open-dot` answers 429 text/html on a single try). `open()` refuses every non-2xx
status, so a 429 becomes `null`, and the failure is kept for 2 minutes. The 180 ms is a fast refusal,
not a timeout. The icon comes from another host (github.githubassets.com), unaffected. The owner's
Windows machine had run this probe many times that day, so rate limiting of its address is the
consistent cause. The app itself was not touched, so the 429 for that very request is inferred from
reproduction, not observed (the service deliberately keeps no reason).

Ruled out: redirect to another host, size over cap, content type, timeout, address check, cached earlier
null (the link-preview module is unchanged since the feature landed).

## Decision

Our rule is not wrong: retrying a 429 would hammer a host that asked us to stop, and a card without a
picture is the designed fallback. No rule change. Added a unit test pinning "429 picture is a failure
kept two minutes, then asked again". The probe (`native-update.cjs`) now requires at least one of the
two pictures and records an observation when one is missing.

Gates: `vitest run src/main/link-preview.test.ts` 111 passed, `pnpm typecheck`, biome, `pnpm docs:check` pass.
