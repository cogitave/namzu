---
'@namzu/sandbox': patch
---

Bring the worker and guest agent under the linter, and document what they already do

`biome.json` restricted `files.include` to `src/**/*.ts` and the lint script ran `biome check src/`. Two independent exclusions of the same directories, so `worker/server.js` and `agent/agent.cjs` were checked by nothing — including the worker, which is the HTTP surface that executes commands inside the container and has no type checking either, being plain CommonJS.

Turning it on immediately found dead code: an unused `readNdjson` helper in the worker's own test file. The rest were `useOptionalChain` rewrites in crash handlers, applied and reviewed one at a time — `err && err.stack ? err.stack : err` and `err?.stack ? err.stack : err` take the same branch for every input, including a non-`Error` throw.

`noConsole` is off for these two directories. They are standalone processes, not modules this package imports, and stdout is their only channel: the host's readiness path and the test harness both wait on the worker's `listening on` line, and the crash handlers exist so an unhandled rejection is diagnosable rather than a silent exit. A logger abstraction would mean a dependency in files that deliberately have none. (The reason lives here and in the commit rather than beside the setting, because `biome.json` is strict JSON and rejects both comments and unknown keys.)

Two documentation debts from earlier changes are cleared in the same pass:

- The README's `--cap-drop=ALL` bullet carried only one of its two reasons. It also stops an `--internal` network's egress denial from being undone by a single `ip route add`, which is refused only because `NET_ADMIN` is absent.
- The README said nothing about the environment a spawned command sees, which changed materially when the worker stopped passing on its own configuration. It now says what is stripped, what is inherited and why the proxy variables and `options.env` must be.

No behaviour change.
