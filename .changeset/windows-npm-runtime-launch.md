---
"@namzu/cli": patch
---

Fix npm startup failures in Windows provider setup and `namzu upgrade` by running npm's JavaScript entry point with the Node runtime that runs Namzu. Arguments, including installation paths with spaces or shell characters, remain literal. Windows uses the npm bundled with that runtime; if it is absent, Namzu explains how to repair it instead of trying a custom PATH wrapper. Cancelling provider installation requests termination of its Windows process tree and reports if cleanup cannot be confirmed.

CLI 23.0.0's existing Windows updater cannot acquire this fix itself when it fails with `spawn EINVAL`. Run `npm.cmd install --global @namzu/cli@latest` once using the same Node installation; include `--prefix "<existing-prefix>"` for a custom global prefix. Restart Namzu afterward.
