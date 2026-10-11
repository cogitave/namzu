---
"@namzu/sandbox": minor
---

The local Pal computer provider accepts a third engine, `engine: 'wslc'`, for Windows' own container CLI, with an optional `wslcBinary` path. Nothing changes for Docker and Podman: their command lines are byte for byte as before, and `wslc` is never chosen unless you ask for it.

wslc cannot take `--cap-drop`, `--security-opt`, `--read-only` or `--ipc`, so a computer on this engine runs without those four controls; its boundary is the per-user virtual machine and the unprivileged guest user. Keep using Docker or Podman for a Pal that runs code you do not trust.

`LocalComputerSetupError` is now exported and carries an optional `code` (`engine-missing`, `engine-too-old`, `virtualization-off`, `blocked-by-policy`, `image-missing`, `sdk-mismatch`) so an application can react without parsing the message. `EngineDialect` and `LocalComputerSetupCode` are exported as types. No existing export changes.
