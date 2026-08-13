---
'@namzu/sandbox': major
---

The docker backend's default configuration could not create a sandbox, and the test that would have caught it had never run

`create()` failed on the documented defaults — `network: 'none'`, `hostReachability: 'host-port'` — with `index of untyped nil` thrown out of a `docker inspect` template, reported as "the container exited immediately". The container was alive and well. Docker binds a published port to the container's address by NAT, so a container with no route out has no address to bind to and nothing is published; measured against Docker 29.6, `--network none --publish 127.0.0.1::2024` is *accepted* and `NetworkSettings.Ports` comes back `{"2024/tcp":[]}`. An `--internal` network behaves the same way.

`deny-all` had the same defect from the other side. It answered `--network none`, which reads as the strictest possible answer and removes the interface the worker is reached on — so it denied the way *in* along with the way out, in both reachability modes.

**Why no one noticed.** `packages/sandbox/vitest.config.ts` excludes `**/*.smoke.test.ts` from every run it governs, including the `test:smoke` run that exists to run them; naming the files as CLI arguments does not re-include them, because positional arguments filter what discovery already found. With `--passWithNoTests`, `pnpm sandbox:smoke` printed `No test files found, exiting with code 0` and the workflow went green — after building a Debian image with a browser and an office suite in it to run nothing. The suite's own fail-fast guard for a misconfigured CI could not fire either: it lives inside a file that was never loaded.

**What changes for you.**

- The smoke suite has its own config and no `--passWithNoTests`, so an empty run is now a failure.
- `create()` checks the container's network against the daemon before starting anything, and refuses with the reason. **The `network` default of `'none'` is one of the pairings it refuses** — name a bridge to reach the worker by host port, or set `hostReachability: 'container-network'`.
- `deny-all` now keeps the configured network and **requires it to be one created with `docker network create --internal`**, verified rather than trusted. That is a real boundary: outbound gets `Network unreachable` from the kernel, not from an environment variable a workload may decline to read, while sibling containers still reach the worker by name.
- Consequently **`deny-all` over a published host port is refused as impossible**, not unsupported: a published port needs a route out and `deny-all` needs none. Closing that means moving the worker's control channel off TCP, which is tracked separately.
- `resolveNetwork` no longer returns `'none'` for `deny-all`. `assertNetworkCarriesThePolicy` and `isInternalNetwork` are exported alongside it.
