---
"@namzu/desktop": minor
---

The Windows installer can carry the light Pal computer image. `scripts/stage-installer.mjs` takes `--pal-computer-image <archive>` (and `--pal-computer-manifest <file>`, which defaults to `manifest.json` beside the archive), checks the manifest against the archive (name, size, SHA-256) and stages both under `extra/pal-computer`, which `electron-builder.yml` installs as `resources/pal-computer`. The archive is already compressed and is stored as built. Nothing loads the image at run time yet; a build staged without the flag installs a `README.txt` there instead.
