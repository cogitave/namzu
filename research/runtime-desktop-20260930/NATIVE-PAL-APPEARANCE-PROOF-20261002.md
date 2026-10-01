# Native Windows Pal appearance verification — 2026-10-02

The saved appearance contract passed eight checks under native Windows Node
22.20.0, launched from the inherited WSL UNC working directory. The
[sanitized receipt](artifacts/pal-native-appearance-20261002.json) contains the
observations without Pal IDs, private paths or credentials.

## Actual paths exercised

- The built native CLI creates `spark/violet`, updates the same Pal to
  `sprout/blue` with revision 1, and reads that choice in a new process.
- The native SDK reads both the current appearance and the unchanged original
  revision after constructing a new store.
- Malformed appearance flags create no Pal; a stale expected revision cannot
  publish an edit.
- The production desktop `Operator` starts the real native CLI ACP transport.
  Create, update and list preserve the validated appearance. An invalid ACP
  color is rejected without a new revision.
- A new Operator and ACP process reload the stored selection. Records created
  without appearance still omit it, so a host's display default does not rewrite
  old profiles.
- Both owned ACP connections confirm shutdown. A read-only native process
  inventory finds no ACP process for this fixture afterward.

## Reproduction

Use [prepare-windows-consumer.mjs](prepare-windows-consumer.mjs) to copy the
already installed, built workspace into a **new** Windows temporary directory
named `namzu-native-consumer-*-appearance`. Run its `link-native.mjs` with native
Windows Node. The successful snapshot contained 130 runtime packages; no
dependency installation or npm shim change was performed.

Bundle [windows-pal-appearance-proof.mjs](windows-pal-appearance-proof.mjs) as
Node ESM with the already installed desktop Vite esbuild dependency and a
`createRequire` banner for bundled CommonJS imports. Execute the bundle with
native Windows Node, passing the snapshot's native Windows path. The harness
refuses other hosts and allocates a new private `NAMZU_HOME` for each run.

The existing native appearance snapshot and private metadata remain in owned
Windows temporary directories. The user's running Namzu window, original
consumer snapshot, Pal records and local computer engine were untouched.

## Limits

This verifies built CLI/SDK metadata persistence and the real desktop Operator
ACP path. It is not a registry install or an Electron renderer animation proof.
No model inference, guest startup, engine installation or external messages were
performed.
