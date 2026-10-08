# Project connecting state

The owner saw "Review folder access" flash while the app was opening. A project starts as `{ trusted: false, status: 'connecting' }` and gets the CLI's trust only after `namzu/project/status`; the stage showed the trust gate for any `!project.trusted`, so it appeared on every launch for the seconds the CLI takes to start.

Fix, renderer only (main still trusts nothing early): `projectStage()` in `packages/desktop/src/renderer/project-stage.ts` picks the stage. Connecting shows a blank stage for 400 ms, then a muted spinner and "Opening Sample app…" (`project-views.tsx`); ready and not trusted shows the unchanged gate; error (not Pal or chat) shows "Couldn’t open this folder", the error once (the banner hides its copy) and Try again. The disabled-composer layout was not used, because the chat stage calls project APIs before ready.

`proof.mjs` drives the loopback preview (`?connect=slow|error|untrusted`), sampling the page every 50 ms in dark and light. [proof.json](artifacts/proof.json): zero gate frames for the trusted project and the failed one, spinner absent before 400 ms, ready follows.

| State | Dark | Light |
| --- | --- | --- |
| Connecting, before 400 ms | [png](artifacts/connecting-before-400ms-dark.png) | [png](artifacts/connecting-before-400ms-light.png) |
| Connecting, spinner | [png](artifacts/connecting-spinner-dark.png) | [png](artifacts/connecting-spinner-light.png) |
| Ready | [png](artifacts/ready-dark.png) | [png](artifacts/ready-light.png) |
| Untrusted gate | [png](artifacts/untrusted-gate-dark.png) | [png](artifacts/untrusted-gate-light.png) |
| Error | [png](artifacts/error-dark.png) | [png](artifacts/error-light.png) |
| Error, retrying | [png](artifacts/error-retrying-dark.png) | [png](artifacts/error-retrying-light.png) |

Note: in the preview, error and untrusted also show the existing banner "This conversation could not be loaded", because the restored sample tabs belong to a project whose catalogue cannot be read yet. That is prior behaviour, unchanged here.

```sh
cd packages/desktop && node ../../research/project-connecting-20261008/proof.mjs ../..
```
