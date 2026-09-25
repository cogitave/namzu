# @namzu/sandbox

## 23.0.0

### Patch Changes

- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [fbeac55]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
- Updated dependencies [567ada8]
  - @namzu/sdk@48.0.0

## 22.0.0

### Patch Changes

- 2d4ff9a: Shipped text no longer names one particular application built on namzu. Nothing to do to upgrade: no type, default or behaviour changes.

  - `@namzu/sandbox`: when a self-hosted Firecracker orchestrator returns a network-mode (`mtls`) agent handle and the backend was given no client certificate, the error now tells you to pass `mtls: { ca, cert, key }` in the backend config. It used to name environment variables that only one host defines, which no other installer has. The message still starts with `firecracker: orchestrator returned an mtls agent handle but no client cert material was injected`, so code matching on that prefix keeps working.
  - Doc comments in the published `.d.ts` files and sources (`ContainerBackendConfig.labels`, the ACI and Azure Blob name options, the sandbox mount-source types) say "the host" or "the consumer", and label examples use the placeholder `acme.` namespace. The `microvm` tier's (`MicroVMBackendConfig`, `AgentSnapshotRef`, `OrchestratorNetworkPolicy`) describe the orchestrator as a self-hosted one the host runs, not as namzu's own: namzu ships only the client.
  - Earlier entries in the `@namzu/sandbox`, `@namzu/sdk` and `@namzu/anthropic` CHANGELOGs are reworded the same way; the `@namzu/files` CHANGELOG named no one and is unchanged. Versions already on npm keep their old text.

- Updated dependencies [2d4ff9a]
- Updated dependencies [166fe10]
- Updated dependencies [2d4ff9a]
- Updated dependencies [7c810bc]
- Updated dependencies [443094a]
- Updated dependencies [49491b9]
- Updated dependencies [7c810bc]
  - @namzu/sdk@47.0.0

## 21.0.0

### Patch Changes

- Updated dependencies [28102e1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [82769f1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [28102e1]
- Updated dependencies [82769f1]
- Updated dependencies [28102e1]
  - @namzu/sdk@46.0.0

## 20.0.0

### Patch Changes

- Updated dependencies [2e2ea14]
- Updated dependencies [2e2ea14]
  - @namzu/sdk@45.0.0

## 19.0.0

### Major Changes

- 3e7a97b: No API change. The peer dependency on `@namzu/sdk` moves to the 44 major,
  because the SDK itself had a major release (its run became a turn inside a
  session). `@namzu/sandbox` reads no renamed field, but its peer range is
  published as a caret on the SDK version it was built with, so the SDK major
  takes it out of range and forces this bump.

  What to do: upgrade `@namzu/sdk` and `@namzu/sandbox` together. Nothing in your
  code changes.

### Minor Changes

- 0a89444: New: egress profiles. `defineEgressProfile({ name, hosts: [{ host, ports? }] })`
  validates one named host allowlist, and `createSandboxProvider` takes it as
  `egressProfile` instead of `defaultEgress`. On docker, runsc and firecracker a
  profile becomes `deny-all` (no hosts) or a `static` allowlist. Whatever a
  backend cannot honour is refused at construction with
  `SandboxEgressProfileError`: ports on firecracker, any profile on the ACI
  standby pool or beside `defaultEgress`, and a
  `brokeredCredentials` host the profile does not allow. On docker and runsc a
  live `setNetworkPolicy` under a profile may only name hosts the profile covers.
  On kubernetes, `createSandboxProvider` refuses `egressProfile`; put
  `kubernetesEgressFromProfile(profile, { engine: 'cilium' })` in
  `backend.egress` instead, which also bounds workspaces and writes the profile
  label only with `profileLabel: true`.

  Nothing changes for a config without `egressProfile`.

- aee81a6: The docker and runsc egress proxy now enforces the `ports` of an egress
  profile, on the port it actually dials: an upgraded `http://host/` and a
  `CONNECT` with no port are checked on 443. A host may use the union of the
  ports of every rule that matches it. The same check is available on
  `EgressProxy` as `allowedPorts`, and `egressPortsForRules(profile.hosts)`
  builds that option from a profile's rules with the same union rule.

  **Rebuild `egressProxyImage` from `packages/sandbox/egress-proxy/Dockerfile`
  before using `ports`.** A profile with ports sends the proxy a new
  configuration variable, `NAMZU_EGRESS_PROXY_CONFIG_V2`, and the backend first
  reads the image's `ai.namzu.egress-proxy.config` label with
  `docker image inspect`, refusing an image that does not declare version 2 (or
  that is not on the daemon: `docker image inspect` does not pull). Profiles
  without ports, and every policy without a profile, need nothing: the proxy
  gets the same configuration and argv as before.

- c366ca7: New: sandbox seeds. `ensureSandboxSeed(sandbox, seed, { root })` makes the git
  repositories of a `defineSandboxSeed({ name, repositories })` present under
  `root` inside any sandbox, through `exec` only. Every call checks each
  repository (origin URL, and that its pinned or recorded commit is an ancestor
  of HEAD; a `ref` changed since the clone, or a pin dropped, is drift unless
  the ref's commit is exactly HEAD) and clones only what is missing, so running it after each create or
  workspace resume costs one check when nothing changed. Drift is refused before
  anything is cloned (`onDrift: 'report'` records it instead), and nothing is
  ever deleted or re-cloned. `root` is required; on docker, use
  `layout.scratch`, not the outputs root. A repository directory may not sit
  inside another's, nor under `.namzu/`. URLs with a user name or password,
  `ssh://` and `git@host:path` are refused, so no credential enters the guest.
  The guest needs `sh`, `git`, `find`, `mkdir`, `mktemp`, `rm` and GNU `mv`.

  Nothing changes for code that does not call it.

### Patch Changes

- 251d815: On the docker backend, two overlapping `setNetworkPolicy()` calls on one
  sandbox could leave no egress proxy running while a caller was told its policy
  was in force, or resolve one call while the other call's policy was the one
  applied. Calls on one sandbox now run one at a time, in the order they were
  made, and each resolves only once its own policy is running. A call that asks
  for the allowlist already in force no longer restarts the proxy. No action is
  needed.
- Updated dependencies [8805360]
- Updated dependencies [9355755]
- Updated dependencies [755a81a]
- Updated dependencies [cb1f00c]
- Updated dependencies [933ba6d]
- Updated dependencies [3e7a97b]
- Updated dependencies [a84dc1c]
- Updated dependencies [b064cea]
- Updated dependencies [9238347]
- Updated dependencies [a14b013]
- Updated dependencies [3641102]
  - @namzu/sdk@44.0.0

## 18.1.1

### Patch Changes

- 006fdf3: A Kubernetes `openTerminal` no longer depends on a kernel build option to find the terminal it just started: where `/proc/<pid>/task/<pid>/children` does not exist, the guest agent discovers the tree by scanning `/proc` for the parent instead (#516, a follow-up to #512).

  **What was wrong.** `findPtySlave` walks `/proc` for the shell util-linux `script` forked, and its only way in was `processChildren` reading `/proc/<pid>/task/<pid>/children`. That file is `CONFIG_PROC_CHILDREN` — not part of the kernel's base `/proc` support — and the reporter's guest (a 6.6 mshv guest on a sandbox cluster) has no such entry at all: `cat /proc/108/task/108/children` answers `No such file or directory` for a `script` that is alive with a shell under it, and the entry is simply absent from `/proc/<pid>/task/<pid>/` where it would sort between `cgroup` and `clear_refs`. So the walk's queue was empty on every one of its 200 attempts, `probePtySlave` was never called at all, and the `tty_nr` fallback #512 added — which is per pid the walk has already dequeued — was unreachable, because no pid was ever dequeued. The reported symptom is exactly what that reads as: `terminal PTY slave did not appear (200 attempts, 1112ms; last children(): ENOENT; last fd/0: never read; last stat: never read; script: alive)`.

  **What changed.** `parseProcessStat` now also carries field 4, `ppid`, and one pass over `/proc` groups every live pid by its parent — the DIRECT-children relation the walk needs, from the same kernel, through a file (`/proc/<pid>/stat`) that is world-readable and gated on nothing. It is not the file's relation exactly, and the code says so rather than calling the two the same thing: field 4 is the parent's **thread-group id**, so the map is the thread-group-collapsed graph — WIDER than the file at a leader node, where a child forked by any thread of the group is listed under the leader and the file's `children` names the leader's own children only, and EMPTY at a non-leader tid, a node `readdir('/proc')` never yields and this walk never asks about. Neither difference takes a candidate away: the file's listing at a leader is a subset of the scan's, every node this walk visits is a process rather than a thread, and what the scan can add is a child the file's own walk would have missed. `findPtySlave` takes the file first and always, and reaches the scan only where a live pid answers `ENOENT` for it: `ENOENT` alone is ambiguous, and `/proc/<pid>` being **present** is what tells a kernel without the option from a process the kernel has released. A pid that is actually gone still ends the walk on the same observation it always did, and a refused read (`EACCES`, `EMFILE`) still takes the path it did before — no scan, and the errno reported as it was.

  The scan is discovery and nothing else: it cannot accept a candidate, only `probePtySlave` does that, so `fd/0` → `tty_nr` order, the pid that comes back with the slave (the shell's, which the session teardown rests on), the breadth-first order and the early stop are all unchanged. One `/proc` pass is shared by every pid an attempt visits, so a walk over K candidates costs one pass per 5ms poll rather than K of them, and on any kernel that HAS the file — every guest this agent has been measured in — the scan never runs at all. The pass reads each pid's `stat` synchronously, which is the one reader in the agent that does: measured, `readFileSync` answers in ~12µs per pid where the promisified read costs ~276µs, so a sixty-process guest spends ~0.7ms per pass rather than ~15ms, and what the synchronous call costs is syscall time and nothing else — procfs builds that line in kernel memory, so there is no device behind it to block on. The listing that precedes the loop stays asynchronous, being one call per pass rather than one per pid.

  That synchronous read is also why the pass is **bounded**, not merely measured, and the bound is the reason this is worth a second look: the agent is single-threaded and serves every terminal, exec, stream and `healthz` on that one event loop, and on the kernel family this fix exists for the scan runs on EVERY attempt — so a pass that never yielded would hold all of them for as long as the guest has processes, in one lump per attempt per terminal. The loop hands the loop back every 64 reads (`setImmediate`), which caps the uninterrupted stretch at 64 reads rather than at the size of the machine. Measured by driving the real function — extracted from the shipping file — over a `/proc` holding a copy of `sleep` per spawned process: the longest gap between two yields, which is the longest the loop went without a turn, was **0.97-1.05ms at 4041 live pids** and 0.69-0.93ms at 1041, where the same passes with the yield removed held the loop for **40.1-42.9ms and 10.6-11.8ms**. The pass pays for that in event-loop turns and nothing else: 41.7ms → 45.1ms at 4041 pids (median of five) for 62 turns, and at 41 pids no yield fires at all, the pass being shorter than the stretch it is allowed.

  Where the scan does run, the failure message now says so (`last children(): ENOENT, discovered by a /proc scan`) instead of leaving `ENOENT` to read as a broken walk, which is the reading that cost the reporter a cluster to correct. A scan whose own `readdir('/proc')` FAILED says that instead — `last children(): ENOENT, and the /proc scan that stands in for it could not list /proc: EACCES` — because a listing that never happened must not be reported as a scan that ran and came back empty, which would be the same misreading one level down.

  **What is not proven.** That the reporter's guest answers `ready` with this agent. Not pinned by a test, and deliberately: a timing assertion on the yield would be flaky, and the suite has no seam for a denied `/proc` listing. Both are verified out of suite instead — the stall table above by measurement, the failed-listing message by driving `discoverChildren` with a faked `fs` — which is why those numbers are quoted here rather than asserted in the file. The absence cannot be produced here — this machine's kernel has the option, and the guest is a cluster — so the regression test arranges it the way this suite arranges what it cannot reproduce: a copy of the shipped agent with its one `children` read pointed at a path that is not there, patched by anchored edits that assert each anchor occurs exactly once, run over a real loopback socket against real processes (`packages/sandbox/src/backends/kubernetes/__tests__/terminal-pty-slave.test.ts`). Against the pre-fix source those cases fail with the reporter's own line, field for field — `terminal PTY slave did not appear (200 attempts, 1043ms; last children(): ENOENT; last fd/0: never read; last stat: never read; script: alive)` — and against this one they answer `ready`, resize the shell's real pty and end a SIGHUP-immune background job through the shell's session. The same file pins the cost decision from the other side, asserting with the shipped agent that a walk which CAN read the file never runs the scan at all — and the two cases that must scan assert the counter saw theirs, so a rename cannot turn that bound into a vacuous pass.

  **Redeploy the guest image to get it.** `agent/agent.cjs` is baked into the guest images (`k8s/Dockerfile` `COPY`s it), and `npm pack @namzu/sandbox@18.1.0 --dry-run` confirms it is not in the published tarball — 0 entries. No public type, export, wire shape or documented default changes here, which is why this is a **patch**.

## 18.1.0

### Minor Changes

- ef570fe: `createSandboxProvider` now forwards `brokeredCredentials`, and
  `ContainerBackendConfig` carries the field.

  What this makes possible is the thing the container tier's egress boundary was
  built for. A host can now name credentials the sandbox never holds: the sandbox
  carries a placeholder, and the real value is stamped onto outbound requests at
  the egress proxy, so a prompt injection that exfiltrates the sandbox's
  environment does not carry the token with it. Until now the field could only be
  read from `DockerBackendInternalConfig`, which is not part of this package's
  public surface, so brokering was reachable only by calling `buildDockerBackend`
  directly — not by building a provider the documented way.

  Nothing existing changes behaviour. The field is optional and unset by default,
  and it is forwarded in the guarded style its neighbours use, so a config that
  does not set it produces a backend config with no such key at all rather than
  one with an explicit `undefined`; `egressProxyContainerConfig` reads either as
  "no credentials to stamp". A provider built without the field starts exactly the
  proxy container it started before. The one caller whose behaviour does change is
  the one that was passing the field through a type cast: it now takes effect.

  **Set it where it can be honoured, and not elsewhere.** The field is on
  `ContainerBackendConfig` — the docker and gVisor (`runsc`) tier — because that
  is the only tier with an egress proxy to stamp a credential at. The microVM tier
  hands its allowlist to its guest orchestrator and the kubernetes tier writes
  `NetworkPolicy`/`CiliumNetworkPolicy`; neither has a proxy, so the field is not
  on their configs. Within the container tier it is applied only where a proxy is
  actually started, which is a `static` or `resolver` policy with an
  `egressProxyImage`: `deny-all` and `allow-all` run no proxy, and credentials set
  beside either are never applied.

  Each entry names one host (`host`, matched by the allowlist's own rules so
  `.internal.example` covers subdomains), the header to set, and the value. The
  value leaves this process on its way to the proxy container, so anything with
  access to the docker daemon can read it — treat daemon access as credential
  access. See `docs/sdk/sandbox-egress.md`.

### Patch Changes

- a52727a: The Kubernetes/Firecracker guest agent now finds a terminal's PTY slave without `readlink('/proc/<pid>/fd/0')`, which was the one probe it had and was answered by a kernel permission check it never declared (#512).

  **What was wrong.** `handleTerminal` spawns util-linux `script`, then walks `/proc` for the shell `script` forked, looking for a candidate whose fd 0 readlinks to `/dev/pts/<n>`. That path is used for three things — the `stty -F` resize, the pid whose kernel session a teardown signals, and never mistaking a pipe for a terminal — and the probe behind it is `ptrace_may_access`, which refuses a reader whose credentials do not match the target's. `/proc/<pid>/fd` is `dr-x------` owned by the target; `/proc/<pid>/stat` is world readable.

  Measured in a real kind cluster: with the reader's uid differing from the target's, `readlink` fails `EACCES` every attempt for the whole one-second budget while `script` is still alive, and the terminal answers `{"type":"error","error":"terminal PTY slave did not appear"}` — the reported symptom, reproduced byte for byte. With a root reader and a uid-1001 shell: `fd/0 = <EACCES>` while `/proc/<pid>/stat` reads and names `136:3 -> /dev/pts/3`, which is exactly the slave root sees through `fd/0` for the same live process.

  **What changed.** `readProcessStat` now also carries field 7, `tty_nr`, decoded with the kernel's own `new_decode_dev` (major 136 is devpts). `findPtySlave` still asks `fd/0` FIRST and behaves identically wherever it can answer — the fallback is only reached when the readlink fails or answers with something that is not a PTY slave, and the walk still returns the first candidate in breadth-first order, so the pid it reports is the one the fd 0 probe alone returned whenever that probe can answer at all. It also stops as soon as `/proc/<script>` is gone rather than spending the remaining budget on a released pid — and a terminal whose `script` has already exited is answered with its own `exit` frame instead of with this error, since the walk's failure there is a claim about a terminal that had already ended. The failure names what it could not read, and names only what it read: `terminal PTY slave did not appear (200 attempts, 1002ms; last children(): EACCES; last fd/0: EACCES; last stat: EACCES; script: alive)`. Every field is the LAST OBSERVATION of the probe it names rather than the last error that probe ever had, and `script`'s own line is a third value — `alive`, `gone`, or the errno that stopped it being read, so a host is never told `script alive` by a read that never happened. The leading phrase is unchanged, so anything matching on it still matches.

  **What is not proven.** Which condition in the reporter's cluster made the readlink fail for the whole budget. The uid-mismatch shape reproduced here looks impossible in the shipped image, where the agent, `script` and the shell are all uid 1001, and no run of the unmodified agent in a kind cluster (task-pod or workspace-pod shape) reproduced the failure. This release removes the dependency and makes the failure legible; it does not claim to have found the trigger.

  **Redeploy the guest image to get it.** `agent/agent.cjs` is baked into the guest images (`k8s/Dockerfile`, `packages/sandbox/agent/`), not shipped in the published tarball, so a deployment keeps the old agent until its image is rebuilt. `agent.cjs`, `entrypoint.sh`, the `Dockerfile` and the worker are all guest/deployment files outside the published tarball: no public type, export, wire shape, or documented default changes here, which is why this is a **patch**.

## 18.0.0

### Patch Changes

- Updated dependencies [e83dfe5]
- Updated dependencies [9661d16]
  - @namzu/sdk@43.0.0

## 17.0.2

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

## 17.0.1

### Patch Changes

- 27a1665: A kubernetes deployment with `egress.policy: { kind: 'no-network' }` can create
  sandboxes again. It could not before: every `create()` was refused with
  `KubernetesEgressPolicyMismatchError` — a host that maps that to a reason such
  as `sandbox-egress-policy-unverified` fails the run closed — and no policy an
  operator could apply would have cleared it.

  The named-object check compared `spec.egress` to the translation with a
  deep-equal, and a core `NetworkPolicy` never stores an empty rule list:
  `egress` is `omitempty` on the wire struct, so an object applied with
  `egress: []` reads back with no `egress` key at all, and a merge patch cannot
  put one back.
  `no-network`'s whole translation IS that empty list, so `undefined !== []` made
  the check unsatisfiable by any object a cluster can store. `verifyEgressPolicyApplied`
  now reads an absent `egress` as the empty list it is, in that one comparison.
  They are one policy and not merely one shape, because the check has already
  required `policyTypes` to include `'Egress'` on a core policy, and that alone
  denies all egress.

  Nothing else is loosened. A live object whose rule array is non-empty still
  fails a translation that intended none, and a live object with no `egress` at
  all still fails a translation that intended rules — an absent list means
  deny-all, which is not what config asked for. The comparison still exists to
  refuse an object enforcing anything other than what was intended.

  `patch`, and the reason it is not a `major`: this is not a change to the public
  surface. No export, field, option or default moved, and the accepted set grows
  by exactly the object the API server stores for the intent the deployment had
  already declared. The refusal that disappears is one no consumer could have
  been relying on — `no-network` is configured in order to create sandboxes, and
  the only thing the refusal ever did was prevent that — so no upgrade action is
  required and no deployment that passes today starts failing.

  There was also no setting that avoided the refusal, so nothing to unset:
  `egress.verify: 'named-object-only'` opts out of the UNION check and nothing
  else — `egressUnionVerificationEnabled` gates `verifyUnion`, while the
  named-object check runs on every create path regardless — so a `no-network`
  host was refused under either setting. The ways out were to configure no
  `egress` at all, or to fall back to `deny-all`, which allows the cluster
  resolver on port 53 and is therefore not the same boundary.

  Verified against a live `kind` cluster (v1.37), not only against a fake API
  server: the `no-network` manifest applied, the object read back with this
  backend's own client (a core `NetworkPolicy` stored with no `egress` key, and
  `kubectl patch --type=merge -p '{"spec":{"egress":[]}}'` does not restore one),
  and the real `verifyEgressPolicyApplied` run on what came off the cluster —
  refused before this change, verified after, with a live object carrying a rule
  and a live object carrying none both still refused.

- 9092a37: Nothing a consumer installs changes. The one edited file is
  `k8s/__tests__/entrypoint.test.ts`, which `package.json#files` excludes from the
  tarball; the harness only, and `entrypoint.sh` itself is deliberately untouched —
  runtime behaviour, exports, types and defaults are the same.

  `entrypoint.test.ts` has been intermittently red on `main`, twice in a release
  run:

  ```
  FAIL entrypoint.test.ts > entrypoint.sh prestop: the flush a stopping pod gets
     > returns rather than hanging when the init does not go
  AssertionError: expected 6 to be greater than or equal to 900
  ```

  The mechanism is a race in the harness, not in the image. `entrypoint.sh` reads
  `/proc/<pid>/comm` before it signals anything and exits 0 immediately when the
  name is not the init it expects — a fail-closed refusal the image must keep, and
  the reason `entrypoint.sh` is not what changed here. `spawnStandIn` echoed `$!`
  for a child that had not `exec`'d yet, so inside that window the hook read `sh`
  where the symlinked `tini` was intended, refused, and skipped its whole wait. The
  case then measured the refusal — a few milliseconds of elapsed time and a handful
  of ticks — instead of the flush it is about, and failed against a constant that
  looks nothing like the number it got.

  The fix is a bounded, loud-failing readiness poll, `awaitStandInExec`, routed
  through `spawnStandIn` so every stand-in call site gets it: cases now wait for
  the process to become the binary it was started as before they hand its pid to
  the hook. It waits for the SPECIFIC name rather than for `sh` to disappear,
  because the name is what the hook turns on and one call site deliberately wants a
  plain `sleep` to stay a `sleep`. A stand-in that died during the wait says so
  instead of waiting its bound out.

  It also refuses up front an expected name longer than the kernel can report: the
  kernel keeps at most 15 characters in `/proc/<pid>/comm`, so a longer name could
  never match and the wait would fail on its deadline rather than on the truth.
  Latent today — every stand-in this suite starts is named well inside the limit —
  and the guard exists so a future one is a one-line failure that names the limit.

  Verified: the race reproduced deterministically before the fix, 20/20 runs green
  under load after it, and removing the wait restores the failure byte-identically.

## 17.0.0

### Major Changes

- 1722448: **A `container:docker` sandbox with an egress allowlist now needs an internal
  network, a proxy image, and `container-network` reachability. Take this version
  if you use one; otherwise nothing you install changes shape.**

  The allowlist tier used to be enforced by `HTTP_PROXY` and nothing else. The
  proxy ran in the process that created the sandbox, on the host's loopback, and
  the sandbox kept ordinary bridge networking with full outbound reachability —
  `--add-host namzu-egress:host-gateway` was the only thing pointing traffic at
  it. Anything inside the container that opened a socket directly reached the
  network with the allowlist unconsulted. It is now a sibling container on an
  `--internal` network the sandbox is also on, which has no route off it: the
  sandbox's traffic reaches the internet only through that container, and
  everything else a host attaches to that network is a container on the sandbox's
  own subnet.

  **What a host using `EgressPolicy` of `static` or `resolver` must now do**, all
  three refused at `create()` rather than downgraded:

  1. `network` must be an `--internal` network: `docker network create
--internal <name>`. The network's `Internal` flag is read back from the
     daemon; the name is never trusted.
  2. `hostReachability` must be `'container-network'`. A published host port
     needs a route out and an internal network has none — the refusal names the
     mode to move to. **A host-side consumer (the CLI, direct dev) that reached
     the worker on `127.0.0.1:<port>` under an allowlist policy must move to a
     consumer on the internal network.**
  3. `egressProxyImage` must name the proxy image:

     ```bash
     pnpm --filter @namzu/sandbox build
     docker build -f packages/sandbox/egress-proxy/Dockerfile -t <tag> packages/sandbox
     ```

     It is a second image because the sandbox image is a string this backend
     cannot read, and the bind-mount alternative breaks on the remote-daemon
     deployment `container-network` exists for.

  `HTTP_PROXY` and friends are still set and now direct traffic rather than
  permit it: a tool that honours them goes through the boundary, one that ignores
  them fails `Network unreachable` instead of bypassing the policy.

  **Four behaviour changes to know about, all of them consequences of the
  boundary existing:**

  - A `resolver` policy is resolved at `create()` and at each
    `setNetworkPolicy()`, not per request. A resolver that rotates between those
    moments is not picked up until the next one.
  - `setNetworkPolicy()` replaces the proxy container rather than swapping the
    allowlist in place. The window between the two has no proxy in it and fails
    **closed** — no request is permitted that the new policy would refuse.
  - `brokeredCredentials` are passed to the proxy container's environment. They
    still never enter the sandbox; they are now readable by anything with access
    to the docker daemon, which should be treated as credential access. (On the
    way there the value goes through the `docker` CLI child's ENVIRONMENT, not its
    argv — an argv is world-readable in `/proc/<pid>/cmdline` on Linux.) Note also
    that `createSandboxProvider` has never forwarded `brokeredCredentials` at all;
    that pre-existing gap is unchanged.
  - `egressProxyUpstreamNetwork` (default `bridge`) is where the proxy reaches
    the internet. Anything else attached to that network can reach the proxy and
    use it, so name a dedicated one on a shared daemon. `'none'`, and the internal
    network itself, are refused: either leaves the proxy with no route out.
  - Everything else on the SANDBOX's internal network is reachable from the
    sandbox — a second sandbox, a second sandbox's proxy. That is a property of
    the network rather than of this tier; give each sandbox its own internal
    network when they should not see one another.

  `deny-all` and `allow-all` are unaffected beyond the internal network
  `deny-all` already required. `EgressProxy` gains two optional options
  (`bindHost`, `selfNames`) and the container entrypoint sets them; the class is
  otherwise unchanged.

- f1fd331: The container backend's worker now authenticates its caller, and a worker that
  cannot refuses to start on a routable bind. This is a `major` because the wire
  shape of a public surface changed: every route but `GET /healthz` now requires
  `Authorization: Bearer <NAMZU_SANDBOX_TOKEN>`, a missing or wrong token is
  `401 {"error":"unauthorized"}`, and a worker with no token will not listen on
  anything but loopback. A token that is set but cannot be answered — empty,
  padded, or carrying a character an HTTP header cannot hold — now refuses to
  start rather than leaving a worker that looks authenticated and refuses its own
  host.

  Nothing in the package's TypeScript API changed — no export was removed,
  renamed or narrowed, and `HttpWorkerClient` and `execViaHttpWorker` only gained
  an optional token parameter. What changed is the contract between this backend
  and the worker process it runs, and that contract is deployed separately: the
  worker lives in `packages/sandbox/worker/server.js`, which the tarball does not
  ship, so the image is built from whatever checkout the operator has.

  **What breaks, and for whom.**

  - **A worker image rebuilt from this release, paired with a host that predates
    it.** The old host injects no token, so the new worker refuses to start on
    the default `0.0.0.0` bind and every `create()` fails at readiness with the
    container already exited. The refusal names the variable. Bring the host up
    in the same step, or set the escape below.
  - **Anything that talks to the worker without going through this backend.** The
    route contract is now authenticated; a probe, a health-check script that
    calls `/execute`, or a hand-rolled client must present the token.
  - **The standby-pool backend.** A pooled worker built from this release will
    refuse to boot on its routable default bind, because this backend has no way
    to hand it a credential. The claim API admits exactly one property override,
    and it is not `env` — it is a config map, which on Linux reaches the container
    as a file mount under `/mnt/configmap/<containername>/<key>`, not as an
    environment variable, while the worker reads its token from `process.env` at
    startup. The platform does not validate config-map values either, and its own
    guidance is that a value affecting application security belongs in an
    environment variable. So the per-instance credential for this backend is NOT
    implemented here, and the change that would close the gap — a per-claim value
    in the config map, read by the worker — is written down in
    `docs/sdk/container-sandbox-worker.md` rather than half-built. A token on the
    shared profile does not fix it either: the worker would boot and then `401`
    every call the backend makes, because this backend's client is constructed
    without a token and it has no field to carry one.

  **A host and a worker from the same release need no configuration.** The
  container backend mints 32 random bytes per `create()`, hands the value to the
  docker CLI in its own environment (resolved by a valueless
  `--env NAMZU_SANDBOX_TOKEN`, so it is in no argv), and sends it as a bearer
  header on every call it makes. Upgrading both together is the whole migration.
  The token is per instance, never written to disk, and dies with the container.
  It is readable where a peer in the same container or a caller who can already
  talk to the docker daemon could read it — `docker inspect` shows it on the
  container config for the container's life — which is why it is per-instance
  rather than shared, and why it is a defence in depth behind network placement
  rather than a replacement for it.

  **The standby pool: place it first, decide about the credential second.** If you
  run that backend, the control that actually carries the exposure is the network,
  and it is the one to get right before anything else — `aci-standby-pool` already
  refuses to claim a container group without `subnetId` (unless you set
  `allowPublicAddress: true` and mean it), so the group sits on a private address
  and that network is what stands in front of the worker. The refusal is unchanged
  by this release; what has changed is that it is now the first half of the answer
  rather than the whole of it. The second half is the escape below, which is what
  makes a pooled worker start at all today: put
  `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` on the container group profile, with the
  group on a private address. It is needed there only because this backend cannot
  present a credential, and it turns a worker that cannot boot into one that
  serves inside that address. Read the standby-pool bullet under "What breaks"
  before taking that step, and note that a token on the shared profile is not an
  alternative to it.

  **For a deployment the container backend creates**, the escape is a migration
  tool rather than a destination: it is what keeps you running while the host and
  the worker image are brought up in the same step.

  **To keep the old behaviour on purpose**, set
  `NAMZU_SANDBOX_ALLOW_UNAUTHENTICATED=1` in the worker's environment — the
  container backend's `options.env` for a sandbox it creates, or the standby
  pool's container group profile for a pooled one. That gives the credential up
  rather than deferring it: with it set and no token, every route but `/healthz`
  is open to whoever can route to the container, which is exactly what the
  default used to be. On the pool, the address comes first and this second; on
  every other backend, both the host and the image should be upgraded in one step
  instead. Only `1`, `true`, `yes` and `on` count, in any case and with no
  surrounding whitespace; everything else — `= 0`, `= false`, `= " yes "` — means
  off, so the flag cannot turn itself on.

  Also unchanged, and worth repeating from the README: the transport is plain
  HTTP, so this is a bearer token over the wire and it is defence in depth behind
  network placement, not a replacement for it. See
  `docs/sdk/container-sandbox-worker.md`.

### Minor Changes

- 01fbc9b: Three additive declarations, no default changed and nothing removed:

  - `MicroVMBackendConfig.onExecTiming` — the self-hosted Firecracker tier's
    provider config gains an optional per-exec timing hook.
  - `FirecrackerTransportTiming` — exported from the package entry point, the
    shape that hook is called with.
  - `VsockTransportOptions.onExecTiming` — the same hook at the transport level,
    for a host that builds a `VsockAgentTransport` itself.

  A host that sets none of them sends, receives and waits for exactly what it did
  before: the timing accumulator is created only when the hook is set, and the
  `undefined` checks that skip creating it skip every clock read that would have
  filled it.

  The hook reports one `exec()`'s wall clock as named phases — `dialMs`,
  `reserveMs`, `executeMs` and `drainMs`, the four the Kubernetes tier's
  `onTiming` already reports, plus `firstFrameMs`, `terminatorMs` and
  `peerCloseMs` for the intervals inside the execute round trip. The three
  sub-phases are absent, rather than zero, when their phase was never reached; the
  four base phases are always present and use `0` for "this never happened" (a
  call that failed at the dial reports `executeMs: 0`). The payload is durations
  only: never the agent token, a command, its arguments, or any output.

  One behaviour change worth naming, because it is the reason the hook is useful:
  the transport's execution adapter and its `RemoteExecutionController` are now
  built per call instead of once per transport. That controller holds no per-call
  state, so nothing observable changes — but an adapter built once had nowhere
  per-call to accumulate into, and a single accumulator on the transport would
  have two concurrent `exec()` calls writing each other's phases. The Kubernetes
  tier's own transport has been arranged this way since it was written.

  `POST_RESPONSE_CLOSE_TIMEOUT_MS` (1 s) is unchanged and its behaviour is
  unchanged; it is now documented as what it always was — a reject-only guard
  that fails a socket whose peer never closes, never a wait a successful call
  pays. If your host puts a relay between this process and the guest, `peerCloseMs`
  is the number that tells you whether that relay holds the FIN: a hold **under**
  a second is reported there on a call that resolved, and a hold **at or past**
  a second fails the call with `vsock transport: exec peer did not close after
terminator`, reporting no `peerCloseMs` at all — the close in that case is the
  one this transport causes itself when the guard fires, and its own constant is
  not published as an elapsed time. So a resolved exec's fixed cost cannot be
  hiding in that window: whichever way the window goes, it is either reported or
  it is a rejection, and never a silent second.

### Patch Changes

- 656598a: Nothing a consumer installs changes. The one edited file is
  `src/backends/docker/__tests__/leaf-permissions.smoke.test.ts`, which
  `package.json#files` excludes from the tarball; runtime behaviour, exports, types
  and defaults are untouched.

  The `Sandbox smoke` workflow has been red on `main` since the docker hardening
  landed (`481fb8ff`, `--read-only` on by default). That case asserts that uid 1001
  cannot `mkdir` into the unbound `/mnt/user-data`, and it pinned the refusal to
  one spelling — `permission denied`. With a read-only rootfs the kernel answers
  `read-only file system` instead, because EROFS is consulted before the DAC check
  that would have produced EACCES. The property the case exists for never changed
  (a bound writable leaf would let the `mkdir` succeed, and the `--rc` assertion
  still catches that); only the kernel's wording did.

  The assertion now accepts either refusal and says why both are legitimate, so the
  next change to which check fires first is a one-line read rather than a day of
  red. `dash` and Docker are both absent from the machine this was written on, so
  the fix is verified by the workflow that runs this file, not locally.

- Updated dependencies [4e8cf5c]
- Updated dependencies [19abb2c]
  - @namzu/sdk@42.0.0

## 16.0.0

### Major Changes

- 11f7ea2: **A `.domain` allowlist entry is expanded on the config-level egress translation, a `specs` list on the applied object is refused, and a deployment that applied the old object must re-apply it before its next `create()`.**

  Everything here is stated against **`@namzu/sandbox@15.0.0`, the published release this one ships on top of** — its bytes as downloaded from the registry, not this branch's base. `15.0.0` emitted the config-level `.domain` entry verbatim and said so itself: its release notes call "that a config-level `.domain` entry matches no answer at all" a pre-existing defect "left exactly as it was and deferred to its own change". This is that change, and the deferral is what the migration below is for.

  `config.egress.policy = { kind: 'static', allowedHosts: ['.example.com'] }` under `engine: 'cilium'` therefore emits `toFQDNs: [{ matchName: example.com }, { matchPattern: '*.example.com' }]` where `15.0.0` emitted `toFQDNs: [{ matchName: '.example.com' }]` — the entry VERBATIM, leading dot included. No DNS answer carries a name with a leading dot, so the old object matched nothing, and nothing refused it on the way in: the shipped admission fence's `matchConditions` scope it to the sandbox host's ServiceAccount, so an operator applying the config-level object is not matched by it at all. `verifyEgressPolicyApplied` then deep-equalled what was sent, the create reported success, and the domain and every subdomain it was asked to allow were DENIED. With `ciliumNarrowing.dnsNames` on it was worse than useless, because the DNS-visibility rule carried the same unmatched names — the DNS proxy denied the lookup the `toFQDNs` half needs before that half could ever learn an address.

  `SandboxNetworkPolicy.allowedHosts` has always said `.example.com` is the domain **and its subdomains** — `packages/sdk/src/types/sandbox/index.ts` — and `src/egress/allowlist.ts` implements exactly that for the docker backend's proxy. The Kubernetes PER-SANDBOX translation already honoured it. The config-level translation now reuses the same helper, so the entry becomes `matchName: example.com` plus `matchPattern: '*.example.com'`, and the DNS-visibility rule carries the names that expansion admits — `matchPattern: '*.<host>.<suffix>'` under every cluster search suffix, which is what the per-sandbox path already emitted.

  **Every consumer-visible change, against `15.0.0`.** Nothing changes for an allowlist with no leading-dot entry: the expansion returns `[{ matchName: entry }]` for an exact host, the DNS rule's wildcard branch is keyed on the leading dot alone, so every other entry's bytes are identical, with and without `dnsNames`, and no entry's letter case is rewritten. The rest is this list, and each item is a create or a compile that behaves differently after the upgrade:

  1. **A config-level `.domain` entry changes the object it emits**, so `verifyEgressPolicyApplied` — which compares the applied object to the translation exactly — refuses your next `createKubernetesWorkspace` or `create()` with `KubernetesEgressPolicyMismatchError` until you **re-apply the manifest this backend now translates**: the same `kubectl apply` you ran for the old one, against a cluster object that admitted nothing. That is the whole migration.
  2. **A config-level allowlist entry that is not a hostname is refused, by name.** `.com`, `.`, `..example.com`, `*`, `*.example.com`, a URL, a port suffix and an IP literal were each passed straight into the emitted `toFQDNs` by `15.0.0`: the per-sandbox writer validated them, the config-level translation did not. Refused now, with `KubernetesNetworkPolicyHostError` and nothing written, because both halves of what they used to do are wrong — as emitted by `15.0.0` they became a `matchName` that matched nothing, and with the expansion above `.com` would instead emit `matchPattern: '*.com'` and grant every name under a public suffix, silently, on a path no admission policy covers. `.example.com`, `example.com` and `api.example.com` are all still accepted, and a `resolver` policy's returned hosts are held to the same grammar. **A create whose allowlist carries one of these works on `15.0.0` and fails after this upgrade**, until the entry is corrected.
  3. **`KubernetesNetworkPolicyHostError` loses its third constructor argument.** `15.0.0` ships `constructor(host, reason, options?: { stateHostnameGrammar?: boolean })` on that class, which is exported from the package root; this release ships `constructor(host, reason)`. A consumer that constructed one with three arguments fails to COMPILE (an extra argument is an error in TypeScript), not merely at runtime. The option existed only to suppress one sentence in the config-level refusal, whose reason for existing — a translation that reaches the object as a literal `matchName` admitting nothing — is gone, because the entry expands on both paths now.
  4. **The `.domain` plus `tlsServerNames` refusal reads as one sentence on both paths.** What is refused is unchanged, and the refusal is still `KubernetesNetworkPolicyHostError` with nothing written; the words changed, because `15.0.0`'s config-level message described a translation that did not expand the entry — which no longer exists. A caller matching that message's text sees new text.
  5. **A live egress object carrying a `specs` list is refused outright.** A `CiliumNetworkPolicy` carries EITHER one `spec` or a `specs` list, and a rule in either one enforces; the named comparison reads `spec.podSelector`/`spec.endpointSelector`, `spec.policyTypes` and `spec.egress` and nothing else. `15.0.0` read `spec` and reported a match, so an object whose `spec` matched the translation and whose `specs` entry stayed inside the allowlist verified and created — and under `verify: 'named-object-only'`, where nothing else looked at it, so did one whose `specs` entry allowed more. It is a mismatch now, with `KubernetesEgressPolicyMismatchError` naming `specs`. The translation never emits a `specs` list, and the shipped admission fence refuses one for the same reason, so every affected object is a hand-edited one.

  **That re-apply passes, which is not a detail.** Under the default `egress.verify: 'union'` the union check reads the namespace's policies and refuses any that allows more than the translation — and with the expansion in place that has to include the named object, or the fix would refuse the very object it tells an operator to apply: the allowance this check builds records a `toFQDNs` entry by its `matchName` alone, so the expansion's `matchPattern` would read as a widening, permanently, however many times the manifest was re-applied. The check therefore leaves exactly the document the named comparison read — the one built from the object's own `spec` — unjudged, while still reading the named object for the one thing that comparison cannot answer: whether it puts this pod in egress default-deny. So a deployment whose only applied policy is the object this backend names still creates; a second policy — anything else that selects the pod and allows more — is still refused by name; and a `specs` entry is judged like any other object's rules, which is item 5's rule seen from this side.

  **Why `major`, not `patch`.** Bump intent is a claim about the consumer of the version they are on, and against the published `15.0.0` three arguments carry it. (i) A deployment whose config-level allowlist contains a `.domain` entry has a create that succeeds today and fails after this upgrade until an operator re-applies — the emission it depended on was useless, but the failure the upgrade produces is one an operator sees and has to act on. (ii) A deployment whose allowlist contains one of the entries in item 2 has a create that succeeds today and fails with a named refusal after it. (iii) A consumer that constructs the public `KubernetesNetworkPolicyHostError` with its documented third argument no longer compiles, which is a removed part of the public API whatever it did. `@namzu/sandbox`'s own precedent is the same shape: the egress-kinds release was `major` because a deployment with a second policy selecting the sandbox pods began failing `create()` where it used to succeed.

  **Also in this release, and already published in `15.0.0`'s notes rather than here:** `ciliumNarrowing` and the per-sandbox `setNetworkPolicy` policies. Their changeset files were consumed by the `15.0.0` release and are deleted from this branch for that reason — the text lives in the published CHANGELOG, and a pending changeset for it would publish it a second time.

  **Not proven here.** That a Cilium L7 proxy admits `example.com` and its subdomains and nothing else under the emitted pair, and that an uppercase `matchName` (`API.example.com`, emitted exactly as written, as every release has) is admitted by one. This repository has no cluster with a Cilium data plane, and the `kind` cluster its Kubernetes tests use enforces no policy at all, so the translation is pinned and the ENFORCEMENT of it is not.

- 481fb8f: `container:docker` completes its hardening baseline, and a container's root
  filesystem is now read-only.

  **Before:** the backend passed `--cap-drop=ALL` and
  `--security-opt=no-new-privileges` and nothing else of its own, so every path
  inside the container was writable, the container's IPC namespace was whatever
  the host daemon's `default-ipc-mode` said about sharing it, and CPU was the one
  resource of the three that had no way to be bounded at all.

  **After:** `--ipc private` and `--read-only` are applied to every container, the
  four paths that have to stay writable are mounted `--tmpfs` (`/tmp`, `/var/tmp`,
  `/workspace`, `/home/namzu`, each named with its reason in
  `src/backends/docker/index.ts`), and a new `cpuLimit` renders `--cpus`.

  **What breaks.** A workload that writes inside the container outside those four
  paths and the layout's own RW binds — `/opt`, `/srv`, `/etc`, or the `HOME` of an
  image whose user is not `namzu` — now fails with `EROFS` instead of succeeding.

  A second and much narrower break, in the same class: `--ipc private` makes this
  container's IPC namespace un-joinable. Docker's `--ipc container:<name>` is gated
  on the target having a shared-memory directory to enter, and a container created
  `private` has none — so a container that reached into a sandbox's shared memory,
  semaphores or message queues that way, which it could because these sandboxes
  were created `shareable` on any host whose daemon was configured with
  `default-ipc-mode: shareable`, is now refused by the daemon.

  Scratch also lives in RAM now rather than on the container's writable layer. A
  temp file larger than half the host's RAM, or larger than `--memory` when the
  host set one, fails with `ENOSPC` or is OOM-killed, where writing it to disk used
  to succeed. Any workload that spills more than its memory budget into `/tmp`,
  `/var/tmp` or `/workspace` is in that group.
  Everything the reference image does keeps working: `/tmp` stays executable
  (docker's own `--tmpfs` default is `noexec`, which would have turned
  `gcc -o /tmp/a.out … && /tmp/a.out` into `Permission denied`), and `HOME` stays
  writable, which is what LibreOffice, matplotlib and npm need.

  **What to do.** For an image of your own, name what it needs writable in
  `writableRootfsPaths`; each entry becomes a `--tmpfs`, so it is scratch rather
  than persistence. For a workload that spills more scratch than its memory
  budget, move the spill rather than the baseline: `layout.scratch` is a bind to a
  host directory and is still disk-backed, so give the layout one on a host
  directory with room and point the workload at it with the per-call `env` option
  — `TMPDIR` set to that container path — which keeps the read-only root
  filesystem, the four paths above and the resource bounds. To give the
  filesystem back — every path inside the container writable again — set
  `readOnlyRootfs: false`. That turns off that one control: `--ipc private` is
  applied whatever it says, so what it produces is the argv from before plus that
  one flag, not the argv from before.

  `cpuLimit` is opt-in and has no default, deliberately: a number chosen here
  would throttle a run that finishes inside its timeout today, and the right value
  is a property of the host's machine. It is new surface, and no workload that
  works today can fail because of it.

  SemVer: **major**, because two defaults changed in ways a working workload can
  fail under. The additive parts (`cpuLimit`, `writableRootfsPaths`,
  `readOnlyRootfs`) would be a `minor` on their own.

## 15.0.0

### Major Changes

- a5c19bf: A Kubernetes API request that the API server accepts and never answers now fails after 30 seconds instead of hanging forever.

  **What changes for you.** Every request `createKubernetesClient` sends carries its own bound — `apiRequestTimeoutMs`, default `30000` — on top of whatever `AbortSignal` the caller passed. It covers `getToken()`, the connection and reading the body, on both the `fetch` and the `node:https` path. Expiry rejects with the new `KubernetesApiTimeoutError`, which carries the verb, the resource path and the bound that expired, and never the bearer token; it is deliberately not folded into the generic `kubernetes … failed:` error, so a caller can tell a timeout from a refusal. A caller's own abort behaves exactly as it did. **To keep something closer to the old behaviour on a genuinely slow cluster, raise the number** — `apiRequestTimeoutMs: 120000`, say. There is no value that disables the bound: `0` and anything below the `1000` floor are refused at construction.

  **Why a signal was never enough, and why this is worth a major.** `signal` is optional on every one of these calls, and several of them are single-flight promises that run under whichever caller arrived first and never consult a later one's. A workspace `suspend()` is one: a plain `destroy()` joins it, a `resume()` queues behind it, and while it is in flight the handle's state is `suspending`, so every data-plane call is already refused. One signal-less call against an unanswering API server therefore pinned the entire handle, and a host calling `destroy()` during shutdown hung until it was killed. The same shape applies to the task backend's shared egress verification and to a joined teardown. Putting the bound in the client covers those, the standalone workspace verbs and any verb added later, with no wiring at each call site.

  A timeout cannot tell whether the request was applied, and nothing pretends otherwise: `suspend()` restores the state it saw and re-sends its idempotent patch, a create `POST` that timed out but did land is adopted through the 409 path, and a `DELETE` that had already applied counts as done.

  **Also in this release, and opt-in rather than a changed default: stream liveness.** Once `openTerminal` or `openTcpConnection` reported ready, the transport cleared its read-idle timer — correctly, since a quiet shell is healthy — and nothing replaced it, so a peer that vanished without a FIN or an RST left `exited`/`closed` unresolved on the host and the shell's process group alive in the guest until the pod stopped. Streams now trade a `{ type: 'heartbeat' }` frame every `streamHeartbeatMs` (new on the Kubernetes backend config, default `15000`, `0` sends none). Three consecutive intervals with nothing at all arriving end the stream: the host resolves `exited` with `exitCode: -1`, exactly as a closed socket already produces, and resolves `closed`; the guest runs the same cleanup a closed socket runs. Both sides count bytes rather than whole frames, so a large frame still on its way proves the peer is there; silence while a side has paused reading for backpressure is not counted, in either direction; and each side polls at a quarter of the interval, so a dead stream is noticed within three intervals plus at most one more tick — 45 seconds plus up to 3.75 more at the default. TCP keepalive is enabled on both ends of the routed connection as well.

  The heartbeat is **negotiated per stream and off unless both peers asked**, so no existing stream's behaviour changes: the open request carries the interval, an agent that implements it echoes the interval it will use in its `ready` event and only then starts sending, and the host only starts once that echo arrived. The echo is a number from the pod and the host times its own watchdog with it, so the host honours it only between `100` ms and four times what it asked for; this agent clamps to the same floor before echoing, so an honest echo is never altered. An agent built before this change ignores the unknown field and echoes nothing; an older host never asks and is therefore never sent a frame type it would treat as a protocol error. The guest advertises `stream-heartbeat` in its `healthz` `features` and the guest wire protocol version is unchanged, so no host and no golden image has to roll with this release.

  **The Firecracker tier is untouched.** `VsockTransportOptions.heartbeatMs` is new and undefined by default; only the Kubernetes backend opts in. A default on the shared transport would have force-closed an existing consumer's quiet-but-alive terminal after 45 seconds, which is a changed default for a tier this change does not claim. Keepalive is set on the routed `tcp` arm only.

  New on `KubernetesBackendConfig`: `apiRequestTimeoutMs` and `streamHeartbeatMs`. Newly exported from `@namzu/sandbox`, all additive: `KubernetesApiTimeoutError` and the type of its `verb`, `KubernetesHttpMethod`; `DEFAULT_API_REQUEST_TIMEOUT_MS` and `MIN_API_REQUEST_TIMEOUT_MS`; `DEFAULT_STREAM_HEARTBEAT_MS`; and, for a host writing its own guest or asserting what this one advertises, `STREAM_HEARTBEAT_FEATURE`, `STREAM_HEARTBEAT_MISS_LIMIT`, `MIN_STREAM_HEARTBEAT_MS`, `STREAM_HEARTBEAT_MAX_ECHO_FACTOR` and the type `StreamHeartbeat`. `createKubernetesClient` takes an optional second `KubernetesClientOptions` argument. Nothing on the SDK's `Sandbox` changes, so no `@namzu/sdk` changeset accompanies this.

- 3a6651c: A Kubernetes acquire that fails now says why, in a field. `create()` rejects with `KubernetesAcquireError` rather than a plain `Error` or a bare `ReadinessPollTimeout`, and a transient API failure during readiness is retried inside the readiness budget instead of ending the acquire on sight.

  **What breaks.** Two things, and both are about what a caller catches or how long it waits.

  1. **The thrown type changed.** A `create()` that ran out of readiness budget used to reject with `ReadinessPollTimeout`; it now rejects with `KubernetesAcquireError` carrying `reason: 'not-ready'`, with the `ReadinessPollTimeout` as its `cause`. A host doing `catch (e) { if (e instanceof ReadinessPollTimeout) … }` around `create()` must look at `e.cause`, or — better — switch to `e.reason`. A host matching message text does not survive at all: the message for a diagnosed refusal is new. `KubernetesWorkspace` is unaffected — the workspace lifecycle does not go through acquire and still raises `ReadinessPollTimeout` directly.

  2. **A doomed `create()` can now take the full `readyTimeoutMs` where it used to fail in milliseconds.** A readiness `GET` that fails with a connect error, an `apiRequestTimeoutMs` expiry, a 429 or a 5xx is repeated inside the existing readiness deadline, honouring the server's `Retry-After` (which may only slow the poll down, never speed it past `readyPollIntervalMs`). One clock, so a retry spends the budget rather than extending it and `create()` still cannot outlive the timeout its caller chose — but with the default 60 s budget, an acquire against an API server that is down now rejects after 60 s instead of after one round trip. A host with its own outer timeout will notice. To keep the old latency, lower `readyTimeoutMs`. The create `POST` is never retried: it is not idempotent, and a POST whose answer never arrived may already have committed.

  **What you get for it.** `KubernetesAcquireError.reason` is one of `api-unreachable`, `api-timeout`, `forbidden`, `claim-rejected`, `capacity`, `image-pull` or `not-ready`, with a `retryable` flag and the original failure as `cause`. A burst past node capacity and an API outage were previously the same plain `Error`, separable only by matching message text any release is free to reword.

  And a claim the controller has already **refused** no longer waits out the clock. Four `status.conditions[Ready]` reasons mean decided rather than not-yet — `WarmPoolNotFound`, `TemplateNotFound`, `InvalidMetadata`, `EnvVarsInjectionRejected` — and meeting one ends the acquire on the first read, carrying the controller's own reason and message on `controllerReason`/`controllerMessage`. Measured against agent-sandbox v1.0.2 on Kubernetes v1.37.0: a claim naming a warm pool that does not exist is refused in 233 ms against a 60 000 ms budget, with the claim deleted behind it. Those four strings were read off a live controller rather than copied from a changelog, and any other reason still falls through to the deadline — an unrecognised one is never guessed at.

  `capacity` (`PodScheduled=False`/`Unschedulable`) and `image-pull` come from a single pod `GET` made only after the budget has already gone, and before the cleanup `DELETE`. When a pod condition and a retried API failure both describe one refusal — the ordinary state of a saturated cluster — the pod condition decides, because it is what the cluster published about this pod; and a failure the poll recovered from is forgotten rather than carried to the end, so it can neither rename a diagnosed refusal nor be quoted by a poll that simply ran out of time. Nothing on the successful path reads anything it did not read before: a clean acquire issues exactly the requests it issued in the previous release, pinned by a request-log test.

  **Newly exported from the package root**, because catching by class is not possible from outside otherwise: `KubernetesAcquireError` and its `KubernetesAcquireFailureReason`, `TERMINAL_CLAIM_REASONS`, `ReadinessPollTimeout`, `KubernetesApiError` (new — it carries the verb, path, `status`, the `Retry-After` the server sent, and whether the failure was a connect or a status), `KubernetesApiFailureTransport`, `KubernetesCredentialError`, `KubernetesAlreadyGoneError`, `KubernetesConflictError`, and the three egress refusals `KubernetesUnenforceableEgressPolicyError`, `KubernetesEgressPolicyNotAppliedError` and `KubernetesEgressPolicyMismatchError`. Nothing was renamed or removed, and `@namzu/sdk` is untouched.

  **A refusal this taxonomy cannot honestly diagnose is not filed under the least wrong reason** — a malformed template, a 400 from an admission webhook, a controller that reported `Ready` and named no sandbox all travel out as themselves. That is deliberate: a `reason` that meant "something else" would be worth nothing to the host reading it.

- ff6134f: The Kubernetes backend now refuses to create a sandbox when ANY policy selecting its pods lets out more than `config.egress` says — not just when the one object it GETs by name has drifted. A deployment with a second `NetworkPolicy` over those pods, including the controller-managed one a `SandboxTemplate`'s own `networkPolicy` block becomes, used to work and now fails with `KubernetesEgressPolicyUnionError`; `egress: { policy, verify: 'named-object-only' }` restores the previous single-object check exactly. This is the SECOND default-on refusal in this release — the other is `KubernetesIngressPolicyError`, which is about the agent port being reachable INBOUND. They are distinct classes, and each message opens by naming what it refused.

  What was open before: verification GETted one object, compared it to the translation exactly, and memoized the pass for the whole life of the backend. The API server UNIONS every policy selecting a pod — traffic leaves if any of them allows it — so that check could only ever prove one policy was not the problem. In agent-sandbox v1.0.2 a `SandboxTemplate` that sets `networkPolicy` has its egress translated verbatim into a managed policy, and a template that omits the block gets a controller default allowing `0.0.0.0/0` minus RFC 1918 and `169.254.0.0/16` INSTEAD — not underneath. So deleting a `networkPolicy` block opened the internet (and left `100.64.0.0/10`, `127.0.0.0/8` and `168.63.129.16/32` reachable) while `namzu-task-egress` still verified perfectly. The shipped `sandboxtemplate-task.yaml` said that managed baseline "still applies underneath"; it does not, and that comment is corrected here.

  Two new Kubernetes-only kinds on `KubernetesEgressConfig.policy`. `{ kind: 'no-network' }` emits `policyTypes: ['Egress']` with no rule at all: nothing leaves the pod, the cluster's own resolver included, which is what `deny-all` never meant — `deny-all` allows UDP/TCP 53 to `kube-system`, and a cluster resolver forwards outside names upstream. A `no-network` sandbox resolves nothing; the agent needs no resolver because the host dials in, but a workload that resolves anything fails, which is the point. `{ kind: 'public-internet', exceptCidrs? }` emits DNS to the resolver's own pods plus `0.0.0.0/0` except `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `169.254.0.0/16`, `127.0.0.0/8` and `168.63.129.16/32`, and `::/0` except `fc00::/7`, `fe80::/10` and `::1/128` — out, but not sideways to the node, the service network, the API server, instance metadata or another sandbox pod. `exceptCidrs` adds to that list and is routed to the block of its own address family; an entry that is not a CIDR is refused at construction with the new `KubernetesEgressPolicyConfigError`.

  **`deny-all` and `allow-all` emit byte-for-byte what they always have.** Nothing about them changed, deliberately: verification of the named object is an exact match, so tightening either translation would stop every already-applied policy from verifying and fail every `create()` until an operator re-applied it. A test pins both manifests by deep equality. The tier-wide `EgressPolicy` union is untouched, so nothing changes for the process, container, Firecracker or ACI tiers and `@namzu/sdk` is not affected.

  What runs now, by default, wherever `config.egress` is set: the named-object check exactly as before, and then, at the same two points the ingress check already runs — before the POST for a directly created Sandbox, after the bind for a claimed one, and before any resume patch on `createKubernetesWorkspace` — a LIST of the namespace's `NetworkPolicy` objects (and, under `engine: 'cilium'`, that CNI's CRD), evaluated against the pod's real labels. It refuses when a selecting policy allows a destination the translation does not (`refusal: 'policy-widens-egress'`; under `no-network`, any egress rule at all), when nothing selecting the pod puts it in egress default-deny so the translation bounds nothing (`'no-enforcing-policy'`, skipped under `allow-all`), or when a policy, peer, port or collection cannot be read (`'not-evaluable'`). The refusal carries the pod's labels and every policy examined with a verdict each. A pass is cached per label set for at most five minutes — not for the backend's lifetime — and a failure is never cached. Subset is decided conservatively: a second policy passes only when the check can show it is inside the translation, and anything it cannot place inside refuses.

  To take this upgrade: run one `create()` against each namespace and read the refusal if there is one — it names every policy it examined, so the fix is the line that says `widens-egress`. In practice that means removing or narrowing the placeholder rule in `k8s/manifests/networkpolicy.yaml`, and keeping a template's inline `networkPolicy` egress inside whatever `config.egress.policy` names. `k8s/manifests/rbac.yaml` already grants `list` on `networkpolicies` (and on `ciliumnetworkpolicies`) for the ingress check; without it this check refuses with `not-evaluable` naming the missing verb. A host that cannot be granted it, or that accepts the union it has, sets `egress.verify: 'named-object-only'` and says so on purpose.

  Also new on the public surface: `KubernetesOnlyEgressPolicy`, `KubernetesEgressPolicy`, `KubernetesEgressVerification`, `KubernetesEgressPolicyUnionError`, `KubernetesEgressPolicyConfigError` and the `EgressPolicyRefusal` / `EgressPolicyVerdict` / `ExaminedEgressPolicy` reporting types; `UnreadIngressPolicySource` is renamed `UnreadPolicySource` because both checks now report it, with the old name kept as a `@deprecated` alias. What no test proves: enforcement. `kind` accepts every `NetworkPolicy` and enforces none and runs no Cilium data plane, so every "it was blocked" probe there passes for the wrong reason — `k8s/scripts/egress-check.mjs` is the live check and runs two positive controls before it reads any result. Nothing about the guest wire protocol, the bind token, the privilege probe, ingress verification, suspend, resume or deletion changed.

- 984d966: A Kubernetes workspace's writes are now put on its disk before its pod stops, and `suspend()` asks for that by default.

  **What was wrong.** Nothing in the guest agent or the Kubernetes backend ever called `sync`, `syncfs` or `fsync`. A `write-file` answered `ok` as soon as the bytes were in the guest's page cache, and `suspend()` patched the pod away and waited for it to stop — a wait both the code and the docs treated as the point the disk was quiesced. It is not: a stopped pod means only that nothing is writing any more, and whether the guest's dirty pages reached the device depends on how the runtime tore the guest down. Measured on a cluster with a VM runtime class: the container was killed with exit 137 about a second into a five-second stop, while `kill -TERM 1` from inside the guest ended it cleanly in about a second.

  **Three operator-visible changes, in the order they will be noticed.**

  1. **`sandboxtemplate-workspace.yaml`'s `terminationGracePeriodSeconds` moves from 5 to 30, and the container gains a `preStop` hook** (`/entrypoint.sh prestop`: `sync -f` the workspace, signal pid 1, wait for it). **The 30 is a budget, not a measurement** — 15 s of it is the agent's own `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS`, the rest is for the hook and the kubelet — and it must be measured on your runtime, because it depends on the runtime class, the storage class and how much a workload leaves dirty. On the runtime measured above the stop lasted the whole grace period even though the container was gone in a second, so **this is roughly what every `suspend()` will cost there**, up from about 7 s. To keep the old behaviour, set `terminationGracePeriodSeconds: 5` in your own copy of the template and drop the `lifecycle` block; re-applying the manifest does not change an existing workspace, which carries its own copy of `spec.podTemplate`. Expect a `FailedPreStopHook` warning on every stop that worked: the hook ends pid 1 of the container's pid namespace and the kernel then SIGKILLs the hook with it, so the event records the success path rather than a defect. The hook's own wait is derived from the agent's bound rather than fixed — `ceil(NAMZU_AGENT_SHUTDOWN_DEADLINE_MS / 1000) + 2` seconds, 17 as shipped — because the kubelet runs the hook, waits for it, and only then signals pid 1: a shorter wait would end the hook mid-drain and hand the agent a stop signal sent only because the hook gave up. Raise `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` and the hook's wait follows; `NAMZU_PRESTOP_WAIT_SECONDS` overrides the derivation for an operator who wants to own the relationship. The hook signals pid 1 only after `/proc/1/comm` says pid 1 is the `tini` this image starts — a derived image that boots a different init sets `NAMZU_PRESTOP_INIT_NAME` or gets no signal (and a line on stderr) instead of an arbitrary process being killed. Note also that the grace-period countdown includes the hook's own unbounded `sync -f`, so the number to clear is `sync-time + NAMZU_AGENT_SHUTDOWN_DEADLINE_MS`, not 15 s alone. **`sandboxtemplate-task.yaml` keeps its own 5 s grace period and now sets `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS: 3000` inside it** — the same pair read the other way. The agent's `SIGTERM` handler is a bounded drain rather than the prompt exit it used to be, and with that variable unset its 15000 ms default outlived a task pod's 5 s grace period three times over: a task pod with anything still running at stop time was SIGKILLed mid-drain instead of exiting 0 on its own bound. The task template deliberately carries no `preStop` hook, and cannot at this grace period — the wait a hook derives from a 3000 ms deadline, `ceil(3000 / 1000) + 2` = 5 s, is the whole of it, leaving the kubelet no room after the drain — and a diskless task pod has nothing persistent for the hook's `sync -f` to flush in any case. What its 3 s bounds is a graceful stop of the guest's own processes: close the listener, quiesce what is running, exit 0.
  2. **`suspend()` and the `destroy()` that suspends now send the guest a `flush` op and wait for the reply before the `Suspended` patch.** Exactly ONE outcome stops the suspend: a guest that ANSWERED and could not confirm rejects with the new `KubernetesFlushUnconfirmedError` and **sends no patch at all** — the workspace stays running and serving, and the caller holds the guest's own message. That is a new way for `suspend()` to fail, and `suspend({ flush: false })` is byte-for-byte the suspend of every previous release. Everything else is reported and the suspend goes ahead, because `suspend()` is the verb an operator reaches for when a workspace has gone wrong: an image that cannot flush (an agent predating the op, or one with no `sync` to run) tells the host through the new `KubernetesWorkspaceOptions.onFlushUnsupported`, and a guest that cannot be REACHED to be asked — crashed, OOM-killed, off the network, or fenced with `agent_retiring` — through the new `onFlushUnreachable`, carrying the transport's error as its `cause`. Reaching an unreachable guest costs the transport's connect-retry budget (30 s) before the suspend goes on, so suspending a wedged workspace is slower than it was, but it still works: refusing there would leave exactly that workspace running and billing. A suspend already in flight that asked for no flush refuses a joining caller that wants one, the way an in-flight suspend already refuses a joining `quiesce` — which includes a plain `destroy()`, so that is the one shape in which `destroy()` in a `finally` block is not a no-op; `destroy({ flush: false })` joins such a transition deliberately. `suspend({ flush: { timeoutMs } })` and `destroy({ flush: { timeoutMs } })` raise what the GUEST may spend inside the `syncfs`, for a workspace that leaves more dirty than its 10000 ms default covers; the option is `boolean | { timeoutMs }`, the shape `quiesce` already had for `graceMs`, and the new `KubernetesWorkspaceFlushRequest` type is exported for it.
  3. **`writeFile` resolves later, and replaces rather than overwrites.** A reply of `ok` now means the bytes are on the device: the guest writes a temp sibling, `fsync`s it, renames it onto the target and `fsync`s the directory. Every write of any size is therefore atomic at the target — a write that fails leaves the previous contents rather than a truncated file — and the target's mode is carried onto the replacement, on a whole-body write and on a sequence's final part alike (a mode the guest cannot carry over fails the write rather than renaming a file that has a different one). The cost is one `fsync` per write (one per part sequence for a chunked body, on the last part, which covers the whole file). Four consequences of the rename now reach writes of every size, where before they reached only a part sequence — a body above about 5.9 MiB of raw content, the point at which one frame stops holding it, since 8 MiB is the frame's ceiling and not the body's: hard links to the target are broken (the other name keeps the old inode), the replacement is owned by the agent's uid whatever the previous file's owner was, the CONTAINING DIRECTORY must now be writable (overwriting a writable file inside a directory the agent's uid cannot write to used to succeed and now fails when the temp sibling is opened), and a `.namzu-write-….part` sibling is briefly visible to a `listFiles` or `walkFiles` racing the write. A fifth is the single-frame path's alone, and is one a part sequence never had: a basename over about 200 characters fails with `ENAMETOOLONG`, because the temp sibling's name is the target's plus 55 bytes — the host names a part sequence's temp file itself, with the target's basename truncated to 96 characters, so those never carried this one either before or after.

  **Also new, and additive:** `KubernetesWorkspace.flush(options?)` for the moments that are not a suspend (before a snapshot, before a drain), with `KubernetesFlushOptions`, `KubernetesFlushReport`, `KubernetesFlushUnsupportedError`, `KubernetesFlushUnreachableError` and the `FLUSH_FEATURE` string exported alongside it. The standalone `suspendKubernetesWorkspace` never dials a guest, so it cannot flush: it refuses an explicit `flush: true` rather than ignoring it. The agent's `SIGTERM` handler now stops accepting connections, stops every process the guest is running (the routine `quiesce` already used — there is one implementation of that, not two), flushes and exits 0, all bounded by `NAMZU_AGENT_SHUTDOWN_DEADLINE_MS` (15000 ms) with `NAMZU_AGENT_FLUSH_TIMEOUT_MS` (10000 ms) bounding one flush. That deadline is the only bound: a repeat `SIGTERM` is logged and ignored rather than exiting at once, because in a stopping pod the second signal is the kubelet's own — sent the moment the `preStop` hook returns — and not anybody asking for a shorter wait. `SIGINT`, `SIGQUIT` and `SIGKILL` are unhandled and still end the process immediately. The guest wire protocol version is unchanged: `flush` is an additive op advertised in the `healthz` `features` list, so no host and no image has to roll together with this release — and a guest advertises it only if it can perform one, since the flush runs `sync -f` and a derived image that strips coreutils has the code and no `sync`. A bare `sync` is deliberately not a fallback anywhere here, in the agent or in the hook: it flushes every mounted filesystem, and on a runtime sharing the host kernel that is the node's disks.

  **What is not proven.** That a kubelet runs a `preStop` hook under the runtime class the shipped manifests name was never measured — the three mechanisms above are deliberately independent for that reason — and no test can prove the device wrote what the kernel handed it. `k8s/scripts/suspend-resume.mjs` now covers a 5 MiB `writeFile` and a 100 MiB command-written file issued immediately before the suspend, and prints the suspend's own duration; that is the measurement to run on a real cluster before trusting the grace period this ships with.

- 87c5337: The Kubernetes-backend guest entrypoint (`packages/sandbox/k8s/entrypoint.sh`) now resolves and exports a writable `HOME`, `USER`, `LOGNAME`, `XDG_CACHE_HOME` and `XDG_CONFIG_HOME` before starting the guest agent, on both the root and non-root exec paths.

  **Before:** `setpriv --reuid=/--regid=` (the exec every pod ends with) changes only the running process's credentials, never the environment, so `HOME` stayed whatever it was before the drop — `/root` on every pod, since nothing in the container ever ran as anyone else first. `/root` is not readable or writable by the de-privileged agent uid (verified in #469), and `agent.cjs`'s `childEnvironment` copies every non-`NAMZU_AGENT_`/`NAMZU_SANDBOX_` environment variable into every `execute` and terminal child, so the broken value reached every process a task ever started: LibreOffice without `-env:UserInstallation`, `pip install --user`, npm's cache, and the fontconfig/matplotlib caches all failed against it.

  **After:** `entrypoint.sh` resolves a home once, before either exec site. It first tries `getent passwd "$AGENT_UID"` field 6 — the shipped image's own `useradd --create-home` already creates this directory (`/home/namzu` as built) owned by the agent uid, so this is the common case, and `USER`/`LOGNAME` come from that same passwd entry. If `getent` is missing, the uid has no entry, the entry names a directory under the workspace root, or the directory still cannot be made to belong to the agent uid, it falls back to `/tmp/namzu-home-$AGENT_UID` (created fresh, mode `0700`, owned by the agent uid, `USER`/`LOGNAME` set to `namzu`) — never under the workspace root, so it can never appear in `listFiles`, `walkFiles` or an archive. Only if both fail does the pod refuse to start. `agent.cjs` itself is unchanged: the propagation mechanism this relies on (`childEnvironment`) already carried `HOME` correctly — it just never had a correct value to carry.

  **Major, not patch:** this changes the guest's exported environment on the NORMAL path, for every task and workspace pod, not only in an error configuration. A derived image that depended on `HOME=/root` inside the guest — the only thing running as root before the privilege drop could have relied on — must now set `HOME` (and `USER`/`LOGNAME`/`XDG_*`, if it depends on those too) itself, after its own `FROM`, since this resolution runs unconditionally on every boot and always wins over whatever the base image set. A derived image that changes `AGENT_UID` needs no changes: it either already ships a passwd entry for that uid naming a directory it owns, or falls back to `/tmp` automatically.

  `k8s/scripts/capability-check.mjs` now also prints `$HOME`, whether it exists, and whether a probe write succeeded, informationally — like its existing `Seccomp` and set-id lines, this never fails the check itself.

- 29c510d: The Kubernetes-backend task `SandboxTemplate` (`packages/sandbox/k8s/manifests/sandboxtemplate-task.yaml`, and the kind overlay's `patch-task-no-runtimeclass.yaml`/`patch-workspace-filesystem-pvc.yaml`) no longer runs its container `privileged`. It now runs as `runAsUser: 1001`, `runAsGroup: 1001`, `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `capabilities: { drop: [ALL] }` and `seccompProfile: { type: RuntimeDefault }` — the container-level shape of the Pod Security Standards `restricted` profile.

  **Before:** every task sandbox pod started as root with the full capability bounding set and no seccomp filter possible (Kubernetes runs a `privileged` container unconfined regardless of any `seccompProfile` named alongside it). The guest agent itself was still deprivileged by `entrypoint.sh`'s `setpriv` before it ever ran — the acquire-time privilege probe (`src/backends/kubernetes/privilege-probe.ts`) verified that on every acquire, and still does — but anything else that ran in the pod (most concretely, a `kubectl exec` shell, since the image sets no `USER`) got uid 0 and every capability the pod granted, for no runtime reason: the task template mounts no block device, so `entrypoint.sh`'s only root-requiring step never ran for it.

  **After:** a task pod never has root or a capability at any point in its life. `entrypoint.sh` now branches on its own `id -u`: non-root, it execs `setpriv --no-new-privs -- tini -- node agent.cjs` directly (skipping the `--reuid`/`--regid`/`--clear-groups`/`--inh-caps`/`--bounding-set` flags a non-root process cannot run anyway), and refuses outright, naming the uid, if a device is set on a non-root pod — a misconfiguration that used to look like a silently-skipped format. `sandboxtemplate-workspace.yaml` is unaffected: it keeps `privileged: true`, because its device branch genuinely needs `CAP_SYS_ADMIN` to `blkid`/`mkfs.ext4`/`mount` a raw block device before dropping every capability itself.

  `k8s/Dockerfile` also strips every setuid/setgid bit its own packages carry (`util-linux`/`e2fsprogs` on `node:22-bookworm-slim` ship `su`, `mount`, `umount`, `passwd`, `chsh`, `chfn`, `gpasswd`, `newgrp`, `chage`, `expiry` and `/usr/sbin/unix_chkpwd` set-id) — defence in depth for a process that ever runs non-root without `--no-new-privs` set some other way, not something the entrypoint or the probe depend on. A task image `FROM`ing this one and layering its own packages on top must repeat that `find`/`chmod` step after its own installs.

  **Major, not patch:** a task pod's default runtime capabilities changed. A task workload that relied on root or an ambient Linux capability inside a task sandbox — mounting something itself, binding a privileged port, `CAP_NET_RAW`, writing to a path only root owns, invoking a setuid binary the image used to ship — worked before this change and fails now. To keep the old behaviour, fork `sandboxtemplate-task.yaml` (or patch it after applying) back to `privileged: true`, understanding that this also re-opens the capability surface the acquire-time privilege probe never covered (a `kubectl exec` shell, or anything else that bypasses the guest agent's own `setpriv`). The guest agent's own process tree is unaffected either way — it was already fully deprivileged by `entrypoint.sh` before this change, and the privilege probe's admission rule (all four capability masks zero, `NoNewPrivs` 1) is unchanged.

  No code on the published npm package's surface changed — `packages/sandbox`'s `files` array packs only `dist` and `src`, and none of `k8s/` is in it. The major bump is for the shipped Kubernetes deployment artifacts a consumer applies directly to their own cluster, which this repository documents and versions as part of `@namzu/sandbox`.

- edf1d79: The Kubernetes backend now refuses to create a sandbox whose agent port no applied policy closes. A deployment that never applied `packages/sandbox/k8s/manifests/networkpolicy.yaml` used to work, insecurely, and now fails with `KubernetesIngressPolicyError`; `ingress: 'unverified'` on the backend config restores the old behaviour for a deployment whose boundary lives somewhere a namespaced `Role` cannot read.

  What was open before: every `Sandbox` this backend POSTs directly — that is every persistent workspace and every task sandbox created with `warmPoolName` unset — carried no ingress policy at all unless an operator had applied that one manifest, and nothing checked. The templates' inline `networkPolicy` block looked like coverage and was not: the controller translates it into a policy selecting `agents.x-k8s.io/sandbox-template-ref-hash`, a label it writes only onto a Sandbox adopted out of a `SandboxWarmPool`. Measured on a managed cluster running a policy-capable CNI, pods created that way had enforcement on egress only, and TCP 1024 answered — with zero policy drops — from a pod in another namespace, a pod on another node, an unlabelled pod in the sandbox namespace, and host-network pods on both nodes. The guest agent's own source calls the network rule in front of that port the boundary; the bind token was the only thing actually in the way.

  What runs now, by default: before the POST for a directly created Sandbox (so a refusal leaves no Sandbox and no PVC behind), after the bind for a claimed one (where a refusal releases the claim), and before the POST on every `createKubernetesWorkspace` — including the adopt path, so a workspace whose port stopped being covered is refused asleep rather than woken up to be refused. The check LISTS the namespace's policies and evaluates their selectors against the pod's real labels, never a policy name, and passes only when at least one ingress-enforcing policy selects the pod and none of them admits a wide-open peer on the agent port. Policies union, so one open rule fails the check however many closed ones sit beside it. The refusal carries the pod's labels, the port and every policy examined with a verdict each, plus `unread` — the collections it could not enumerate, so a refused (403) or unserved (404) list is reported as such instead of as a namespace that holds no policy, and the action it names is granting the missing verb rather than applying a policy the check never got to look for. Every wire field is read defensively in one direction: one that arrives as something the schema does not declare (a `spec.ingress` that is not a list of rules, a `podSelector` that is not a selector, a Cilium `fromCIDR` that is a string) refuses rather than being read as its empty value, and a `CiliumNetworkPolicy` carrying `enableDefaultDeny: { ingress: false }` cannot count as coverage — it allows without isolating the endpoint — though what it admits is still read as an opening.

  To take this upgrade: apply `k8s/manifests/networkpolicy.yaml` (it is in the README's apply order already and in the kind overlay), and add `list` on `networkpolicies` to the host's `Role` — `k8s/manifests/rbac.yaml` now grants it, next to the `get` the egress check uses. Under `ingress: { engine: 'cilium' }` the same two verbs are needed on `ciliumnetworkpolicies`. A cluster that closes the port through a cluster-scoped policy, a service mesh or a cloud security group sets `ingress: 'unverified'`, which reads no policy and issues no request; that is a supported configuration, stated on purpose rather than inherited.

  Also new on the public surface: `KubernetesIngressConfig`, `KubernetesIngressEngine`, `KubernetesIngressPolicyError` and its `IngressPolicyRefusal` / `IngressPolicyVerdict` / `ExaminedIngressPolicy` / `UnreadIngressPolicySource` reporting types, plus `KubernetesBackendConfig.ingress`. This refusal is distinct by class from every other one a create can raise, so an open agent port is never confused with an unenforceable egress policy or a slow API server. Nothing about the guest wire protocol, the bind token, the privilege probe, egress translation, suspend, resume or deletion changed.

- f6bfb7d: Kubernetes workspace failure paths no longer suspend a workspace that is in use. Two observable defaults change, and a suspend on this backend deletes the pod — every terminal, dev server and running command in it, for every process holding the workspace.

  **A start that fails no longer always suspends.** `createKubernetesWorkspace` and `KubernetesWorkspace.resume()` used to send `operatingMode: Suspended` on any error while bringing a session up. The errors that reach that path include a caller's `AbortSignal` firing during readiness, a single 5xx or 429 on a Sandbox or pod `GET` (the client does not retry), and a privilege probe that overran its deadline — none of which is a fault of the workspace, and all of which a _second_ process meets while the _first_ is executing in the pod. A workspace id is a name and not a lock, so that second process is the ordinary case: a restart, or a second revision during a rollout.

  A failed start now patches only when the call itself moved the mode — it `POST`ed the object, or its `Running` patch took the object out of `Suspended`. An adopt of an already-running workspace, and a `resume()` that finds another process has already woken it, write nothing and rethrow. `resume()` reads `spec.operatingMode` before patching instead of patching blind, so it no longer claims authorship of a wake it did not perform (and no longer restamps `sandbox.namzu.ai/operating-mode-changed-at` for a mode that did not change).

  _To keep the old behaviour there is nothing to do for the case it was right about_: a workspace this call woke and then failed to start is still suspended, because leaving it `Running` with a pod nobody is using burns a node. If you want **no** patch on any start failure — you keep your own holder record and sweep idle workspaces yourself — pass `onStartFailure: 'leave'`, on `KubernetesWorkspaceOptions` for the handle or on `KubernetesWorkspaceTransitionOptions` for one `resume()`. The old blanket behaviour (suspend on every start failure, including another process's workspace) is deliberately not offered.

  One thing a failed start still does, unchanged, is leave the handle without a session: after a `resume()` that rejected without writing anything, `workspace.suspended` reads `true` although the cluster is `Running`. It is the handle's own state, not a claim about the object, and another `resume()` is the way back — `refresh()` reports only a suspension somebody else performed.

  **An unconfirmed cancellation no longer retires a workspace or sends a patch.** When an execution's cancellation could not be confirmed within the shared controller's eight-second window, the handle retired itself — which on a workspace meant the same `Suspended` patch. Eight seconds of network loss under one `exec()`, or a pod evicted under an in-flight command, therefore stopped the pod for everyone. Nothing is written now:

  - `exec()` still rejects with `RemoteCancellationUnknownError`;
  - it carries `retirement: { accepted: false, reason: 'workspace-kept' }` instead of `{ accepted: true }`. `reason` is a new optional field on `SandboxRetirementObservation`; `error` is absent, because nothing was attempted. **Code that reads `retirement.accepted` to mean "the pod was stopped" must read `reason` as well**;
  - the handle is not retired — `suspended` stays `false` and the next call is admitted;
  - one bounded `healthz` over a fresh connection reports through the new `onCancellationUnconfirmed({ error, agent })` on `KubernetesWorkspaceOptions`, where `agent` is `'ok'`, `'retiring'` (the guest fenced itself and only a new pod clears it) or `'unreachable'`.

  _To restore the old behaviour, call `suspend()` from `onCancellationUnconfirmed`._ Calling it only when `agent === 'retiring'` restores it for the case it was actually diagnosing.

  **A fenced agent is named.** A reservation refused with `agent_retiring` on this backend now rejects with the new `KubernetesAgentRetiringError` instead of `RemoteProtocolError: remote sandbox returned an invalid execution reservation`. Unlike the Firecracker tier's mapping of the same refusal it does not retire the handle: that mapping is `RemoteCancellationUnknownError`, which would take the workspace's pod away. Not retiring the handle is a statement about _this side_ — nothing was patched and the workspace is still `Running`; the guest's fence gates every op but `healthz` and `cancel-execution`, so reads, writes, terminals and tcp connections meet it too until the pod is replaced, and the message names the verbs that replace it on each tier (`suspend()` then `resume()` on a workspace, `destroy()` and a new sandbox on the task path).

  Nothing here adds a `DELETE`. `destroy({ deleteDisk: true })` and `deleteKubernetesWorkspace` remain the only paths that remove a disk.

  Also new on the public surface: `KubernetesWorkspaceStartFailurePolicy`, `KubernetesWorkspaceAgentState`, `KubernetesWorkspaceCancellationNotice`.

- 1d46ef4: A Kubernetes workspace call that used to fail with `unauthorized` after its pod was replaced now succeeds — against a **different guest**, where every process the caller started is gone. That is the changed default, and a host that keeps per-workspace state must subscribe to the new `KubernetesWorkspace.onGuestRestart(listener)` rather than assume continuity.

  Why the handle rebinds at all: the agent's bind token is the bound pod's `metadata.uid`, read once per session, and under the default `agentAddress: 'service'` the Service FQDN outlives the pod. So after an eviction, a node drain, or a `suspend()`/`resume()` another process performed, the dial kept succeeding against the replacement pod and its agent refused every call. Nothing recovered from that, and the refusal arrived in two unrelated shapes: `KubernetesAgentUnauthorizedError` for `exec` and `listFiles`, a bare `Error('unauthorized')` for `writeFile`, `readFile`, `openTerminal` and `openTcpConnection`.

  **What changed.** A refused call re-reads the `Sandbox` once and, when it finds the same `sandboxUid` and a live pod with a different uid, takes the new address and token and retries the call **once** — safe because the guest checks the token before dispatch, so a refused request ran nothing at all. The same pod uid leaves the original error standing. A **different** `sandboxUid`, or no `Sandbox` at all, now raises the new `KubernetesWorkspaceReplacedError` and never rebinds: the workspace name is deterministic, so that is a different object with an empty disk. Every operation that cannot be rebound now rejects with `KubernetesAgentUnauthorizedError`, so the bare-`Error` shapes are gone — code matching `error.message === 'unauthorized'` on those four calls must catch the class instead.

  **What is additive.** `KubernetesWorkspace.identity` (`{ sandboxUid, volumeClaimUids, podUid, guestBootId }`); `onGuestRestart`, which fires `pod-replaced` and `container-restarted` events and does not fire across the caller's own `suspend()`/`resume()` (the one exception being a pod somebody else replaced during that resume, where both halves of the payload still name their pod — `previous` the one the resume had bound, `current` the one it rebound to); `KubernetesWorkspaceReplacedError` and `KubernetesWorkspaceGuestGoneError`; and three fields on the `onCancellationUnconfirmed` notice (`guest`, `previous`, `current`). An unconfirmed cancellation whose guest is demonstrably gone now rejects with `KubernetesWorkspaceGuestGoneError`, which **extends** `RemoteCancellationUnknownError` — every existing `instanceof` and every read of `retirement` keeps working, and the rule is unchanged: the outcome is unknown and the command must not be retried automatically. The diagnosis is per command, and so is the identity it carries: `previous` is the guest the COMMAND reserved on — the pod its `reserve-execution` was accepted by and the agent process inside it — so neither a restart the handle survived earlier nor a pod another call has already rebound to is blamed on it, and `current` names an agent process only when that process belongs to the pod it names. A workspace somebody else suspended still rejects with `KubernetesWorkspaceSuspendedError`, not this class, so the handle adopts the suspension and `resume()` works. Nothing on this path patches the cluster, exactly as before.

  **Guest and cluster.** The agent stamps an optional `guestBootId` on `reserve-execution`, `cancel-execution` (including `unknown_execution`), `read-file`, `write-file`, and the terminal and TCP `ready` frames, advertised as `guest-boot-id` in `healthz` features. The wire protocol version is unchanged, so an older guest image reports nothing and a newer host keeps working against it — it simply loses the container-restart signal. The shipped `k8s/manifests/rbac.yaml` gains `get` on `persistentvolumeclaims`, used only to report `volumeClaimUids`; re-applying it is optional, since a Role without it leaves that map empty and changes nothing else.

  **To keep the old behaviour** — a refused call staying refused rather than rebinding — there is no flag: subscribe to `onGuestRestart` and drop your handle from the listener when `reason` is `pod-replaced`.

- b3db254: **Closing a terminal now kills everything the terminal started.** That is the
  one change here you did not ask for, and it is why this is a major. Before it,
  tearing a terminal down sent `SIGKILL` to the process group of util-linux
  `script` — and `script` starts the shell in a **new session**, so the kill
  reached `script` alone. `script`, the shell and the foreground job then died of
  the PTY hanging up, but a job backgrounded with `&` was never signalled: it
  kept running with no terminal, holding its port, reachable by no op, until the
  pod stopped. The agent's own comment claimed that kill reached "the shell and
  every descendant". It now does: both a session kill and a plain terminal's
  teardown signal every process still in the kernel session the shell was
  started in, found through `/proc`. **If you were relying on that leak** —
  starting a dev server with `&` inside a terminal and expecting it to survive
  the terminal — move it to `startDetached` below, which is the verb for a
  program meant to outlive its caller. Nothing else about a plain `openTerminal`
  changed, down to the wire request it sends.

  **What is new: a workspace terminal or program can outlive the host process.**
  A workspace is built to outlive the host — it carries no lease for exactly
  that reason — but the processes inside it were not. A terminal belonged to one
  connection, so a deploy, a crash or an OOM kill tore down every terminal the
  host had open. Replay was buffered in the host process, so its successor had
  neither the output nor a way to name the terminal. And nothing could run
  outside a terminal at all: `exec` caps at thirty minutes and kills the process
  group when the cap fires.

  All of it is on `KubernetesWorkspace`. `@namzu/sdk` is unchanged, and so is
  every other backend, the Firecracker tier included.

  - `openTerminal({ ...options, sessionId, persistent: true })` hands the PTY to
    the guest's session registry. Closing the connection then DETACHES and sends
    no signal of any kind; the session ends when its program exits, on
    `killSession`, or when the pod stops.
  - `attachTerminal(sessionId, { fromOffset, size })` rejoins it from any
    process, replaying what it missed and then following live, with input and
    resize working after the attach. At most one attachment exists at a time: a
    second attach ends the first by name, so two host processes cannot
    interleave keystrokes into one shell.
  - `startDetached({ sessionId, command, args, cwd, env })` starts a program with
    no PTY, stdin closed, in its own kernel session. `readSession(sessionId, {
fromOffset })` answers in the SDK's `BackgroundJobOutput` shape (`chunk`,
    `nextOffset`, `droppedBytes`, `status`, `exitCode`) — and a read is not an
    attachment: it displaces nobody and signals nothing, so polling a shell's
    tail leaves the terminal reading it alone. `listSessions()` names what is
    running, and `killSession(sessionId, { signal })` ends one and everything
    still in it; `signal` is one of `SIGTERM`, `SIGKILL`, `SIGINT` or `SIGHUP`
    and anything else is coerced to `SIGTERM`, the same on every connection.
  - Exported: `KubernetesSessionsUnsupportedError`,
    `KubernetesSessionRefusedError`, `AgentSessionDetachedError`,
    `SESSIONS_FEATURE`, plus the option and row types
    (`KubernetesOpenTerminalOptions`, `KubernetesAttachTerminalOptions`,
    `KubernetesStartDetachedOptions`, `KubernetesReadSessionOptions`,
    `KubernetesKillSessionOptions`, `KubernetesSessionSummary`,
    `KubernetesSessionOutput`, `KubernetesWorkspaceTerminal`,
    `KubernetesSessionTerminal`, `KubernetesSessionRefusal`, `SessionKind`,
    `SessionState`, `SessionDetachReason`).

  **`exited` on a session terminal can reject.** When the attachment ends and the
  program does not — the connection was lost, or another process took the
  session — it rejects with `AgentSessionDetachedError`, carrying the byte offset
  to come back at. Resolving it would report an exit that never happened, which
  is the confusion this whole feature exists to remove. A connection-bound
  terminal's `exited` is unchanged.

  **What you have to know before relying on it.** The registry is the pod's
  memory and is never written to disk, so `listSessions()` is empty after
  `suspend()` and `resume()`, and after any eviction, node drain or restart:
  this makes a program survive the HOST, not the pod. A session's output ring is
  the same `OutputLog` a detached execution uses — one monotonic byte-offset
  space, eviction reported as `droppedBytes`, never a shorter stream that looks
  complete — and output is read into it whether or not anybody is attached, so a
  program with no reader never blocks on a full PTY. No signal can follow a
  process that called `setsid` for itself: it has left the session, and nothing
  short of a PID namespace or a cgroup reaches it.

  **`spawnDetached` is still absent, deliberately.** It returns a host
  `ChildProcess` synchronously and its consumer keeps jobs in a map inside one
  host process, so it cannot express a hand-off between processes. `startDetached`
  has a different name because it does a different thing: it returns a NAME, and
  the name is what a redeployed host comes back with.

  **Redeploy the workspace image to get it.** The guest advertises `sessions` in
  its `healthz` features, and a host asking for any session verb against an older
  image is refused with `KubernetesSessionsUnsupportedError` — never downgraded
  to a connection-bound terminal. The guest wire protocol version is deliberately
  **unchanged**: `sessionId`, `persistent` and the four new ops
  (`attach-session`, `start-detached`, `list-sessions`, `kill-session`) are all
  additive, so no host and no image has to roll together with this release.

  Three variables join the shipped workspace template's `env` block at their
  defaults, so deleting them changes nothing: `NAMZU_AGENT_MAX_SESSIONS` (16
  sessions at once), `NAMZU_AGENT_SESSION_LOG_BYTES` (1 MiB of retained output
  each) and `NAMZU_AGENT_SESSION_TERMINAL_TTL_MS` (10 minutes an exited
  session's record and output outlive it). The first two bound what the registry
  can cost the container's 512Mi; a session exists only when a caller names one,
  so a deployment that never asks for one pays nothing.

### Minor Changes

- b52609b: Adopting a Kubernetes workspace whose previous pod is still terminating now waits for the replacement instead of failing.

  `createKubernetesWorkspace` on a name that already exists adopts the standing object, and the process that does so arrives at a moment the previous one did not choose: a `suspend()` that ended in `KubernetesWorkspaceSuspendTimeoutError` (the patch landed; the guest is riding out its `terminationGracePeriodSeconds`), two hosts coming up on one workspace during a rollout, or a host restarting inside that grace period. In each of those the only pod under the Sandbox's name carries a `deletionTimestamp` and is never bound to — its uid is the agent's bind token and the pod's replacement refuses it — while the replacement has not been created yet, so the bind-token read threw and the adopt rethrew it on the spot. It now polls for a live pod under the same `readyTimeoutMs` budget the resume path already polled under, and a budget that runs out names the pod that was still terminating rather than reporting a generic missing uid.

  An adopt of an object that was Running with a healthy pod is unchanged, and so is the created path: nothing is being replaced there, so a pod that cannot be read is still reported on the first read rather than waited out for the whole budget. Nothing about suspend, resume, deletion or the guest wire protocol changed, and no default moved.

  New on the public surface, and the reason this is `minor` rather than `patch`: `KubernetesWorkspace.origin`, typed by the new `KubernetesWorkspaceOrigin` union — `'created'`, `'adopted-running'` or `'resumed'`. It is fixed for the handle's life and says what the call walked into, not what state the workspace is in now (`suspended` is for that). A host reattaching to a workspace another process left behind needs it: on `'resumed'` the pod is brand new and only the disk survived, while on `'adopted-running'` the pod is the one the previous holder was using — a detached command may still be running in it, but no terminal is, because the guest agent kills a terminal's process group the moment its connection closes and a dead host's connections closed with it. Code that only reads a `KubernetesWorkspace` needs no change; code that implements the interface must add the field.

- a75f670: `config.egress.ciliumNarrowing` lets a `static`/`resolver` egress allowlist under `engine: 'cilium'` limit ports, DNS names and TLS server names instead of allowing an address, any port and any resolvable name. This is additive: with `ciliumNarrowing` unset, the emitted `CiliumNetworkPolicy` is byte-for-byte what it always was, pinned by a deep-equality test, so an already-applied policy keeps verifying after this upgrade.

  **Why.** Measured on AKS with Cilium 1.18.11: an unnarrowed allowlist's `toFQDNs` rule allows the ADDRESS a name resolved to, and one CDN address can serve many unrelated sites — `curl --resolve example.com:443:<registry.npmjs.org's own address>` returned the wrong site's content. It sets no `toPorts`, so `github.com:22` accepted a connection. And its DNS-visibility rule allows any name to resolve at all (`rules.dns: [{ matchPattern: '*' }]`), so DNS itself is an open channel out. `verifyEgressPolicyApplied` compares the applied object to the translation exactly, so an operator could not tighten any of this on the cluster without every `createKubernetesWorkspace` and provider `create()` failing.

  **What's new**, all opt-in on `KubernetesEgressConfig.ciliumNarrowing`:

  - `ports` (a default port list) and `hostPorts` (per-host overrides) — emitted as `toPorts` on each host's own `toFQDNs` rule. Setting either switches the translation from one shared `toFQDNs` rule naming every host to one rule PER host, so ports can differ host by host.
  - `tlsServerNames: true` adds `serverNames: [<host>]` to a host's TLS ports (default `[443]`, override with `tlsPorts`) — SNI enforcement, which needs Cilium's L7 proxy. A host with no port configured is limited to its TLS ports rather than left open, because a `serverNames` rule needs a port to attach to.
  - `dnsNames` (`true` or `{ namespace?, clusterDomain?, searchSuffixes? }`) replaces the DNS-visibility rule's `matchPattern: '*'` with an exact `matchName` per allowed host plus the host under `<namespace>.svc.<clusterDomain>`, `svc.<clusterDomain>`, `<clusterDomain>` (`cluster.local` default) and any configured extra search suffixes — exact names because Cilium's `matchName` does not match across a `.`.

  Setting any of these under `engine: 'core'`, or with a `deny-all`/`no-network`/`allow-all`/`public-internet` policy, throws the new `KubernetesEgressNarrowingUnsupportedError` synchronously — both from `buildKubernetesBackend` and from `createKubernetesWorkspace`, before any request — because narrowing only means something next to a hostname allowlist Cilium enforces. A port outside `1-65535`, or an empty `clusterDomain`/search suffix, is refused at construction with `KubernetesEgressPolicyConfigError`.

  Every new field becomes part of what `verifyEgressPolicyApplied` requires — no new comparison logic, it already deep-equals the whole `spec.egress` — so an applied object missing a configured `toPorts`, DNS name or `serverNames` entry throws `KubernetesEgressPolicyMismatchError` naming it. The union check that reads every OTHER policy selecting the pod now tracks ports per allowed hostname too, so a second `CiliumNetworkPolicy` naming an allowed host on a wider port (or with no `toPorts` at all) is caught as `policy-widens-egress` even though the hostname itself is on the allowlist.

  A `ports`, `hostPorts[host]` or `tlsPorts` list set to an explicit empty array (`ports: []`) is now refused at construction with `KubernetesEgressPolicyConfigError` — it was neither "no restriction" (that's what omitting the field means) nor usable, and would have emitted a `toPorts` shape the API server rejects on apply.

  **A shipped-manifest change you may need to make, now enforced rather than only documented.** `packages/sandbox/k8s/manifests/networkpolicy.yaml` and both `sandboxtemplate-{task,workspace}.yaml` templates' managed `networkPolicy` grant kube-dns on port 53 at plain L4, with no L7 rule. Cilium's own rule-precedence says an L4-only rule cancels the L7 portion of a similar rule that carries one — so if you turn `ciliumNarrowing.dnsNames` on, that plain rule defeats it: every name resolves again regardless of the narrower allowlist. Each shipped file says, at the rule itself, to delete it when `ciliumNarrowing.dnsNames` is set. Port and TLS-server-name narrowing need no manifest change; the translated `CiliumNetworkPolicy` grants the DNS access those two need on its own.

  That plain rule reaches the exact same peer and port the narrowed `CiliumNetworkPolicy` allows for DNS, so mere reachability cannot distinguish them. The union check (above) now can: `EgressAllowance` carries the exact DNS names a narrowed translation restricts lookups to, and the check reads a candidate rule's own DNS restriction (or the fact that a plain `NetworkPolicy` has none at all) before deciding it is within bounds. Leave the shipped rule in place with `ciliumNarrowing.dnsNames` on, and — under the default `egress.verify: 'union'` — the next `create()` now refuses with `policy-widens-egress` naming that policy, rather than silently letting the narrowing do nothing. `egress.verify: 'named-object-only'` does not run this check, so a deployment on that setting must still delete the rule by hand.

  **Unproven here, and the changeset says so rather than implying otherwise:** real Cilium L7 enforcement of any of these three options. The `kind` cluster this repository tests against runs no Cilium data plane, so a "the port is closed" probe there would pass for the wrong reason regardless of whether narrowing works; `k8s/scripts/egress-check.mjs` does not probe the hostname allowlist, narrowed or not, and its README section says so. Confirming enforcement needs a real Cilium cluster, a positive control (an allowed name still resolving and connecting) alongside the negative one, and ideally a `cilium policy trace`/BPF policy dump showing the narrowed rule is the one in force.

- f024b6b: The Kubernetes backend can now label its own task-path claims with a
  host-supplied identity, recover a crashed predecessor's claims by that label,
  and read warm-pool headroom before admitting more work. All additive; no
  default changed.

  A `SandboxClaim`'s own name is client-generated per acquire, so nothing about
  one said which host process created it. A host killed by a deploy, an OOM or
  a lost node left every claim it held running until `claimTtlSeconds` reaped
  it — an hour by default — and its replacement had no way to find, let alone
  release, them sooner. Three new pieces of surface close that gap:

  - `claimLabels?: Record<string, string>` on the Kubernetes backend config is
    written into every `SandboxClaim`'s `metadata.labels` only — never into
    `additionalPodMetadata`, so a running Sandbox's pod labels and any
    `NetworkPolicy` selecting by them are unaffected.
  - `releaseKubernetesTaskSandboxes(config, { labelSelector, signal })` LISTs
    claims by `labelSelector` and DELETEs each one, returning
    `{ deleted, names }`. `labelSelector` is **required** and refused, before a
    single request goes out, if it is absent or empty: a release that fell back
    to matching every claim would delete a live fleet's work.
  - `readKubernetesTaskCapacity(config, { signal })` is three GETs and no
    writes — the configured `SandboxWarmPool`, the claims collection filtered
    to that pool, and the pods collection counted by `Pending` phase — into
    `{ warmPool: { ready, desired }, activeClaims, pendingPods }`. Requires
    `warmPoolName`; there is no pool to report on for a backend that creates
    every sandbox directly.

  The shipped `k8s/manifests/rbac.yaml` gains `list` on `sandboxclaims` — the
  verb both new functions need to find claims by label instead of by a name
  they already know — so a deployment that does not re-apply it gets a `403`
  from either function alone, and never from `create()`. `sandboxwarmpools:
get` is unchanged but is now a documented backend need rather than only a
  diagnostic script's.

  A host setting no `claimLabels` and calling neither new function sends the
  exact requests it always has.

- b07cebc: A second, deliberately narrower Kubernetes `Role` now ships for hosts that acquire only from a warm pool, and the verb list it grants is exported from the package root as data.

  `packages/sandbox/k8s/manifests/rbac-claimant.yaml` is a `ServiceAccount` + `Role` + `RoleBinding` named `namzu-sandbox-claimant`, written in the same shape as the existing `rbac.yaml`'s. Bind a host that sets `warmPoolName` and never creates a `Sandbox` of its own to this ServiceAccount and it can claim, hold, release and enumerate pooled task sandboxes — nothing else.

  Why it exists: the existing Role grants `sandboxes: create`, and a namespace that also runs the privileged workspace template has to allow privileged pods, so any identity holding that Role can POST a `Sandbox` with an arbitrary pod spec — privileged, `hostPath`-mounting, or on another `RuntimeClass`. RBAC decides per verb and never per object shape, so the only way to take that capability away from a host that does not need it is to not grant it. The claimant Role grants `create`/`get`/`list`/`patch`/`delete` on `sandboxclaims`, `get` on `sandboxes`, `get` on `sandboxwarmpools`, `get`/`list` on `pods`, and `get`/`list` on `networkpolicies` and `ciliumnetworkpolicies` — and withholds every `sandboxes` write, every write on a policy resource, and the `sandboxtemplates` and `persistentvolumeclaims` reads, each because no call site on the pool-only path issues it.

  **What reaches a consumer through npm is the constant, not the manifest.** `k8s/` is outside the package's `files` array and has never been published, so the new `Role` is a repository artifact. New on the public surface, and the reason this is `minor` rather than `patch`: `KUBERNETES_CLAIMANT_RBAC_RULES`, exported from `@namzu/sandbox`'s entry point, with its `KubernetesRbacRule` and `KubernetesRbacVerb` types. It is the pool-only path's verb list with a call site named against every entry, and a host that wants to prove its own applied `Role` carries no more than this backend needs can compare against it instead of against a list copied out of a page. Nothing existing changed name, shape or default: no export was removed or narrowed, no config key moved, and a host that creates sandboxes directly keeps using `rbac.yaml` exactly as before.

  The direct-create `ValidatingAdmissionPolicy` example that would bound what a `sandboxes: create` holder may POST is not in this change — it lands with the per-sandbox capability work. The manifest's header states that neither of the two cluster-level claims that go with it (a claimant host passing the contract suite and the acquire-p50 script, and `kubectl auth can-i create sandboxes` answering `no`) has been measured; the shipped test parses both Role files and compares verb sets, reads the pool-only path's own sources and resolves every literal `client.request('<METHOD>', …)` there to the `(apiGroup, resource, verb)` triple its path builder addresses — failing on any request it cannot trace, including a builder call with anything appended to it (a `pods/log`-style subresource is authorized separately from its parent), a NAME the source writes a second path to, in any of the four spellings the guard reads WHEREVER they are written rather than only where they open a statement (a plain assignment `path = …` — the one-line branch included — a compound one, a `for (path of …)` binding, a destructuring target `({ path } = …)`) — as a `const`/`let`/`var`-declared one, through which the appended spelling reaches a request too, and as a wrapper's own path parameter, through which the call sites that resolve it stop being what it sends; the first used to resolve to the initializer's triple in silence, a request in no function body it can match, a path that is a parameter of a body whose call sites it has not been told about, and a wrapper declared for such a path in a file the scan does not read — pins the file set it reads to the directory — any other `.ts` under `src/backends/kubernetes/` that reaches the client, calling `client.request(…)` itself in either spelling the scan reads (the literal one, or a computed `client['request']`) OR naming `listPolicies`, the one wrapper the scan knows, whose declaration is found in either shape the scan reads — fails until it is scanned or declared off the path with its reason — and contacts no API server. What it cannot see: the files declared off the path (`workspace.ts`, `k8s-client.ts`, `transport.ts`) are never resolved to triples, a wrapper call site in one of them included, since call sites are read from the scanned files only; a wrapper reached by another NAME is outside that file predicate, which matches the wrapper's name and not its identity, so a file importing a re-export of `listPolicies` — or calling a helper one level further out that calls it — is neither scanned nor required to be declared; a path arriving through an expression-bodied arrow's parameter is outside what it matches; a body it could not register — a class method, or an object literal's shorthand method, declared inside one of the bodies it reads — is attributed to the body that encloses it, so the nested body's own parameters are invisible; and the assignment guard it now has is by name in the file it resolves in rather than by scope, so a binding it registers nowhere shadows nothing there — a destructuring parameter (`function f({ path })`) or a write made to an exported binding from another module — and an assignment to a same-named local in an unrelated function of the same file refuses the request too, a false refusal rather than an escape; a parameter carrying a default (`function f(path = …)`, `function f({ path } = {})`) is written with an `=`, so the guard reads it and refuses the request rather than resolving it; and a destructuring pattern nested inside another (`({ a: { path } } = …)`) is read by neither spelling — measured green, and listed as a hole rather than claimed as read. That list is the SHORT form, not the list: it is carried in full in the header of `packages/sandbox/k8s/__tests__/manifests.test.ts`, which also holds the bullet `a path assembled by an operation the scan does not model`. Three shapes it used to pass in silence fail it now rather than being listed here: a declared wrapper written as `const NAME = … =>`, whose call sites resolved to nothing because the declaration was looked up with a `function`-keyword pattern; a file whose only route to the client is the computed `client['request']` spelling, which the file predicate's literal half could not match; and a name a source writes a second path to, in the two shapes it can reach a request through — a declared one, whose request used to be resolved from the initializer, and a wrapper's own path parameter, whose request used to be resolved from its call sites. Both are the appended-subresource escape the argument spelling already failed on.

- 7488339: The Kubernetes backend can now select an egress PROFILE per claim, so one
  `SandboxWarmPool` serves several enforced network modes. **It needs an
  operator action on the cluster before it works:** a profile is a pod label,
  and the agent-sandbox controller refuses a claim whose label key is outside
  the `allowed-label-domains` key of the `agent-sandbox-config` ConfigMap in
  the controller's own namespace (built-in default `sandbox.users.io`), while
  this backend's default key is `sandbox.namzu.ai/egress-profile`. Add the
  domain there, or set `egress.profileLabelKey` to a key already allowed.
  Everything is additive: with no `egress.profile` set, every emitted body,
  selector, policy name and request is byte for byte what it was.

  Egress was one policy per backend: the translated policy's selector is the
  template label alone, and a per-`create()` override is refused. Every network
  mode therefore needed its own `SandboxTemplate`, its own `SandboxWarmPool`
  and its own policy, and every warm replica is a full pod reservation
  multiplied by the number of modes.

  `KubernetesEgressConfig` gains two fields:

  - `profile?: string` — a DNS-1123 label value, e.g. `none` or `internet`.
    Set, it is written onto the `SandboxClaim`'s
    `spec.additionalPodMetadata.labels`, onto a directly created `Sandbox`'s
    (and a workspace's) pod template, and into the translated policy's
    `podSelector`/`endpointSelector`. The default policy name becomes
    `${sandboxTemplateName}-${profile}-egress`.
  - `profileLabelKey?: string` — the key it is written under. Defaults to
    `DEFAULT_EGRESS_PROFILE_LABEL_KEY` (`sandbox.namzu.ai/egress-profile`),
    now exported.

  One thing to plan for when adopting it: **each profile needs its own applied
  policy object.** A deployment that sets `profile` while leaving the policy an
  operator applied selecting the template label alone gets
  `KubernetesEgressPolicyMismatchError` on the first `create()` — by design,
  because the selector is part of the exact-match verification, and a profile
  whose policy does not select it would bound nothing.

  Two new refusals are thrown, each catchable by class:
  `KubernetesEgressProfileConfigError` (synchronous, while the host is being
  wired, for a profile or key this backend will not emit — including
  `sandbox.namzu.ai/template`, which would overwrite the template label, and a
  `${template}-${profile}-egress` past the 253-character object-name limit) and
  `KubernetesPodLabelNotObservedError` (the bound pod never carried the label;
  the claim is released rather than a sandbox handed back, because an
  unlabelled pod would run under whatever policy does select it).

  **A claim the controller refuses for its metadata does NOT get a taxonomy of
  its own.** `InvalidMetadata` is already one of the terminal claim reasons an
  acquire fails fast on, so it still rejects with `KubernetesAcquireError`
  (`reason: 'claim-rejected'`, `retryable: false`) whether or not a profile is
  configured — an existing `catch` keeps working unchanged. The new
  `KubernetesPodLabelsRejectedError` is exported but never thrown on its own: it
  rides as that error's `cause`, carrying the pod labels this backend sent
  (`requestedPodLabels`) and the `egress.profileLabelKey` that moves the
  offending key to an allowed domain, neither of which the controller's own
  message can know.

  A third refusal is an existing class gaining a value: a workspace whose
  standing `Sandbox` does not carry the configured profile on its pod template
  is **not adopted**. `KubernetesWorkspaceMismatchError.field` gains
  `'egressProfile'` beside `'sandboxTemplateName'` and `'runtimeClassName'`
  (additive — a host matching on the two existing values is unaffected), and
  the refusal lands before any resume patch, so the workspace is left asleep
  rather than woken up to be rejected. The way to move an existing workspace
  onto a profile is `refreshPodTemplate: true` on `resume()` or
  `createKubernetesWorkspace`, which rewrites `spec.podTemplate` — profile label
  included — on the one Suspended → Running transition; the refusal is lifted
  for a call that is about to write the configured profile, exactly as the
  `runtimeClassName` refusal is, and re-applied if the patch does not land. A
  workspace that is neither refreshed nor recreated refuses to open rather than
  opening under whatever policy still selects it.

  Measured against agent-sandbox v1.0.2 on Kubernetes v1.37: six claims out of
  one two-replica pool, alternating two profile values, each bound a replica
  that already existed, in 47–61 ms, with the controller patching the label
  onto the running pod and into the `Sandbox`'s own `spec.podTemplate`. What
  was NOT measured anywhere in this repo is the egress difference between two
  profiles — that is enforcement, and it needs a cluster that enforces.

- 260547f: A Kubernetes workspace command can now keep running when the connection
  watching it is lost, and be picked up again by execution id — from this host
  process or another one.

  Before this, a command's output and result were tied to the one connection
  that started it. Any socket reset made the host cancel the command to
  reconcile, and a cancel it could not confirm within eight seconds retired the
  pod, taking every open terminal with it. If the host process exited instead,
  nothing cancelled at all: the command ran on, its output had been written only
  to a closed socket and kept nowhere, and the only op that returned its record
  terminated a running command to hand it over. A host that ran installs, builds
  or test suites from a redeployable process had to hold every rollout until
  nothing was in flight.

  **Nothing changes unless you ask for it.** Without `executionId` and without
  `detach`, `exec()` sends byte-for-byte the wire request it always sent, keeps
  no output, and behaves exactly as it did. `SandboxExecOptions` is untouched, so
  the SDK's exec contract and every other backend — the Firecracker tier
  included — are unaffected, and `@namzu/sdk` is unchanged.

  **What is new, all on the Kubernetes workspace handle.**

  - `exec(command, argv, { executionId, detach, detachSignal, reattachWindowMs,
onGap })`. When the exec connection fails, the handle reattaches from the
    last byte offset it received. Only getting back is bounded
    (`reattachWindowMs`, 30 s by default), and the bound is disarmed once an
    attach succeeds. If it cannot get back, `exec()` rejects with
    `KubernetesExecutionDetachedError`, carrying the `executionId` and the
    `outputOffset` to resume from. **It never sends a cancel to reconcile**, so a
    lost connection now costs the workspace nothing — no patch, no suspend, no
    pod. `signal` keeps its SDK contract and terminates; `detachSignal` ends the
    watching and leaves the command running.
  - `attachExecution(executionId, { fromOffset, onOutput, onGap, signal })`,
    resolving to the same `SandboxExecResult`. It never signals the command:
    aborting its signal detaches. Every attach inside the retention window
    returns the same result. A refusal arrives as
    `KubernetesExecutionNotAttachableError`, whose `executionState` — when the
    guest reported one — tells the two answers apart that matter:
    `'reserved'` means the command never started, so nothing is running.
  - `cancelExecution(executionId)`, the confirmed-cancel path from any process
    holding the id. A cancellation it could not confirm rejects and retires
    nothing.
  - Exported: `KubernetesExecutionDetachedError`,
    `KubernetesExecutionNotAttachableError`,
    `KubernetesExecutionAttachUnsupportedError`,
    `KubernetesDetachedExecOptions`, `KubernetesAttachExecutionOptions`,
    `KubernetesAttachRefusal`.

  **What you have to know before relying on it.** Starting the same
  `executionId` twice runs the command once — but only while the guest still
  holds the record. That ends at the retention window
  (`NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`, 10 minutes) and at pod replacement,
  which takes the whole registry with it; after either, the same id starts a
  fresh command. A reader that asks for output the guest has already evicted is
  told how many bytes it lost through `onGap`, and the result carries
  `stdoutTruncated` and `stderrTruncated` — both, because the retained log is one
  interleaved space.

  **Redeploy the workspace image to get it.** The guest advertises
  `execution-attach` in its `healthz` features and a host asking for a detachable
  command against an older image is refused before the command is admitted. The
  guest wire protocol version is deliberately **unchanged**, so no host and no
  image has to roll together with this release.

  **`NAMZU_SANDBOX_MAX_TIMEOUT_MS`.** The guest's ceiling on a caller's `timeout`
  was a hard 30-minute constant; it is now read from this variable — the same one
  the container worker has always read for the same limit — and named in the
  refusal. The default is still 30 minutes, so an unconfigured deployment refuses
  exactly what it always refused. Set it to run a suite longer than that without
  rebuilding the image.

  Four variables join the shipped workspace template's `env` block at their
  defaults, so deleting them changes nothing: `NAMZU_SANDBOX_MAX_TIMEOUT_MS`,
  `NAMZU_AGENT_EXECUTION_LOG_BYTES` (1 MiB of retained output per execution),
  `NAMZU_AGENT_MAX_RETAINED_OUTPUT_LOGS` (32 executions retaining at once) and
  `NAMZU_AGENT_EXECUTION_RETAINED_TTL_MS`. The last three bound what retention
  can cost the container's 512Mi; only a command that asked for it retains
  anything.

- 5a2c25a: Kubernetes sandboxes can now be dialed at their pod IP, so a host outside the cluster can reach the guest agent at all.

  Before, every sandbox and workspace was addressed as `<name>.<namespace>.svc.cluster.local`, which only the cluster's own DNS resolves. A host running outside the cluster — a peered VNet, an operator on a node, a CI runner with a route to the pod network — failed every call at name resolution, readiness and the acquire-time privilege probe included, so `create()` rejected on its readiness budget describing a timeout while the cluster was fine.

  `KubernetesBackendConfig.agentAddress` takes `'service'` or `'pod-ip'` and **defaults to `'service'`, which is exactly the previous behaviour** — same address, same API requests, same dial. Nothing changes for a host running inside the cluster, and no existing configuration needs to be touched.

  `'pod-ip'` dials the bound pod's IP, read from the same `GET` that reads the pod's uid, so the address and the bind token always describe one pod. It needs a pod network routable from the host and a `NetworkPolicy` admitting the host's address range on `agentPort`; the bind token, the privilege probe and egress verification are unchanged. A pod is `Pending` and has no IP until the CNI attaches it, so in this mode an acquire and a resume both WAIT for the address on the readiness budget they already own, and refuse only when it never arrives. Because a pod IP dies with its pod, every `resume()` re-reads it, and a dial that fails at connect re-reads the live pod once: a new uid means the controller replaced the pod, so the handle follows the new address and token and retries — safe because the failure came from the dial, so nothing reached the guest — while an unchanged pod leaves the original error standing. That covers every operation that dials the guest — `exec` and `listFiles`, `readFile`, `writeFile` including a body written in parts, `openTerminal`, `openTcpConnection` — with one exception: a command whose cancellation the guest could not confirm is never retried, because its outcome is unknown. `exec` and `listFiles` get there by watching what their dials did rather than by reading their error: the shared execution controller bounds a control request at 2 s and a dial's connect timer is 5 s, so a released pod IP that drops the SYN — the failure shape this mode is most likely to meet — is aborted by the bound before it has failed, leaving the caller a bare `… reservation exceeded 2000ms` with the dial's own failure discarded. "A connect was attempted and none handed back a socket" is the same "nothing reached the guest" guarantee, read from the other end.

  A dial of a Service FQDN that fails with `ENOTFOUND`/`EAI_AGAIN` now throws the new, exported `KubernetesAgentAddressUnresolvableError`, naming the FQDN and pointing at `agentAddress: 'pod-ip'`, instead of surfacing as an unexplained readiness timeout. An `ENOTFOUND` also stops retrying at once rather than spending its 30-second connect budget re-asking a resolver that has already answered definitively: that budget outlasts the privilege probe's own deadline, which is how the diagnosis used to be lost. An `EAI_AGAIN` — "temporary failure in name resolution", the shape a CoreDNS restart produces for an in-cluster host — keeps the whole budget and is named this way only if the budget runs out. `VsockTransportOptions` gains two optional hooks this is built on — the `permanentDialFailure` predicate, and `onDialAttempt`, which fires once per connect attempt before it is made so a caller can tell "no socket was ever established" from "the attempt had not failed yet". Absent, as both are everywhere else, every dial behaves exactly as before. `AgentDialFailedError` is now exported too: `VsockAgentTransport`'s dial throws it when it gives up without a socket, which is how "nothing reached the guest" is established by type rather than by reading an error's text.

  Minor, not major: one optional config field, two optional transport options and two new exported error classes, all additive, with the default behaviour byte-for-byte what it was. The guest wire protocol is untouched, so no pod image needs rebuilding.

- b14e068: `walkFiles` is now implemented on Kubernetes task sandboxes and on
  `KubernetesWorkspace`, and the shared sandbox conformance suite gains three
  sections.

  The SDK's `glob` and `grep` builtins refuse any sandbox that omits
  `walkFiles`, and both are in the default builtin set — so a host that
  registered them and moved from the Firecracker or docker backend to Kubernetes
  lost both tools with no change on its own side. It no longer does. Nothing
  about the guest wire protocol changed and no new agent op was added: this is
  the SDK's own `walkFilesViaExec` running the SDK's walk program through the
  existing `execute`, the same way the Firecracker and docker backends have
  always done it, so all three answer a search identically for one tree. The
  shipped guest image needed no change either (`node:22-bookworm-slim`; the
  agent is itself node).

  The walk is an execution. It counts as busy for its whole duration rather than
  per entry, `options.signal` and breaking out of the iterator both terminate the
  guest's walk process, and a cancellation the guest cannot confirm retires the
  sandbox exactly as a failed `exec` cancel does. On a workspace it passes the
  same admission gate as every other data-plane call, so a suspended workspace
  refuses a walk with `KubernetesWorkspaceSuspendedError` naming `walkFiles`,
  exactly as it refuses `readFile`, without dialing anything.

  `SANDBOX_CONTRACT_VERSION` moves from `2` to `3`: `defineSandboxConformance`
  now also covers `walkFiles` (`maxEntries`, `maxDepth`, `includeHidden`, a
  missing root, symlinks not followed, `ERR_FILE_WALK_LIMIT` on an exhausted
  budget, and a refusal once destroyed), several `exec` calls at once on one
  sandbox with no cross-talk between their results, and an `exec` whose `timeout`
  produces a timed-out result and really terminates the command. A backend author
  running the suite should expect the new cases; `walkFiles` is optional on
  `Sandbox`, so a backend that omits it skips that section rather than failing
  it, and no new case needs a guest feature that did not already exist.

- 7bf9425: Kubernetes workspaces can be listed, suspended and deleted without waking them, and a handle can see a suspend another process performed.

  `createKubernetesWorkspace` adopts AND resumes, and until now it was the only way in. So there was no path for the two things that are about the OBJECT rather than the guest: retention — deleting a month-old suspended workspace meant starting its pod and probing it purely to tell it to go away — and hand-off, where a second process could not discover a holder-less running workspace, and a handle opened before another process suspended the workspace went on reporting `suspended: false` over a pod that was gone.

  Three new verbs reach a workspace without opening one, and none of them creates a pod, dials an agent or resumes anything. `listKubernetesWorkspaces(config, { signal })` issues one GET of the sandboxes collection and returns a `KubernetesWorkspaceSummary` per workspace — `workspaceId`, `operatingMode`, `template`, `createdAt`, `operatingModeChangedAt` — sending no PATCH and no DELETE. `deleteKubernetesWorkspace(config, workspaceId, { signal })` DELETEs by the deterministic name with the same guarantees `destroy({ deleteDisk: true })` gives: an object already gone counts as deleted, and a DELETE that fails rejects and stays retryable. `suspendKubernetesWorkspace(config, workspaceId, { signal })` sends the suspend patch and waits for the pod to actually stop, rejecting with `KubernetesWorkspaceSuspendTimeoutError` if it outlives `readyTimeoutMs`.

  `operatingModeChangedAt` comes from a new annotation, `sandbox.namzu.ai/operating-mode-changed-at`, that the suspend and resume patches now stamp. Nothing already on the object answers the question — upstream leaves the `Suspended` condition True across a resume, so neither it nor its `lastTransitionTime` says when the mode last changed. A workspace whose mode has never changed carries no annotation and is reported without one rather than defaulted to `createdAt`, so a retention rule can tell "never suspended" from "suspended a month ago".

  On the handle: `KubernetesWorkspace.refresh()` re-reads `spec.operatingMode`, so a workspace another process suspended reports `suspended: true` and `resume()` brings it back on the same disk. A call that FAILS while the handle still believes it is running now also re-reads the object once, and if it is suspended the caller gets `KubernetesWorkspaceSuspendedError` — carrying the transport failure on `cause` — instead of the flat `unauthorized` or connect refusal that named nothing. That error's new `noticedBy` field (`'admission' | 'transport'`, typed by `KubernetesWorkspaceSuspensionNotice`) says which of the two happened, and its message changes with it, because "nothing was dialed" is a promise only the first keeps. A foreign suspend is recorded as UNCONFIRMED: what was observed is the object's mode, not the pod stopping, so this handle's own `suspend()` still patches and waits.

  **Two things to do on upgrade.** The host's Role needs `list` on `sandboxes` in the sandbox namespace — `packages/sandbox/k8s/manifests/rbac.yaml` grants it, and `listKubernetesWorkspaces` is the only caller; without it that one verb gets a 403 naming it and nothing else changes. And code that IMPLEMENTS `KubernetesWorkspace` rather than merely consuming one must add `refresh()`. Nothing else moved: no default changed, the guest wire protocol is untouched, and the only difference on the wire is the annotation the two existing patches now carry.

- e2024bc: `Sandbox.setNetworkPolicy` is now implemented on Kubernetes sandboxes — but
  only on a TASK handle, only when the backend is configured with
  `egress.perSandbox`, and only on a cluster where **both operator
  prerequisites** are in place: the applied
  `ValidatingAdmissionPolicy` and its binding
  (`packages/sandbox/k8s/manifests/validatingadmissionpolicy-cilium.yaml`),
  which the backend proves before its first write, and the opt-in RBAC file
  (`rbac-per-sandbox-egress.yaml`), whose policy-write verbs the default
  `rbac.yaml` Role deliberately still withholds. A host enabling the option
  without the fence gets `KubernetesAdmissionFenceMissingError` and nothing is
  written; without the RBAC it gets a `403` naming the verb. Everything is
  additive: with no `egress.perSandbox`, the method is absent exactly as before
  and no new request is issued on any path.

  A `KubernetesWorkspace` handle never carries the method — nothing in its
  create path composes a per-sandbox pod label or tracks an owner uid for one —
  so `createKubernetesWorkspace` **refuses** a config carrying
  `egress.perSandbox`, with `KubernetesWorkspacePerSandboxEgressConfigError`
  and no request sent, rather than accepting a capability it would never serve.
  A host that creates workspaces and task sandboxes from one config object
  passes that call a config without `perSandbox`; task sandboxes are unaffected.

  Live per-sandbox egress is the SDK's contract for "fetch the repository with
  a token, then narrow before running what the repository contains", and the
  Kubernetes backend omitted it: egress was one policy for every sandbox the
  backend produced, so a per-tenant host list meant an operator-applied policy,
  its own template and its own warm pool, per list.

  Configured, each `setNetworkPolicy({ allowedHosts })` writes one
  `CiliumNetworkPolicy` for that sandbox alone: named `namzu-sbx-<uid>` after
  the `SandboxClaim` (or `Sandbox`) this backend created, selecting one
  per-sandbox pod label carried in the same claim-time
  `additionalPodMetadata.labels` map the egress profile travels in and confirmed
  on the bound pod before the sandbox is handed back, owned by that object
  through `ownerReferences` so `destroy()` lets the cluster collect it, and
  allowing the cluster-DNS rule plus one `toFQDNs` rule for the list —
  `api.example.com` for a host, `matchName` plus `matchPattern: '*.example.com'`
  for a `.example.com` entry, carrying the same port/DNS-name/TLS-server-name
  narrowing options the config-level allowlist has. `dnsNames` narrowing goes
  one step further here than at the config level, because this translation is
  the one that expands the domain form: an expanded entry also gets a
  `matchPattern: '*.<host>.<suffix>'` for every cluster search suffix, since a
  guest resolving `a.example.com` tries those suffixes first under the default
  `ndots: 5` and a lookup the DNS proxy refuses can fail the whole resolution.
  Both halves of that are new — the exact-host branch emits `<host>.<suffix>`
  `matchName`s and never a pattern — and it is reachable only under
  `perSandbox.narrowing`, where the entry really does admit subdomains. The call
  resolves only after a read-back deep-equals what it sent, through the
  comparator the named-object check already used. `setNetworkPolicy([])` deletes
  that one object, leaving the configured baseline in force rather than no
  policy at all.

  Policies UNION, so a per-sandbox list ADDS to whatever `egress.policy`
  translated to and only narrows when that baseline denies: pair `perSandbox`
  with `no-network` or `deny-all` if `setNetworkPolicy` is to be the boundary
  rather than an addition to one. Allowlist entries are hostnames, and letter
  case is canonicalised rather than refused; a URL, a port suffix, an explicit
  glob, an IP address and a whole public suffix such as `.com` are each refused
  by name before anything is sent, the last two more strictly than the docker
  backend's proxy.

  One message correction rides along: `KubernetesEgressPolicyConfigError` now
  spells its `field` relative to `config.egress` rather than to
  `config.egress.policy`, because the fields that reach it live at both levels
  — `policy.exceptCidrs` on the policy, `ciliumNarrowing` and
  `perSandbox.narrowing` beside it — and the old prefix named a key that does
  not exist for two of the three. A caller matching that error's `field` on the
  literal `'exceptCidrs'` should match `'policy.exceptCidrs'` instead; nothing
  about which values are refused has changed.

  One combination is refused rather than translated: **a `.domain` allowlist
  entry together with `tlsServerNames`**, with `KubernetesNetworkPolicyHostError`
  and nothing written. A TLS server name is one exact SNI value a handshake
  presents, while `.example.com` means that domain and every subdomain of it, so
  `serverNames: ['.example.com']` is a value no handshake ever presents and
  `['example.com']` would deny every subdomain the same rule's `toFQDNs` half
  admits — the object is admitted by the fence and reads back deep-equal to what
  was sent, so the call would report success and deny the domain it was asked to
  allow. Refused at the translation, which covers `config.egress.ciliumNarrowing`
  on the config-level allowlist as well as `perSandbox.narrowing`, and again —
  earlier, before the fence is read — by the per-sandbox writer.

  **The refusal's message is path-aware**, because the entry is a different
  thing on each path and one sentence cannot be true of both. The per-sandbox
  translation expands `.example.com` into a name plus a `*.example.com` pattern,
  so its message says exactly that, and the remedy it offers — "list the exact
  hosts, or leave `tlsServerNames` off for a domain list" — is a real repair
  there. The CONFIG-level translation expands nothing: the entry reaches the
  object as the literal `matchName: '.example.com'`, which no DNS answer carries,
  so it admits nothing with the option on or off, and `serverNames` on top of it
  is a second, independent denial. Its message says that instead of offering a
  remedy that is not one. Which values are refused is unchanged; only what a
  refused caller is told to do about it is. Each message names the caller's OWN
  field — `config.egress.perSandbox.narrowing` for the expanding one,
  `config.egress.ciliumNarrowing` for the config-level one — and the
  config-level one omits the closing sentence saying what an entry means, since
  that is the grammar its translation does not apply. (That a config-level
  `.domain` entry matches no answer at all is a pre-existing defect of this
  shipped translation: it is left exactly as it was and deferred to its own
  change.)

  A fence read the API server REFUSES (a `401`/`403` — most often the namespaced
  `Role` applied without the `ClusterRole` in the same file, since both admission
  objects are cluster-scoped) is now its own refusal,
  `KubernetesAdmissionFenceUnreadableError`, rather than being reported as a
  missing fence: `404` means the object is not there, `403` means this host may
  not look, and the two send an operator to different files. Nothing is written
  in either case.

  New exports: `KubernetesAdmissionFenceUnreadableError`,
  `KubernetesPerSandboxEgressConfig`,
  `KubernetesPerSandboxEgressConfigError`, `KubernetesAdmissionFenceMissingError`,
  `KubernetesNetworkPolicyHostError`, `KubernetesOwnerUidMissingError`,
  `KubernetesWorkspacePerSandboxEgressConfigError`,
  `DEFAULT_PER_SANDBOX_EGRESS_LABEL_KEY`,
  `PER_SANDBOX_POLICY_NAME_PREFIX`. `egress.perSandbox.engine: 'core'` is
  refused synchronously while the host is being wired, because core
  `NetworkPolicy` has no hostname concept to translate an allowlist into. The
  per-sandbox selector key defaults to `sandbox.namzu.ai/per-sandbox-egress`,
  which carries the same controller `allowed-label-domains` prerequisite the
  egress profile's key does, and the shipped admission policy pins that KEY
  alongside the owner's name as the value — the value check alone would let a
  claim named `namzu-task` select on the shared template label.

  **Enforcement was not measured in this repository.** What was measured, on a
  local single-node cluster running the upstream `CiliumNetworkPolicy` CRD with
  no data plane at all: that the exact body written is admitted by the shipped
  fence and its replacement merge-patch is too; that the fence refuses a name
  without the prefix, a name whose suffix is not its owner's uid, a missing or
  foreign owner, `blockOwnerDeletion: true`, a two-label selector, a one-label
  selector pointed at any pod but the owner's own, a `toFQDNs` entry matching
  every name (`'*'`, `'*.*'`, `'*.com'`), the kube-dns rule moved off port 53,
  `toEntities`, `toCIDR`, an ingress rule, a `specs` list, a widening patch and
  a `DELETE` of the operator's own policy; that 51 concurrent claims produced 51
  distinct policies with no cross-writes; and that deleting a claim collected
  exactly its policy (about 100 ms) while the operator's unowned policy
  survived. That an allowed host answers and a disallowed one does not is a
  property of a CNI data plane and needs a real Cilium cluster with a positive
  control.

- feaeaba: Read a large file out of a sandbox without the sandbox holding it.

  `readFile` used to load the whole file in the guest, base64-encode it into one
  JSON object and write that object as a single frame, so the file buffer, the
  base64 string, the JSON string and two frame buffers all existed at once —
  about 7.7x the file, inside the container the workload shares. A 64 MiB read
  grew the guest agent by 405 MiB against the shipped workspace template's
  `512Mi` limit, and a file of about 384 MiB or more could not be read at all:
  its base64 string exceeds V8's `0x1fffffe8`-character ceiling, so the call
  failed with `Cannot create a string longer than 0x1fffffe8 characters`. That
  call now succeeds.

  - `readFile(path, { offset, length, signal })` reads one slice. The guest
    `pread`s at that position and answers with the whole file's size beside the
    bytes; a range past the end returns what exists. A slice above
    `NAMZU_AGENT_READ_FILE_RANGE_BYTES` (1 MiB default) is refused, not
    shortened.
  - `readFileStream(path, options?)` returns an `AsyncIterable<Buffer>` over a
    new `read-file-stream` guest op. A 1 GiB read grows the guest by about
    12 MiB.
  - `readFile(path)` with no options is served by that stream against a guest
    that advertises the capability, so callers lose the ceiling without changing
    a line. It still returns one `Buffer`; iterate `readFileStream` to avoid even
    that copy.

  The guest opts in. `agent.cjs` advertises `read-file-stream` in its `healthz`
  reply, and against a guest that does not, a whole-file read takes the
  unchanged single-frame path while a ranged read or a `readFileStream` throws
  the new `AgentReadFileStreamUnsupportedError` before dialing — an agent that
  predates the feature ignores `offset`/`length` and answers with the whole
  file, which you would otherwise read as your slice. Rebuild the guest image
  from this release to get the new behaviour; nothing forces you to, and the
  guest wire protocol version is unchanged.

  A `KubernetesWorkspace` has both shapes too, which is where they matter most:
  draining a large output file before `suspend()` or `destroy()` is what a
  long-lived workspace is for. Its `readFile` forwards `offset`/`length` to the
  guest, and `readFileStream` is present on the interface rather than optional.
  Both refuse a suspended workspace by name, as every other data-plane call does.

  The two backends that cannot serve a range now REFUSE one rather than ignoring
  it: the docker and standby-pool workers answer whole files only, so
  `readFile(path, { offset })` against either throws instead of handing back the
  file. Previously those backends declared the one-parameter form, which type
  checks and silently discards the range. Both also pass `options.signal` to the
  request they make. Nothing that compiled before breaks — no caller could pass
  the parameter until this release.

  Three guest rules to know if you write to this wire yourself. A range must ask
  for `base64` (`read_file_range_requires_base64`): a `utf8` slice at an
  arbitrary offset can split a multi-byte character. `read-file-stream` serves
  regular files only (`read_file_stream_not_a_regular_file`), so a whole-file
  read of a fifo or a device node — reachable only if you set
  `NAMZU_SANDBOX_READ_ROOTS` — is now refused rather than attempted, and a file
  that shrinks under the open fd fails the read instead of coming back short.
  A regular file that `stat` reports as zero bytes and that still has content,
  the procfs shape, is read to EOF by both new shapes rather than answered as
  empty.

  New exports: `AgentReadFileStreamUnsupportedError`, `READ_FILE_STREAM_FEATURE`,
  `ReadFileStreamRequest`, `ReadFileStreamEvent`. New guest environment
  variables: `NAMZU_AGENT_READ_FILE_RANGE_BYTES` (1 MiB),
  `NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES` (256 KiB). `defineSandboxConformance`
  gains `supportsRangedAndStreamedReads`, default `false`, which gates two new
  cases; those two deliberately did not raise `SANDBOX_CONTRACT_VERSION` beyond
  the `3` the `walkFiles`, concurrent-`exec` and `exec`-timeout sections took it
  to, so a backend that passes those three still passes the suite without
  implementing either read shape.

- 30da35d: Kubernetes workspaces can be woken onto the current `SandboxTemplate`, keeping their disk.

  A `Sandbox` carries its own copy of `spec.podTemplate`, taken once in the create `POST`, and agent-sandbox builds every replacement pod from that copy rather than from the template. A workspace kept for weeks therefore ran the pod spec it was created with: a new image tag, a memory limit, a `terminationGracePeriodSeconds` or an env change reached only workspaces created after the edit. After a release that changes the agent's wire protocol this is not cosmetic — every session start runs the privilege probe through an `exec`, the execution controller refuses a reservation whose `protocolVersion` is not the host's, and every adopt and every resume of a workspace pinning the old image fails. Until now the only way out was `destroy({ deleteDisk: true })`, which deletes the PVC.

  `refreshPodTemplate` is opt-in on both entry points and is honoured on exactly one transition, Suspended → Running:

  ```ts
  await workspace.resume({ refreshPodTemplate: true });
  // or, for a host that restarted and holds no handle:
  await createKubernetesWorkspace(config, {
    workspaceId,
    workingDirectory,
    refreshPodTemplate: true,
  });
  ```

  It sends one `application/json-patch+json` body — `test /spec/operatingMode == "Suspended"`, then the annotations, `/spec/podTemplate` and `/spec/operatingMode` — so the condition and the write cannot be separated, and a configured holder epoch's `test` travels in that same body rather than in a second request. A JSON Patch rather than a merge patch on purpose: a merge patch recurses into maps, so a `nodeSelector` entry the template dropped would survive on the object. The two writes go up as `add` rather than `replace`, which is the same write on a member that is already there (RFC 6902 §4.1) and the only one of the two that lands on a member that is not — `spec.operatingMode` is absent on a `Sandbox` that has never been suspended.

  The disk is the one part of a template a refresh cannot apply: `spec.volumeClaimTemplates` is CEL-immutable, so it is never in the patch and the PVC is untouched. Two refusals guard that, both `KubernetesWorkspaceDiskError`, both before anything is sent, both leaving the workspace suspended — a template that no longer claims this workspace's disk through `volumeDevices`, and a template that declares a disk this workspace does not have. The second is the one to know about: adding a second `volumeClaimTemplates` entry with its matching `volumeDevices` entry is a valid edit that a NEW workspace would honour, and refreshing an existing workspace onto it would write a pod spec claiming a device node backed by no PVC. Give an existing workspace another disk by creating a new one from the new template and migrating the data.

  Nothing happens to a Running `Sandbox`: v1.0.2 does not rewrite a pod that already exists, so an adopt that finds the workspace Running — and a `test` that loses to another process's resume — binds the pod that is there, unchanged. The `sandboxTemplateName` mismatch refusal still always applies; the `runtimeClassName` one is lifted only for a call whose patch lands, because that patch is what writes the configured class.

  Two new readonly fields on `KubernetesWorkspace`, `templateRevision` and `templateCurrent`, report whether a workspace is still on the template it was built from. They are REQUIRED members of that exported interface, so anything that implements `KubernetesWorkspace` by hand — a test double, in practice — needs both before it compiles again; nothing that merely consumes a handle is affected, which is why this is a minor rather than a major. They read a new `sandbox.namzu.ai/pod-template-hash` annotation that every workspace create `POST` now stamps; a workspace created before this release carries none and reports `undefined` and `false`, which reads as unknown rather than as current. Task sandboxes are unchanged — their create body gains nothing.

  One thing is asserted rather than measured, and is stated here so an operator can weigh it rather than discover it: that the sandbox controller builds the replacement pod from `spec.podTemplate` AS REWRITTEN. That is upstream behaviour, taken from its source, and it was not reproduced against a live cluster for this change — not because the experiment is hard, but because the environment this change was written in refuses cluster writes; the run was attempted there and could not be made. It is a small run and it needs neither a disk nor a workspace: create a bare `Sandbox` with any pod template and no `volumeClaimTemplates`, wait for its pod, suspend it, send exactly the patch above with a changed image tag, a changed `terminationGracePeriodSeconds` and one `nodeSelector` key dropped, and read the replacement pod's own `spec` back. Anyone with write access to a cluster running the controller can settle it.

  The `test` clause bounds the cost of the premise being wrong: a refresh that never reaches the pod is a missed refresh, never a wrong write, and nothing in this release changes what a workspace runs without one. What would be wrong is `templateCurrent`, which would report a workspace as current while its pod ran the old spec — so treat it as a scheduling hint until that run is made, not as a statement about a running process. The disk-preserving round trip through a real block-mode PVC (file digests match, PVC uid unchanged) is unmeasured for the separate reason that it needs block storage; what is proven is that `spec.volumeClaimTemplates` never appears in the patch and that the stored claims are byte-identical afterwards.

  Without the option nothing changes: `resume()` sends the same single merge patch it always sent, an adopt behaves exactly as it did, both adopt refusals apply as they did, and no new RBAC or guest protocol change is involved.

- 7948fc0: Kubernetes workspace lifecycle writes can now be fenced with a holder epoch, so a superseded host process cannot suspend, resume or delete a workspace another process has taken over.

  A host that drives one workspace from more than one process — a rollout overlap, a restart, a retention job beside a request handler — usually already keeps a monotonic holder epoch of its own. It fenced nothing on the cluster: "check my epoch, then call `suspend()`" is check-then-act, the write that follows is a separate request, and the API server accepted it. A late `suspend()` stopped the new holder's pod, a late `destroy({ deleteDisk: true })` took the disk, and a late adopt woke a workspace that had just been suspended.

  Pass `epoch` and the condition travels in the same request as the write. It is accepted on `createKubernetesWorkspace`, `workspace.suspend()`, `workspace.resume()`, `workspace.destroy()`, `suspendKubernetesWorkspace` and `deleteKubernetesWorkspace`; a handle keeps the epoch it was opened or last resumed with and writes under it whenever a call passes none, including the cleanup patch a failed start sends. A write carrying epoch `e` applies when the epoch stored on the `Sandbox` is `<= e` and stores `e` in the same request; a stored epoch above `e` rejects with the new `KubernetesWorkspacePreconditionError` (`operation`, `workspaceId`, `sandboxName`, `epoch`, `storedEpoch`) and changes nothing — not on the cluster, and not on the handle, because the refusal is decided before `suspend()` reaps its terminals or `destroy()` tears its session down. `createKubernetesWorkspace` with an epoch now also writes it when it adopts a workspace that is already `Running`, and `resume({ epoch })` writes it on a workspace that is already running; both of those used to send nothing at all, which is exactly what left a new holder invisible to the process it had superseded.

  **Nothing changes for a caller that passes no epoch**, which is why this is a minor rather than a major: every request is byte for byte what it was, `application/merge-patch+json` included, and an unfenced write is not a write with epoch 0 — it carries no condition and still applies to a workspace held at 7. A workspace with no annotation reads as epoch 0, so existing workspaces accept their first epoch-carrying write.

  Also new: `KubernetesWorkspaceSummary.holderEpoch`, so a retention pass can see the fences it is looking at without waking anything; `KubernetesPatchNotAppliedError` for a conditional patch the API server would not apply; and a `patchType` argument on the internal API client's `request()`. No RBAC change is needed — the `patch` verb covers every patch type and the shipped `Role` already grants `patch` and `delete` on `sandboxes`.

- 3162371: Stop every process in a Kubernetes workspace's guest before a capture, with the new opt-in `quiesce` op and `KubernetesWorkspace.quiesce()`.

  A `suspend()` promises a quiesced disk, and until now that promise was only kept once the pod had stopped — by which point there is no agent left to read the disk through. What `suspend()` itself reaches is narrower than it looks: the terminals **that handle** returned, plus an execution somebody cancelled by id. A terminal another host process opened, an `exec` already in flight, and above all a program that moved into a session of its own with `setsid` and was then reparented away from the agent all kept running, and kept writing, into the drain. A host taking a final capture could not make it exact, and before deleting a suspended workspace it had to wake it and check.

  `workspace.quiesce({ graceMs })` stops all of it and **leaves the agent serving**, so the next `exec`, `readFile`, `readFileStream` or `writeFile` reads a filesystem nobody is writing under. It marks every running execution before it signals anything (the mark is what keeps the agent from fencing itself on a group leader that dies first, which would refuse the very capture the quiesce was for), scans `/proc` rather than its own children, skips PID 1, itself and its own kernel session, and signals in rounds — `SIGTERM`, `graceMs`, `SIGKILL` on what is left — until a pass finds nothing. A process still present after `SIGKILL` rejects the call with `KubernetesQuiesceUnconfirmedError` naming its pid; it never resolves optimistically. `suspend({ quiesce: true })` and `destroy({ quiesce: true })` run it after this handle's terminals are reaped and before the `Suspended` patch, and a quiesce that cannot be confirmed sends **no patch**, leaving the workspace running and admitting calls. Concurrent suspends still share one transition, with one exception worth knowing before you wire this to a shutdown path: a `suspend({ quiesce: true })` arriving while a suspend WITHOUT a quiesce is already in flight is rejected with `KubernetesQuiesceUnconfirmedError` (`reason: 'suspend_already_in_flight'`) rather than joining it, because that transition's patch has gone over a guest nothing stopped and no later call can make it still. A caller the flight already satisfies joins it as before.

  Nothing changes for a caller that does not ask. `suspend()`, `destroy()` and the standalone `suspendKubernetesWorkspace` without the option send exactly the requests they sent before (`suspendKubernetesWorkspace` refuses the option outright, since it never dials the agent and could not honour it), and the guest wire protocol version is unchanged: `quiesce` is an additive op advertised in `healthz` as `quiesce`, so no image and no host has to roll together with this release. An explicit `quiesce()` against an image whose agent predates the op is refused with `KubernetesQuiesceUnsupportedError` rather than answered with an empty list that would read like a guest with nothing to stop; a `suspend({ quiesce: true })` against that image suspends as it always did and tells the new `KubernetesWorkspaceOptions.onQuiesceUnsupported` callback, so the gap is reported rather than hidden.

  New surface: `KubernetesWorkspace.quiesce`, `KubernetesQuiesceOptions`, `KubernetesQuiesceReport`, `KubernetesWorkspaceQuiesceRequest`, the new `KubernetesWorkspaceSuspendOptions` (`KubernetesWorkspaceTransitionOptions` plus `quiesce`, taken by `suspend()` and by `suspendKubernetesWorkspace`, so that `resume()`, `refresh()`, `listKubernetesWorkspaces` and `deleteKubernetesWorkspace` do not accept a flag they could only ignore), `quiesce` on `KubernetesWorkspaceDestroyOptions`, `onQuiesceUnsupported` and `onQuiesceNarrowed` on `KubernetesWorkspaceOptions`, `KubernetesQuiesceUnsupportedError`, `KubernetesQuiesceUnconfirmedError`, and the wire vocabulary `QUIESCE_FEATURE`, `QuiesceScope` and `QuiescedProcess`. Nothing is added to `@namzu/sdk`'s `Sandbox`.

  One caveat worth reading before you rely on it: the general scan covers the guest's PID namespace, which in a pod is the container and nothing else, and the agent performs it only when it is the init of that namespace or was started by it — the shape `k8s/entrypoint.sh` gives it, where `tini` is PID 1 and the agent is its child. An agent that is neither narrows itself to the kernel sessions its own registries own and reports `scope: 'owned-sessions'`, which can miss exactly the program this op exists for. The scope is always in the report — and because `suspend({ quiesce: true })` answers `void` and cannot read one, a narrowed scan reaches that caller through `onQuiesceNarrowed` instead.

- 5f0222a: `Sandbox.writeFile` now writes a file of any size over the Kubernetes (`tcp`) transport, instead of refusing anything above about 5.9 MiB.

  Before: every `tcp` request dials a fresh connection and the guest's credential rides inside the request envelope, so every request was that connection's first, not-yet-authenticated frame and was bounded by the guest's pre-auth frame ceiling (`NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES`, 8 MiB) on _every_ call. A `write-file` carries its whole body base64-encoded in that one frame, so a body above ~5.9 MiB raw threw `AgentPreauthFrameTooLargeError` before dialing. The only workaround was raising the guest's ceiling — trading away the pre-auth budget that bound exists to enforce — which made seeding a repository archive into a workspace impractical.

  Now: a body that does not fit one frame is split into parts that each do. The parts are appended to a temporary _sibling_ of the target inside the same workspace jail, each naming the byte offset it starts at, and the sequence finishes with an atomic `rename` onto the target. So a reader never observes a half-written file, a failed or cancelled write leaves the target exactly as it was (including not existing), a part that went missing or arrived twice is refused by the guest rather than written in the wrong place, and an abandoned sequence removes its temp file on a best-effort basis. Parts go out sequentially, each on its own connection, so the guest's pre-auth connection pool never holds more than one of this caller's sockets.

  A body that already fits one frame is unaffected: the same single request, byte for byte.

  The guest opts in. `agent.cjs` advertises `features: ['write-file-parts']` in its `healthz` reply and the host sends a part only to a guest that did, because an agent that predates the field would read a part's content as a whole file. An oversized body against such a guest still fails with the named `AgentPreauthFrameTooLargeError`, whose message now says the guest is what is missing. The guest wire protocol version is deliberately unchanged (`2`): `part` is an optional field on an existing op, so no host and no guest image has to roll together with this release. `part.discard` — the one verb on `write-file` that removes a file — reaches only the agent's own `.namzu-write-….part` files, a `part` that is present but is not an object is refused rather than served as the plain write it resembles, and a final part's `renameTo` is jailed before any byte is written, so a refused target leaves the temp file untouched. A part whose bytes did not all reach the disk is refused (`write_part_short_write`) rather than renamed: one `pwrite` answers a write that crosses the volume's free space or an `RLIMIT_FSIZE` with a short count and no error, and on the final part a truncated temp file would otherwise be renamed onto the target — destroying the file the rename exists to protect while the caller is told the write failed.

  New on `VsockTransportOptions`, both optional: `maxWriteFileBytes` (default 1 GiB) is the body size the host refuses outright, with the new `AgentWriteFileTooLargeError` naming it — a bound stated up front rather than an out-of-memory partway through a sequence, and checked before the route is chosen, so a value below what one frame carries caps the ordinary single-frame writes too; `writeFilePartBytes` sets the bytes per part, defaulting to the largest a frame admits. Newly exported from `@namzu/sandbox`: `AgentWriteFileTooLargeError`, `DEFAULT_MAX_WRITE_FILE_BYTES`, `GUEST_FRAME_LIMIT_BYTES`, `WRITE_FILE_PARTS_FEATURE` and the `WriteFilePart` type. `VsockAgentTransport.writeFile` and `KubernetesAgentTransport.writeFile` take an optional trailing `AbortSignal`.

  Also in this release: the host-side frame reader accumulates into one geometrically-grown buffer instead of re-concatenating every arriving socket chunk onto a fresh allocation. Reading a 64 MiB file back spent 31 seconds of memory copying on a reply the socket delivered in under one; it now takes about 0.7s. Same framing, same errors — only the copying changed.

  Minor, not major: every existing call keeps its behaviour and its types. The one thing a caller could observe differently is that a `writeFile` above ~5.9 MiB now succeeds where it used to throw, and `SANDBOX_CONTRACT_VERSION` moved from 1 to 2 because `defineSandboxConformance` gained a case for it — a backend run against the suite must now serve a body larger than one wire frame.

### Patch Changes

- ddf5a3c: A failed Kubernetes lease renewal now retries on a short capped backoff — one second, doubling, capped at whichever is smaller of thirty seconds or a twentieth of the TTL — instead of waiting a full half-TTL for the next attempt.

  `KubernetesLeaseRenewal.tick()` used to schedule its next attempt a full jittered half-TTL after every outcome, success or failure alike. A renewal failure landed its retry 0.9–1.1 × TTL after the last success, while the object's `shutdownTime` was exactly one TTL after that same success: a single API blip at renewal time expired a live claim with roughly 50% probability, and the controller deleted the pod out from under whatever command was still running in it. The fix does not change what a success does — the loop still renews every half-TTL and reports nothing — only how quickly it comes back after a failure, so a short outage around a scheduled renewal now gets several attempts inside the window that actually matters instead of one. A renewal that finds the object already gone (404/410) still stops the loop immediately, exactly as before.

  No public API changed — `LeaseRenewalOptions` gained no new field, and no default a caller configures moved. This is a bug fix to already-documented behaviour (`onLeaseRenewalError`'s doc comment and the [lease renewal](docs/sdk/kubernetes-sandbox.md#the-lease) page both promised the resilience this now actually provides), so it ships as `patch`.

- 8d97927: The Kubernetes-backend guest entrypoint (`packages/sandbox/k8s/entrypoint.sh`) no longer treats every `blkid` failure as "the workspace disk is empty."

  Previously `blkid`'s exit status was folded away with `2>/dev/null || true`, so a `blkid` that was missing from `PATH` (127), not executable (126), erroring (4), or answering ambiguously (8) looked identical to a device that genuinely carries no filesystem — and the entrypoint ran `mkfs.ext4 -F` on it either way. On an image whose `PATH` omits `blkid`'s directory, or that ships a broken `blkid`, that reformats an already-populated, resumed workspace disk instead of refusing to touch it.

  The entrypoint now keeps `blkid`'s exit status and acts on it: only status 2 ("no filesystem found", `blkid(8)`) may lead to `mkfs`, and only once a raw `dd` read confirms the device can actually be probed (status 2 also covers "blkid could not read the device at all"). Every other outcome — a missing tool, a non-2/non-0 status, or a 0 exit with no printed type — aborts the pod instead, naming the status and leaving `blkid`'s own stderr on the container log rather than discarding it. `blkid`, `dd`, `mkfs.ext4`, `mount`, `chown` and `setpriv` are each checked with `command -v` up front, so a missing tool is named explicitly rather than surfacing as a silent format.

  No public API changed — this is guest-image/entrypoint behaviour for the `microvm`/`kubernetes` sandbox backend's deployment artifacts, which are not part of the published npm package (`packages/sandbox/k8s/` is excluded from `files`). A host running a workspace template built from the shipped image should rebuild it to pick up the fix.

- 29493a3: The shipped Kubernetes sandbox host `Role` (`packages/sandbox/k8s/manifests/rbac.yaml`) now grants `get` on `ciliumnetworkpolicies` (`cilium.io`), matching what `docs/sdk/kubernetes-sandbox.md`'s RBAC section already documented.

  Before: the Role granted `get` on `networkpolicies` (`networking.k8s.io`) only. A deployment configuring `config.egress.engine: 'cilium'` has `verifyEgressPolicyConfigured` read a `CiliumNetworkPolicy` instead, before every `createKubernetesWorkspace` call and a provider's first `create()` — so the shipped Role 403'd on exactly the path the docs said it covered.

  A cluster with no Cilium CRDs installed simply never matches the added rule, so this changes nothing for the default `'core'` engine. No code, type or default changed — patch.

- Updated dependencies [bd32216]
- Updated dependencies [c272993]
- Updated dependencies [c99f088]
- Updated dependencies [d0227e2]
- Updated dependencies [359b27f]
- Updated dependencies [5663108]
- Updated dependencies [165fd64]
- Updated dependencies [93f8d1e]
- Updated dependencies [7694a82]
- Updated dependencies [6283f8d]
- Updated dependencies [449642e]
- Updated dependencies [3e6980d]
- Updated dependencies [feaeaba]
  - @namzu/sdk@41.0.0

## 14.0.0

### Minor Changes

- cd43cfe: `SandboxProviderConfig` gains a real arm for `ACIStandbyPoolBackendConfig` (paired with the `ContainerSandboxLayout` it requires, same as the plain container arm). Previously the exported union only covered `ContainerBackendConfig`, `MicroVMBackendConfig` and `KubernetesBackendConfig`, so `createSandboxProvider({ backend: { tier: 'container', runtime: 'aci-standby-pool', … } })` did not type-check even though the backend was fully implemented and `pickBackend` already dispatched to it internally through two `as unknown as` casts. That call now type-checks with no cast.

  **Minor, not patch:** this is a backward-compatible widening of an exported input type — every config that type-checked before still does, and the only change is that a config shape the runtime already accepted is now also accepted by the type checker. That is additive public surface (a new union arm a consumer's own type-level code can observe), not an implementation-only correction, so it does not qualify for patch under this repo's rule that patch is reserved for changes that leave the public surface untouched.

  No runtime behavior changed: the ACI backend's construction, options and defaults are exactly what they were.

- f54f6f1: The microVM guest agent can now listen on a TCP port and require a per-instance
  token. Both are opt-in through the environment and both are absent from every
  shipped backend's configuration today, so an existing Firecracker deployment
  behaves exactly as it did: with neither variable set, the agent authenticates
  nothing and listens exactly where it listened before.

  `NAMZU_AGENT_TCP_PORT` is a third listen mode, after `NAMZU_AGENT_UNIX_PATH`
  and the inherited vsock descriptor and in that order, binding `0.0.0.0` for a
  deployment that reaches the guest over a routed network rather than a
  host-local socket. It fails closed: set with neither token variable it is
  refused at startup, naming both, instead of binding an unauthenticated
  listener. Framing, ops, execution leases, terminals, loopback TCP and
  file IO are unchanged — only the listen address differs. A guest configured
  with none of the three still refuses to start, and the message now names all
  three.

  `NAMZU_AGENT_BIND_TOKEN` makes every op except `healthz` present that exact
  token in the request envelope, from the first frame of a connection; anything
  else is answered `unauthorized` and the connection is closed before a handler
  runs. Comparison is constant-time over a fixed-width digest, so neither the
  value nor its length is learnable by probing. `NAMZU_AGENT_REQUIRE_TOKEN`
  without a preset token is a fallback that binds to the first token seen and
  refuses every other for the life of the process. `healthz` never requires a
  token and never echoes one, so readiness probing needs no secret. An empty
  `NAMZU_AGENT_BIND_TOKEN` is refused at startup in every mode — that is what a
  downward-API injection looks like when it resolved to nothing.

  A refused connection is destroyed rather than `end()`ed, so a refused peer can
  no longer keep streaming into the agent's frame buffer over the readable half
  that `end()` leaves open. Alongside it, bounds on what an unauthenticated peer
  may spend before the gate — which cannot run until a whole frame is parsed,
  because the credential rides inside the envelope.
  `NAMZU_AGENT_MAX_FRAME_BYTES` (default 256 MiB) caps the length ANY frame
  header may announce, on every listen mode, where the 8-hex prefix used to allow
  4 GiB. `NAMZU_AGENT_REFUSAL_FLUSH_GRACE_MS` (default 1s) likewise applies
  everywhere: it is how long a refusal frame may take to reach the wire before
  the socket is destroyed regardless, so a peer that stops reading cannot hold a
  refusal open. `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` (default 8 MiB),
  `NAMZU_AGENT_MAX_PREAUTH_CONNECTIONS` (default 64),
  `NAMZU_AGENT_MAX_PREAUTH_BUFFER_BYTES` (default 32 MiB),
  `NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` (default 10s) and
  `NAMZU_AGENT_PREAUTH_DEADLINE_MS` (default 10s) apply only in the token
  modes, so the Firecracker path sees none of them; together they bound what an
  unauthenticated peer can make the agent hold to one number rather than to a
  number per connection. One bound needs no variable and applies everywhere: a
  frame header is exactly nine bytes, so a peer streaming bytes with no newline
  in them is refused on the ninth rather than buffered against a newline that
  never arrives. Note what the pre-auth cap
  costs in a token mode: a `write-file` body shares the first frame with the
  token, so that cap is the ceiling on the body — about 6 MiB of file content at
  the default — and a body above it is refused `frame_too_large`, naming the
  limit and the variable to raise.

  Two of those pre-auth bounds are shaped by a slow loris rather than by a flood,
  and an operator who tunes them should know which is which.
  `NAMZU_AGENT_PREAUTH_IDLE_TIMEOUT_MS` is an idle timer that every byte resets,
  so on its own it retires only a silent connection;
  `NAMZU_AGENT_PREAUTH_DEADLINE_MS` runs from accept, is reset by nothing, and is
  the bound a peer dripping one byte every few seconds actually meets. And a full
  pre-auth pool evicts its **oldest** unauthenticated connection — answering it
  `too_many_unauthenticated_connections` — rather than refusing the arrival, so a
  poolful of squatters can no longer decide that nobody else, `healthz` included,
  gets served. None of this stops a peer that can reach the port from causing
  churn; the NetworkPolicy ingress rule in front of that port is the boundary,
  and these bounds are defence in depth behind it.

  The guest protocol version is deliberately NOT bumped: `token` is an optional,
  additive envelope field, and the wire is otherwise byte-for-byte what it was.
  Taking this release therefore requires no coupled rollout — no golden image has
  to be rebuilt and no host has to be redeployed in step with it. A deployment
  that wants the new modes turns them on in its own pod or image environment.

  Read `NAMZU_AGENT_BIND_TOKEN` as an instance credential, not an isolation
  boundary: the agent and the workload share a uid after deprivileging, so a
  workload can read the agent's own environment out of `/proc`. It is
  per-instance for that reason, and the network rule in front of the agent port
  is the boundary it sits behind.

  One behaviour changes for every existing deployment, Firecracker included, and
  it is the reason to read this entry before upgrading. The `terminal` op used to
  hand its shell the agent's whole environment; it now gets the same scrubbed
  environment an `execute` child has always had, with every `NAMZU_AGENT_*` and
  `NAMZU_SANDBOX_*` variable removed, and so does the `stty` resize helper behind
  it. That closed a hole this release would otherwise have opened — the bind
  token was visible in an interactive shell — and it means a terminal session no
  longer sees the agent's own settings, such as `NAMZU_SANDBOX_WORKSPACE`. A
  workload that needs a value in its terminal passes it in `env` on the
  `openTerminal` call, which still wins over everything else, `TERM` included.
  The bump stays `minor`: nothing exported changes shape, and the environment a
  terminal is handed is guest-internal behaviour rather than a typed API, but it
  is a change a terminal user can observe.

- 5604f73: A Kubernetes backend that claims VM-isolated sandboxes out of an [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) warm pool. New exported types `KubernetesBackendConfig` and `KubernetesClusterAccess`; `SandboxBackendConfig` and `SandboxProviderConfig` each gain an arm for it, so `createSandboxProvider({ backend: { tier: 'microvm', service: 'kubernetes', … } })` type-checks with no cast. Nothing existing changes shape.

  **Take this upgrade for the new backend, not for a complete one.** This changeset covers acquire, readiness, address resolution and teardown; the execution surface, the acquire-time privilege probe and the lease arrive in the same release under their own changesets, and persistent workspaces (suspend/resume with a block-mode disk) and the cluster manifests follow in later ones. Every other backend is untouched.

  What it does today, on a cluster running agent-sandbox v1.0.2 with a VM-isolating `RuntimeClass`:

  - **Warm claim, or a direct Sandbox.** With `warmPoolName`, `create()` POSTs a `SandboxClaim` at that pool and the controller binds an already-running sandbox. Without it, it POSTs a `Sandbox` built from `sandboxTemplateName`'s pod template — necessitated rather than offered, since `SandboxClaim.spec.warmPoolRef` is required and a pool-less claim does not exist in the API.
  - **The claim is pristine.** `spec.env` and `spec.volumeClaimTemplates` are never set, because a claim carrying either is forced to cold-start upstream instead of adopting a pool sandbox. It would still work; it would just stop being fast. Per-sandbox `env`, `memoryLimitMb`, `maxProcesses` and `egress` are therefore refused by name instead of accepted and dropped — set them on the `SandboxTemplate` the pool is built from.
  - **The bound sandbox's own identity.** A pool sandbox keeps the name the pool generated for it, so the backend reads `status.sandbox` back rather than assuming the claim's name; the sandbox `id` is that cluster name, which makes an id in a log line a `kubectl get sandbox` argument.
  - **Nothing left behind.** Every created object carries an absolute `shutdownTime` (default one hour, `claimTtlSeconds`) plus `shutdownPolicy: Delete`, so a host that dies mid-run costs one expiry rather than a leaked sandbox — `ttlSecondsAfterFinished` deliberately is not used, because its timer starts from a `Finished` condition a crashed host never reaches. Every failure on the create path deletes what it created on a separate short budget; an object already gone counts as released.
  - **A per-instance agent credential.** The pod's own `metadata.uid`, read with one `GET` after readiness and delivered to the guest through the downward API. No claim mutation, so the warm path stays pristine.

  Credentials arrive through `access`: `{ inCluster: true }` reads the projected ServiceAccount volume, and anything else supplies `{ server, ca?, getToken }`. There is no kubeconfig parsing in the package and no new dependency — `@namzu/sandbox` still declares no `dependencies` key.

- 437e3d3: The Kubernetes backend now ships the cluster-side half of itself: the guest image, its entrypoint, the `RuntimeClass`/`SandboxTemplate`/`SandboxWarmPool`/`NetworkPolicy`/RBAC manifests, and five scripts that measure the five acceptance criteria against a live cluster — all under `packages/sandbox/k8s/`, which is **not part of the published package** (the `files` array still packs only `dist` and `src`; `npm pack --dry-run` confirms it). None of that is a consumer-visible surface. What IS:

  **The guest agent now exits cleanly on `SIGTERM` — bumped `minor`, not `patch`, for exactly this.** `k8s/entrypoint.sh` `exec`s straight into `agent/agent.cjs`, so in a real pod the agent is pid 1 of the container's own pid namespace, and Linux leaves a signal whose default action is "terminate" un-applied for pid 1 unless the process installs its own handler. With none registered, an operator deleting a sandbox watched it ride out the pod's full `terminationGracePeriodSeconds` before `SIGKILL` finally landed — every delete paid that tax, cluster-wide, whatever backend dialed the agent. The new handler closes the listener and calls `process.exit(0)` the moment `SIGTERM` arrives. It is not a graceful drain: an in-flight `exec` or an open terminal gets no grace window, the same "gone" a caller already has to handle from a pod the cluster removed out from under it. This is additive guest behavior on a file the Firecracker tier also runs in production — nothing about the vsock/unix paths changes, and `REMOTE_EXECUTION_PROTOCOL_VERSION`/`FIRECRACKER_AGENT_PROTOCOL_VERSION` are untouched — but it is a real, observable change to when a pod actually terminates, which is why this is `minor` rather than `patch`.

  **Documented for the first time, no behavior change:** a confirmed `exec` cancellation on this backend resolves with the terminal signal/exit code the shared `RemoteExecutionController` observed — the same contract the Firecracker tier's `exec` already honors, now stated on `docs/sdk/kubernetes-sandbox.md` rather than left implicit.

  Everything else in this change is infrastructure an operator applies by hand — see `packages/sandbox/k8s/README.md` for the apply order and how to run each acceptance script, and `docs/sdk/kubernetes-sandbox.md`'s new deployment section for what each one measures. The five acceptance numbers themselves are not yet in that table; they are gathered by running those scripts against a real Kata cluster, not by this change.

- 432db25: The Kubernetes backend's `KubernetesBackendConfig` gains an optional `egress` block: `{ policy: EgressPolicy; networkPolicyName?: string; engine?: 'core' | 'cilium' }` (`engine` defaults to `'core'`). New exported types `KubernetesEgressConfig` and `KubernetesEgressEngine`. Nothing existing changes shape — `egress` is additive and optional, and every Sandbox this backend produces now carries a `sandbox.namzu.ai/template` label it did not carry before, which is additive metadata rather than a behavior change for an existing caller.

  **What it does.** `deny-all` and `allow-all` translate into a `NetworkPolicy` (egress rules that always leave the cluster's own DNS reachable, even under `deny-all`). `static` and `resolver` — hostname allowlists — are **refused at construction**, before any API call, naming the policy kind and what the cluster needs: core Kubernetes `NetworkPolicy` has no FQDN concept at all. Declaring `engine: 'cilium'` turns that refusal into an emission: a `CiliumNetworkPolicy` with a `toFQDNs` entry for every allowed host. This backend never emits `HTTP_PROXY`/`HTTPS_PROXY` as a substitute for an unenforceable policy — that is the container tier's still-open gap, not repeated here.

  **Verify, never trust.** This backend never creates the `NetworkPolicy`/`CiliumNetworkPolicy` itself — like the docker backend's network, it is operator-applied. The first `create()` after construction (not `createSandboxProvider`, which still contacts nothing) `GET`s the object named by `networkPolicyName` (default `${sandboxTemplateName}-egress`) and refuses to proceed on a 404 or a shape mismatch, naming the field that is wrong. It runs once per backend and is not cached across a failure, so fixing the cluster and creating again retries it.

  **Take this upgrade for the label, even without using `egress`.** Every Sandbox this backend creates directly now carries `sandbox.namzu.ai/template: <sandboxTemplateName>` on its pod — agent-sandbox's own controller-owned template label is written only on a Sandbox adopted out of a `SandboxWarmPool`, never on one this backend POSTs directly, so a `NetworkPolicy` an operator writes against a direct Sandbox should select by this new label. A `SandboxWarmPool`'s own `SandboxTemplate` needs the same label added to its `podTemplate.metadata.labels` for a pooled sandbox to match it too — this backend has no path to add it after the fact.

  RBAC: when `config.egress` is set, the ServiceAccount also needs `get` on `networkpolicies` (`networking.k8s.io`), or `get` on `ciliumnetworkpolicies` (`cilium.io`) under `engine: 'cilium'`.

- a3ae83e: The Kubernetes backend now returns a working `Sandbox`, refuses to hand one back until the guest has proved it is deprivileged, and keeps a long run's pod from expiring underneath it.

  **The execution surface exists.** `exec`, `writeFile`, `readFile`, `listFiles`, `openTerminal` and `openTcpConnection` no longer throw `KubernetesAgentTransportPendingError` — that error is gone, and so is the reason for it. `exec` runs through the same reserve-before-admission controller every other remote backend uses, so an `AbortSignal` terminates the guest process and the peer confirms the termination rather than the host abandoning the wait. `destroy()` kills and awaits every terminal it handed out before releasing the object, which is what makes offering `openTerminal` compliant at all; it is idempotent, and an object something else already reaped counts as released. Every call after it throws `KubernetesSandboxDestroyedError` naming the operation.

  **`setNetworkPolicy`, `spawnDetached` and `walkFiles` are absent, deliberately.** Egress here is a `NetworkPolicy` on the pool's `SandboxTemplate` and there is no per-running-pod knob, the guest agent has no detached-spawn op, and bounded search is not in this batch. The SDK's contract says a backend that cannot honour an optional method must omit it rather than accept it and quietly do nothing; a test asserts each stays absent.

  **Every acquire now proves the guest is deprivileged.** Before `create()` resolves, the backend reads `/proc/self/status` through the agent's `execute` op and refuses unless `CapInh`, `CapPrm`, `CapEff` and `CapBnd` are ALL zero and `NoNewPrivs` is 1. Checking `CapEff` alone would pass a container running as uid 0 with the full bounding set. A refusal destroys the instance and rejects, so no handle to an under-hardened sandbox escapes, and the error distinguishes "the probe could not run" (a minimal image with no `cat`) from "the process is privileged". **There is no configuration that turns this off.** If your image's entrypoint does not end with `exec setpriv --reuid --regid --clear-groups --inh-caps=-all --bounding-set=-all --no-new-privs -- node agent.cjs`, or equivalent, `create()` will now reject where it previously returned. The probe carries its own deadline — `min(readyTimeoutMs, 15s)` — so a pod whose agent has wedged (out of memory, an event loop the workload blocked) is refused on your acquire budget rather than held open for the execution controller's five-minute default; budget for a `create()` that can take `readyTimeoutMs` plus that again in the worst case. The probe is a check that the deprivileging happened, not a boundary against a guest that is already compromised — it asks the agent to report its own `/proc/self/status`. The boundary is still the VM and the `NetworkPolicy`.

  **A handle renews its own lease.** The absolute `shutdownTime` this backend stamps on every object it creates bounds a leak; unrenewed it also bounded the RUN, so a session outliving `claimTtlSeconds` (default one hour) had its pod deleted mid-command. The handle now merge-PATCHes that expiry a full TTL forward every half TTL, jittered ±10%, and `destroy()` stops it. **This adds an RBAC requirement**: the ServiceAccount needs `patch` on `sandboxclaims` and `sandboxes` in the sandbox namespace, alongside the verbs it already needed. A renewal that fails is reported to the new optional `KubernetesBackendConfig.onLeaseRenewalError` and retried on the next tick; each PATCH is bounded on its own clock (a quarter of the interval, capped at 30 seconds), so an API server that accepts a renewal and never answers it is abandoned and retried rather than parking the loop and letting the lease expire in silence; and one that finds the object already deleted stops the loop and marks the handle gone, so later calls throw `KubernetesSandboxGoneError` instead of dialing a pod that no longer exists. A handle you drop without calling `destroy()` keeps renewing for as long as the process lives, so `destroy()` is now load-bearing for cleanup inside a long-lived host.

  New on the public surface: `KubernetesPrivilegeProbeError` (with `reason`, `PrivilegeProbeFailure` and `ProcStatusPrivileges`), `KubernetesSandboxDestroyedError`, `KubernetesSandboxGoneError`, `KubernetesAgentUnauthorizedError`, `AgentPreauthFrameTooLargeError`, `TCP_PREAUTH_FRAME_LIMIT_BYTES`, and `KubernetesBackendConfig.onLeaseRenewalError`. Removed: `KubernetesAgentTransportPendingError`, which was never exported from the package entry point and could only ever be thrown by a method that now works.

  One limit worth knowing before you write a large file: every request to the guest dials a fresh connection, so every request is that connection's first — not-yet-authenticated — frame and is bounded by the guest's pre-auth ceiling (8 MiB by default) on every call, not once. A `writeFile` whose base64 body would exceed it throws `AgentPreauthFrameTooLargeError` before dialing, naming the limit; in practice bodies above about 5.9 MiB raw do not fit. Chunking is not implemented — raise `NAMZU_AGENT_MAX_PREAUTH_FRAME_BYTES` in the deployment, or split the write.

  Every other backend is untouched.

- 53c526c: `SandboxAgentHandle` (re-exported from the package's public entry point)
  gains a fourth arm: `{ kind: 'tcp', host, port, token }`. `VsockAgentTransport`
  (also public) gains a new `executeStreamed()` method, and its
  `VsockTransportOptions` gain an optional `onDial` callback. All three
  changes are additive and backward compatible — existing `unix`/`vsock`/`mtls`
  handles, existing `VsockAgentTransport` callers, and the guest protocol are
  untouched (`firecracker/__tests__/transport.test.ts` passes unmodified) — but
  they are genuinely new surface in the compiled `.d.ts`, not yet constructible
  by anything outside `packages/sandbox/src/backends/` until a later workstream
  wires the kubernetes backend up to them.

  Alongside this, a new (package-internal, not yet exported) `KubernetesAgentTransport`
  in `src/backends/kubernetes/transport.ts` dials the guest agent (`agent/agent.cjs`)
  directly over a routed pod network for the upcoming kubernetes backend.

  The `tcp` dialer is a plain `net.connect({ host, port })` per call — no
  routing preamble, no ack, no cached socket or IP — so a `host` that is a
  Kubernetes Service FQDN is re-resolved on every request and a resumed
  pod's new address costs nothing extra. The handle's optional `token`
  rides in each request envelope (the credential field the guest agent
  already accepts); a wrong token surfaces as a named
  `KubernetesAgentUnauthorizedError` rather than a generic protocol error.

  Because every `tcp` request dials a fresh connection, that connection's
  first frame is also the one the guest agent has not authenticated yet,
  so it is bound by the agent's pre-auth frame ceiling (8 MiB by default)
  on every call, not just on first use. This transport now checks an
  outgoing envelope's size against that ceiling BEFORE dialing and throws
  a named `AgentPreauthFrameTooLargeError` naming the limit, instead of
  opening a connection the agent would refuse anyway. Chunking a large
  `write-file` body across multiple frames is a documented follow-up, not
  implemented here.

  `KubernetesAgentTransport` also accepts an optional `onTiming` callback
  reporting a completed `exec()` call's dial/reserve/execute/drain
  durations (never the token, command, or output), so the kubernetes
  backend's sub-second warm-acquire target can be measured rather than
  assumed.

- 50de52b: The Kubernetes backend can now keep a workspace: a sandbox with a block-mode disk that survives being suspended.

  **New verb, not a new provider.** `createKubernetesWorkspace(config, options)` returns a `KubernetesWorkspace` — the SDK's `Sandbox`, plus `suspend()`, `resume()`, a `suspended` flag, and a `destroy()` that takes `deleteDisk`. It is separate from `createSandboxProvider` because a `SandboxProvider` promises an ephemeral sandbox per run and this promises the opposite; `warmPoolName` is ignored, since a workspace is always a `Sandbox` POSTed directly. `@namzu/sdk`'s `Sandbox` is untouched: no new `SandboxStatus` member, no `suspend?()`/`resume?()` on the shared contract, no `deleteDisk` on the shared `SandboxDestroyOptions`.

  **`destroy()` keeps the disk.** The API has `operatingMode` and it has DELETE, and nothing in between, so there is no delete-compute-keep-disk verb to offer. `destroy()` and `destroy({ deleteDisk: false })` SUSPEND and leave the object standing; only `destroy({ deleteDisk: true })` DELETEs the Sandbox and cascades to its Pod, Service and PVC. The default is the non-destructive one because `destroy()` is what a `finally` block calls. No failure path ever deletes: a create or resume that fails after the object exists suspends it and rethrows — including a create that POSTed the object itself, because two processes can be coming up on one name at once and the one that got the `201` would otherwise delete the disk the other just adopted. The named cost: a failed create can leave one suspended `Sandbox` and its PVC standing, which nothing reaps and which the caller finds again under the same name.

  **A workspace carries no lease.** Unlike a task sandbox it gets no `shutdownTime`, no `shutdownPolicy: Delete` and no renewal loop. An expiry on a workspace is a timer that deletes your files, and a renewal loop makes keeping them conditional on a host process staying up. The trade is explicit: **nothing reaps a workspace you abandon** — the PVC stands until someone calls `destroy({ deleteDisk: true })` or deletes the Sandbox by hand.

  **The disk is fixed at creation and must be `volumeMode: Block` — every entry of it.** `Sandbox.spec.volumeClaimTemplates` is CEL-immutable and a `SandboxClaim` carrying one is forced to cold-start, so "claim a warm diskless sandbox and attach a disk later" is not expressible in this API; resizing is out of scope for the same reason. The `SandboxTemplate` a workspace is built from must declare at least one `volumeClaimTemplates` entry, every entry must be `Block`, and every entry must be claimed through a container's `volumeDevices` rather than `volumeMounts`. Anything else throws the new `KubernetesWorkspaceDiskError` before anything is created — each refused shape otherwise WORKS: no disk gives you a sandbox whose files vanish on the first suspend, and a `Filesystem` PVC under a VM-isolating RuntimeClass reaches the guest over a filesystem passthrough that pays a round trip per file operation, so a dependency-tree walk is several times slower and nothing fails.

  **`config.egress` applies to a workspace too.** `createKubernetesWorkspace` runs the same two steps a provider `create()` runs: a `static`/`resolver` hostname allowlist with no FQDN-capable `engine` is refused synchronously, before any request, and the `NetworkPolicy` an operator applied is fetched and matched against the translation before anything is created. It is checked against the template the workspace is built from (`options.sandboxTemplateName`, falling back to `config.sandboxTemplateName`), because that name is the pod label the policy's `podSelector` matches — a deployment with a separate workspace template needs a policy object for it (`<workspace template>-egress` by default), and the task template's does not cover a workspace pod. Unlike the provider's once-per-backend check, this one runs on every call.

  **A suspend waits for the pod, and only the pod.** `suspend()` resolves once the pod is gone or in a terminal phase — not on the Sandbox's `Suspended` condition, which upstream documents as lingering True after a resume, and not on a `deletionTimestamp`, which is set while the guest is still running and still writing to the disk. A pod that outlives `readyTimeoutMs` rejects with the new `KubernetesWorkspaceSuspendTimeoutError` rather than resolving early. A call already in flight when `suspend()` starts is not cancelled: it fails at the transport, not with the suspended error.

  **A state is recorded when the cluster confirms it, never before.** Both verbs are idempotent by early-returning on a recorded state, so the moment that record is written decides what happens to a failure. `suspended` is written after the patch lands AND the pod is observed stopped; `deleted` after the DELETE resolves, or reports the object already gone. A request that fails leaves the state it found and rethrows, so you can retry: a refused suspend patch leaves the workspace running and still serving calls, a suspend whose pod outlived the wait admits no call but is not recorded as finished, and a failed DELETE does not answer your retry "already deleted" while the `Sandbox`, its pod and its PVC stand on the cluster with nothing left that would remove them. Concurrency is covered the other way round, with a single flight per verb: a second `suspend()` or `destroy()` arriving mid-transition awaits the one in progress instead of sending a second request into the window the deferred record opens, and `destroy()` with no options shares the suspend's flight because it is a suspend — the shared request running under the FIRST caller's `signal`, since that is what sharing one request means. `destroy()` is idempotent across the two shapes as well as within each: a plain `destroy()` on a workspace already removed by `destroy({ deleteDisk: true })` is a no-op in either admission order, because `destroy()` is what a `finally` block calls and what it asks for has happened; an explicit `suspend()` on a deleted workspace still throws.

  **Nothing but `deleteDisk: true` deletes — including the path you never call.** When an execution's cancellation cannot be confirmed (a wedged agent, a partitioned pod, the `cancel-execution` window closing with no answer), the shared execution controller retires the pod that command was left in. On a task sandbox retiring means DELETEing the object, correctly — it is disposable and its disk is scratch. A workspace is retired by the same `operatingMode: Suspended` patch `suspend()` sends: the `exec()` still rejects, carrying `retirement: { accepted: true }` once that patch lands (`accepted: false`, with the error, when it does not), the workspace then reads `suspended: true` and admits nothing, and `resume()` brings up a fresh pod on the same disk. A `destroy({ deleteDisk: true })` whose DELETE fails leaves the same shape — session torn down, nothing admitted, `suspended: true` — because neither the delete nor a suspend reached the cluster, so both `resume()` and a retried delete are open to you.

  **A resume rebuilds the address and the token.** A resumed pod keeps the sandbox's name and gets a new uid and a new IP, so `resume()` re-resolves the address, re-reads the bind token and rebuilds the transport, skipping any pod carrying a `deletionTimestamp` or in a terminal phase — while the outgoing pod terminates, a `GET` by name can still answer with it and a selector list can return it beside the new one. `Ready` is not a transition signal either — the controller leaves it standing across a resume the way it leaves `Suspended` standing — so the uid is POLLED under `readyTimeoutMs` until a live pod with a uid different from the one the last landed suspend patch retired is found, rather than read once from a status that has not caught up. That covers a resume issued straight after a suspend whose pod outlived its own wait, which arrives mid-drain with no live pod of that name to read at all. Every patch that lands is recorded the same way — an explicit `suspend()`, the retirement above, and the cleanup after a failed create or resume, which swallows its own failure and therefore records only when the request actually came back; a pod nobody asked the controller to remove has no replacement to wait for, and excluding it would time out a resume whose workspace was perfectly usable. What visibly moves depends on the Service: the token is always new, the pod IP always changes, and a `status.serviceFQDN` address does not, because the Service outlives the pod. The acquire-time privilege probe runs again on every resume. Between a suspend and a resume every call throws the new `KubernetesWorkspaceSuspendedError` and issues no dial, because the Service outlives the pod and a dial would hang on a connect timeout that names nothing. `status` reports `destroyed` while suspended — `SandboxStatus` has no suspended member — and `suspended` is what tells the recoverable state from the final one.

  **Calling it twice reattaches — and what is adopted is checked.** The Sandbox is named `namzu-ws-<workspaceId>`, so a second process finds the same workspace; a create that collides adopts the existing object and resumes it if it was asleep. Because an adopt is handed an object this call did not build, the object is checked against the configuration before it is woken: it must carry a block disk, its pod template must carry `sandbox.namzu.ai/template` for the template this call builds from, and — when `runtimeClassName` is configured — it must already run under that class. A disagreement throws the new `KubernetesWorkspaceMismatchError` and nothing is patched, woken or dialed. The label check runs whether or not `config.egress` is set, since that label is what a policy's `podSelector` matches and adopting an object built from another template would hand back a pod the verified policy does not select; the RuntimeClass check is there because the privilege probe cannot see a missing VM boundary (`/proc/self/status` reads the same under Kata and under runc). The fix is to point the workspace at the template it was built from, or to delete the Sandbox — which takes its disk with it — and create it again.

  A `workspaceId` that is not already a legal DNS-1123 label is refused rather than sanitised, because two ids that sanitise to one name would silently share one disk. It is a name and not a lock: two host processes can adopt one running workspace, and either one's `destroy()` suspends the pod the other is executing in.

  **Fixed on the task path, in the same change:** a pool-less `create()` copied the `SandboxTemplate`'s `podTemplate` and dropped its `volumeClaimTemplates`, so a task template declaring a disk produced a healthy Sandbox with no disk and a container naming a volume that did not exist. Both paths now copy the template's `volumeClaimTemplates` verbatim. If you have been working around that by declaring no disk on a task template, nothing changes; if you declared one and wondered where it went, it now arrives.

  New on the public surface: `createKubernetesWorkspace`, `KubernetesWorkspace`, `KubernetesWorkspaceOptions`, `KubernetesWorkspaceDestroyOptions`, `KubernetesWorkspaceTransitionOptions`, `KubernetesWorkspaceDiskError`, `KubernetesWorkspaceMismatchError`, `KubernetesWorkspaceSuspendTimeoutError`, `KubernetesWorkspaceSuspendedError`. RBAC is unchanged — a workspace uses verbs the task path already needed. Every other backend is untouched.

- a70c936: A `Sandbox` contract conformance suite: `defineSandboxConformance` (`packages/sandbox/src/testing/sandbox-conformance.ts`) asserts `exec`'s exit codes and streamed output, the `AbortSignal` contract (the process is genuinely terminated, never a resolved result that reads as an unaborted success), a `writeFile`/`readFile` round trip including binary content, `listFiles`, `openTerminal` ownership on `destroy()`, `openTcpConnection` to guest loopback and its refusal of a non-loopback host, destroy idempotence, and every call failing once destroyed. It takes its `describe`/`it`/`expect` and a factory producing a fresh `Sandbox` as arguments, the same shape `@namzu/sdk/testing`'s checkpoint-store and provider-driver suites already use, so `@namzu/sandbox` gains no test dependency from shipping it and a caller can run it against a recording harness.

  **New exported surface, within the package only.** `@namzu/sandbox` has no `testing` subpath in its published `exports` map, and this change does not add one — that is a deliberate, separate decision. A caller inside this monorepo imports `defineSandboxConformance` by relative path (`src/testing/sandbox-conformance.js`), exactly as the two new test files below do. It is minor rather than patch because it is new, intentionally-public TypeScript surface a consumer with access to the package's source can import and depend on, even though nothing in `@namzu/sandbox`'s npm entry point changes shape.

  **Proven against two backends, not one.** `packages/sandbox/src/backends/kubernetes/__tests__/conformance.test.ts` and `packages/sandbox/src/backends/firecracker/__tests__/conformance.test.ts` both run the identical suite — the kubernetes backend over a real `agent/agent.cjs` on a loopback TCP socket, Firecracker over the same agent on its existing unix-domain-socket fixture — which is what makes it a contract suite rather than one backend's tests wearing a new name. `packages/sandbox/src/testing/__tests__/conformance-fails-a-broken-sandbox.test.ts` is the suite's own negative test: three deliberately broken `Sandbox`s (resolves `exec` after abort, `destroy()` leaves a terminal running, `readFile` returns corrupted bytes) each fail it by name.

  Nothing existing changes shape — every other export, every shipped backend's behavior, is untouched.

### Patch Changes

- 4b0e7ad: `defineSandboxConformance`'s `openTcpConnection` positive case now starts its echo listener INSIDE the guest, through `openTerminal`, instead of on the orchestrator/test process's own loopback. The old fixture only ever proved anything for a backend whose "guest" happened to share that loopback with the test process (a Firecracker unit test over a local socket, a fake-agent-in-process kubernetes test) — it could never pass against a real remote sandbox, which cannot dial the orchestrator's loopback at all. Confirmed in-cluster: this case now passes against a live kubernetes backend acquisition on a real kind cluster, where it previously failed with `connect ECONNREFUSED`.

  Two new optional fields on `SandboxConformanceOptions` — `guestCanRunNode` and `guestListenerCommand` — let a backend whose guest cannot run a listener this way skip the case with a stated reason (its own title) rather than fail spuriously; both default to the existing behavior (node is assumed available, since every shipped backend's guest agent already runs on node), so no existing caller of `defineSandboxConformance` needs to change anything.

  Patch, not minor: this module has no `testing` subpath in `@namzu/sandbox`'s own `exports` map (see the file's own doc comment) — a caller reaches it only by relative path within the monorepo, as `backends/kubernetes/__tests__/conformance.test.ts` and `backends/firecracker/__tests__/conformance.test.ts` already do — so this is not yet public surface, and the added options are additive and optional regardless.

  Also corrects a self-contradictory doc comment on `Sandbox.openTerminal` (`@namzu/sdk`): it told an implementer to both "throw" and "omit" for a guest that cannot provide one. It now says only "omit", matching `Sandbox.openTcpConnection`'s own wording and this suite's documented skip-if-unavailable convention. Comment-only; no type or behavior changed.

- 13d01db: Adds an internal Kubernetes API client (`backends/kubernetes/k8s-client.ts`, not yet exported from the package entrypoint) for an in-progress Kubernetes/Kata sandbox backend. It speaks the API server with bare `fetch`, falling back to `node:https` only when a custom cluster CA is supplied, and bootstraps in-cluster credentials straight from the projected ServiceAccount volume — the same zero-dependency pattern the ACI and Firecracker backends already use. `@namzu/sandbox` still declares no `dependencies` key.
- 77adb50: Fix both the kubernetes/Firecracker guest agent (`agent/agent.cjs`) and the
  container-tier HTTP worker (`worker/server.js`) reporting a cancelled
  `exec()` as a clean, unaborted-looking success when the target process
  ignores `SIGTERM` but happens to finish on its own before the cancel grace
  window elapses. Both peers' `terminateAndConfirm` only escalated to
  `SIGKILL` if the owned process group was still alive at the end of that
  window, with nothing checking that the exit was actually caused by the
  signal — so an ignoring process whose natural runtime was under the grace
  period ran to completion untouched, in violation of
  `SandboxExecOptions.signal`'s contract ("must terminate the owned process
  ... never silently ignore the signal and let the command run to
  completion"). This is the same mechanism on both transports, found on the
  guest agent first (issue #469's kind conformance run) and confirmed to
  exist verbatim in the worker once looked for.

  The default (previously `2000`ms on both) is now `250`ms for
  `NAMZU_AGENT_CANCEL_GRACE_MS` (agent) and `NAMZU_SANDBOX_CANCEL_GRACE_MS`
  (worker) — comfortably under the shared conformance suite's adversarial
  fixture (a command that finishes on its own in ~400ms) while still enough
  for a fast, well-behaved SIGTERM handler's cleanup. A deployment that
  genuinely needs a longer window for cooperative shutdown sets either
  variable explicitly; both were already, and remain, overridable. A new
  regression test on each transport deliberately leaves its own grace
  variable unset — the one thing every other suite on that transport
  overrides — and fails against the old default, passes against the new one.

  **Defect 2, found alongside the agent fix, is now MITIGATED for the
  Kubernetes backend's shipped image, not merely documented:** in a real pod
  the agent used to run as the container's PID 1 with no subreaper
  (`packages/sandbox/k8s/entrypoint.sh` `exec`ed straight into it), so a
  background job forked by a cancelled `sh -c` command (`... &`) reparented
  to the agent on `SIGKILL` and was never reaped — Node's `child_process`
  only `waitpid()`s the children it spawned itself — running that
  cancellation out the full `RemoteExecutionController` cancel-confirm window
  (8s by default) and tearing the sandbox down instead of confirming.
  `k8s/entrypoint.sh` now execs into `tini` (installed in `k8s/Dockerfile`)
  as the container's real PID 1 and subreaper, with the guest agent as its
  child; `tini` reaps the orphan and forwards `SIGTERM` to the agent exactly
  as before. **A host building its own image from `agent.cjs` directly rather
  than from `k8s/Dockerfile` must still provide its own subreaper as PID 1**
  — this fix lives in the shipped image, not in the agent itself, since
  `agent.cjs` cannot know what pid it is. Root-caused with live evidence in
  `research/k8s-sandbox/kind-e2e-results.md` ("Defect 2", `2026-09-16`) and
  re-verified in-cluster against the new image in
  `research/k8s-sandbox/abort-case-recheck-results.json`.

  **Patch, not minor or major:** `agent/agent.cjs` and `worker/server.js` are
  guest/worker files that run INSIDE a sandbox or container, never imported
  by a consumer of the published `@namzu/sandbox` tarball (`npm pack
--dry-run` packs only `dist` and `src`); the k8s image's `Dockerfile` and
  `entrypoint.sh` are likewise deployment artifacts, not the package's own
  `exports`. Both defaults that changed are guest-/worker-internal timings
  with no public type or exported symbol affected, and both changes narrow
  when a cancellation escalates to `SIGKILL` and add a real subreaper —
  strictly tightening what `SandboxExecOptions.signal`'s contract already
  promised, never loosening it, so no caller-visible behavior a consumer
  could have depended on gets worse.

- Updated dependencies [68e535b]
- Updated dependencies [a9e4b19]
- Updated dependencies [a54dc71]
- Updated dependencies [86a3818]
- Updated dependencies [03630cd]
- Updated dependencies [f33c62b]
- Updated dependencies [a8df193]
- Updated dependencies [8bfe291]
- Updated dependencies [6ae4072]
- Updated dependencies [dd8702d]
- Updated dependencies [92ab1d9]
- Updated dependencies [e6d6d1e]
- Updated dependencies [7ca8c7d]
  - @namzu/sdk@40.0.0

## 13.0.0

### Patch Changes

- Updated dependencies [40651dd]
- Updated dependencies [b156888]
- Updated dependencies [7bb8163]
- Updated dependencies [2d26b44]
- Updated dependencies [6663561]
- Updated dependencies [2a1e0e5]
- Updated dependencies [ce55c21]
- Updated dependencies [9463b6f]
- Updated dependencies [de53442]
- Updated dependencies [6e4a820]
- Updated dependencies [28d3874]
- Updated dependencies [985db49]
- Updated dependencies [bd4bd2e]
- Updated dependencies [fe6e0fb]
- Updated dependencies [bb0281b]
- Updated dependencies [cff2b6a]
- Updated dependencies [df686fc]
- Updated dependencies [e954d02]
- Updated dependencies [2869fbe]
- Updated dependencies [b1e3bc5]
- Updated dependencies [df143c8]
- Updated dependencies [45c8292]
- Updated dependencies [6e14db9]
- Updated dependencies [6a6921c]
- Updated dependencies [691342c]
- Updated dependencies [d5d2b9a]
- Updated dependencies [b971796]
- Updated dependencies [e9a4192]
- Updated dependencies [612879e]
- Updated dependencies [e7bc7a1]
- Updated dependencies [b2d5b01]
- Updated dependencies [3e09024]
- Updated dependencies [f49a4b8]
- Updated dependencies [43124f0]
- Updated dependencies [e40044b]
- Updated dependencies [6446182]
- Updated dependencies [0a0baf2]
- Updated dependencies [c4aaf9b]
- Updated dependencies [77272e3]
- Updated dependencies [7579aa0]
- Updated dependencies [5996a84]
- Updated dependencies [ebfb3b4]
- Updated dependencies [4828eb0]
- Updated dependencies [97acc32]
- Updated dependencies [c329408]
- Updated dependencies [b649224]
- Updated dependencies [10e9984]
- Updated dependencies [4801a6f]
- Updated dependencies [b9e0f37]
- Updated dependencies [2bcf017]
- Updated dependencies [e63ca83]
- Updated dependencies [830f81e]
- Updated dependencies [6394010]
- Updated dependencies [f4b3ffb]
- Updated dependencies [9a4877a]
- Updated dependencies [f92daf8]
- Updated dependencies [22203b0]
- Updated dependencies [5d31eea]
- Updated dependencies [9ea5074]
- Updated dependencies [f1e33a1]
- Updated dependencies [2e93158]
- Updated dependencies [1d651d0]
- Updated dependencies [b888779]
- Updated dependencies [281859f]
- Updated dependencies [d1a6ce5]
- Updated dependencies [d81aca6]
- Updated dependencies [61aab1f]
- Updated dependencies [ea5367d]
- Updated dependencies [0fa8941]
- Updated dependencies [3c60512]
- Updated dependencies [8095541]
- Updated dependencies [6c682d8]
- Updated dependencies [bdf923d]
- Updated dependencies [656e79d]
- Updated dependencies [3c6326f]
- Updated dependencies [0a36260]
- Updated dependencies [f3b377e]
- Updated dependencies [fd0d270]
  - @namzu/sdk@39.0.0

## 12.0.1

### Patch Changes

- 2d71d68: Make worker lease regression tests deterministic under slow scheduling by controlling the test worker's clock. This changes validation only; sandbox runtime behavior is unchanged.

## 12.0.0

### Major Changes

- 786ca01: Require container workers and Firecracker guests to publish the exact remote-execution protocol during readiness, refuse missing or mismatched peers before command admission, remove identity-less legacy execution, and export the Firecracker guest protocol version for host warm-pool admission checks. Rebuild worker images, standby-pool profiles, and microVM goldens from the same release before deploying the matching host.

### Minor Changes

- 786ca01: Carry explicit Firecracker network intent on the orchestrator create request.
  `allow-all`, `deny-all`, and resolved allowlists now have distinct wire shapes;
  an absent policy keeps the legacy request unchanged.
- 786ca01: Add guest-owned pseudo-terminal and loopback TCP stream capabilities to the
  Firecracker sandbox, including lifecycle ownership and bidirectional
  backpressure.

## 11.0.0

### Patch Changes

- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
- Updated dependencies [7785cb4]
  - @namzu/sdk@38.0.0

## 10.0.0

### Patch Changes

- Updated dependencies [4d66337]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [67d8438]
- Updated dependencies [c5cf4de]
- Updated dependencies [4a46cb2]
- Updated dependencies [c5cf4de]
- Updated dependencies [086ade9]
- Updated dependencies [035dcbc]
- Updated dependencies [c635b5a]
- Updated dependencies [e81a109]
- Updated dependencies [e81a109]
- Updated dependencies [2b0d90d]
- Updated dependencies [8a7a4d5]
- Updated dependencies [f370947]
- Updated dependencies [ce514f9]
- Updated dependencies [f370947]
- Updated dependencies [481b3d5]
- Updated dependencies [c78fd3f]
- Updated dependencies [d045660]
- Updated dependencies [b4408d6]
- Updated dependencies [b33dc98]
- Updated dependencies [b4408d6]
  - @namzu/sdk@37.0.0

## 9.0.0

### Major Changes

- 0662f34: Make glob scope explicit and bound filesystem discovery while it runs. Bare `*` and `*.ts` now search only the selected directory; use `**/*` or `**/*.ts` to recurse. Wildcard searches exclude hidden entries by default; set `include_hidden: true` to retain searches that previously included them inside a sandbox. Glob returns regular files only and skips symlink entries during enumeration; authorized local root aliases remain supported. Its execution deadline changes from the generic 120 seconds to 15 seconds, so large searches should use a narrower directory or pattern.

  Glob now uses the optional `Sandbox.walkFiles` capability instead of collecting a complete recursive `listFiles` inventory. Custom sandbox adapters must implement `walkFiles` to support builtin glob; unsupported adapters receive an explicit failure without a host fallback. Local, Docker, ACI and Firecracker adapters implement bounded incremental enumeration. `SandboxWalkFilesOptions` and `walkFilesViaExec` are exported for adapter authors. The sandbox package now requires the matching SDK major through its peer dependency because it imports this new runtime helper.

  Result and traversal limits produce explicit incomplete-search metadata and preserve available matches. Patterns are limited to 4,096 characters and 256 brace expansions, with consistent hidden-file matching in grouped alternatives. Sandbox search paths are resolved once, fixing duplicated absolute paths in glob, grep and ls. Runtime guidance permits direct reads of known paths, and the CLI tool label now shows both the glob pattern and directory.

### Patch Changes

- Updated dependencies [32ef6f6]
- Updated dependencies [0662f34]
- Updated dependencies [afa0712]
- Updated dependencies [32ef6f6]
- Updated dependencies [073a877]
  - @namzu/sdk@36.0.0

## 8.0.0

### Major Changes

- 47e573c: Kernel ID factories, file-lock IDs and SDK-managed Docker/ACI sandbox IDs now generate UUID v4 strings instead of prefixed random strings. Nominal TypeScript entity brands remain, but their underlying type is an opaque string rather than a prefixed template literal. Before upgrading, remove prefix parsing and prefix-only validators in consumers; use checked constructors or the new `isEntityId(value, kind)` predicate and validate ownership through store records. Public Project, Run and Message schemas accept only UUIDs while remaining Zod string schemas. External sandbox/orchestrator IDs retain their service-defined contracts.

  `InvalidIdError.expectedKind` replaces `expectedPrefix`; hosts displaying validation errors must read the entity kind instead. Built-in HTTP/webhook connector IDs and the default shell-hook plugin ID are now stable UUIDs.

  Prefixed records, including formerly accepted safe prefixes, are no longer admitted. Constructors, schemas and disk readers require UUIDs. No automatic migration or deletion is performed. Supply UUIDs for custom IDs and use a fresh dedicated application home when previous state is no longer needed. Do not downgrade UUID stores to a prefix-only reader.

  In-memory session and topic stores accept existing Project/Topic snapshots without creating replacement identities. The CLI uses this to bind delegation to the actual parent run, conversation, project and tenant. Child artifacts now live beneath the owning Project's `subagents/sessions` tree, without another generated Project layer. Scripts inspecting the old nested subagent layout must follow the new paths for new children; historical artifacts remain in place. Completed parent runs release their delegated children and bookkeeping. Tasks default to the actual invoking run instead of `run_namzu-cli`.

  CLI state selectors, session maps and transcript export require UUIDs; export skips the reserved emergency-snapshot directory. Emergency-to-checkpoint projection uses the snapshot's existing UUID. The CLI always selects the checkout-root binding, even when an older directory-specific Project exists. Historical records are left in place and are not merged. Durable `drain` now requires an authoritative persisted Session and takes its Topic from that record; checkpoint-only hosts must persist the Session metadata before draining.

## 7.2.0

### Minor Changes

- 4c31053: The coding CLI now runs sandbox-aware tools against the canonical project directory by default, and project changes survive individual turn and child-run teardown. Set `sandbox.workspace` to `ephemeral` to retain the previous disposable per-run workspace behavior.

  The SDK now honours `SandboxCreateConfig.workingDirectory` in `LocalSandboxProvider`, carries run-level sandbox workspace policy through `runAgent`, reactive, supervisor, and delegated-agent entry points, and requires providers to advertise `working-directory` support before receiving a host project path. Custom providers used with `sandbox.workspace: 'working-directory'` must add that mode to `workspaceModes`; omit the workspace mode to retain ephemeral behavior. `PipelineAgent` refuses this setting because arbitrary developer callbacks cannot be confined by the tool sandbox.

  The optional sandbox package now advertises its construction-time container and guest layouts as ephemeral-only instead of accepting a per-run host directory it cannot mount.

## 7.1.0

### Minor Changes

- 84d202d: Honor `SandboxExecOptions.signal` in the framed microVM backend through a
  reserve-before-admission and idempotent cancellation protocol. Remote execution
  now preserves streamed output and terminal signal/truncation metadata, refuses
  malformed or trailing terminal frames, and confirms process-group quiescence
  before a cancelled sandbox can be reused.

  Reject delayed or partial data after the framed terminator, route the public
  request-shaped microVM transport method through the same ownership controller,
  evict terminal history before refusing live capacity, and retire rather than
  signal a numeric process-group id after its leader exits. Teardown calls are
  coalesced and Docker retirement now reports success only when removal succeeds;
  credential-proxy cleanup still runs on removal failure.

  Reserve every command on current HTTP and framed peers, including commands
  without a caller signal. Explicitly detected older peers keep legacy no-signal
  execution; an ambiguous legacy result or unconfirmed cancellation fences the
  handle and retires the whole container, container group, or microVM.

- 8943b5b: HTTP-container sandbox commands now honour `SandboxExecOptions.signal` through
  an acknowledged execution lease and a separately bounded cancellation request.
  Rebuild local worker images and publish a new standby-pool profile revision
  before passing a signal; older workers are refused instead of leaving the
  remote command running behind an aborted request. Calls without a signal keep
  the legacy one-request protocol, and the framed microVM backend remains
  unchanged. Stalled result observation is bounded, unconfirmed termination
  retires the worker, and confirmed termination with incomplete output is
  reported distinctly.

## 7.0.0

### Major Changes

- 9709f6b: Make `readyTimeoutMs` a real worker-readiness deadline across the Docker,
  standby-container, and microVM backends. In-flight health requests, IP polling,
  connect retries, handshakes, framed reads, and retry delays now fit inside the
  remaining total budget. A readiness failure attempts remote teardown for at
  most one additional second, aborting HTTP transports and killing a held Docker
  cleanup child before returning the original readiness error.

  Docker and userspace-kernel container configs now expose and forward
  `readyTimeoutMs` and `readyPollIntervalMs`, with defaults of 30 seconds and 100
  milliseconds. Standby-container readiness now shares one timeout across IP
  publication and worker health instead of granting each phase a fresh full
  budget.

  This is a major change because zero, negative, fractional, non-finite, and
  platform-timer-overflow readiness values previously type-checked and reached
  backend work. They now fail during provider construction. Migrate those values
  to positive safe-integer milliseconds no greater than `2_147_483_647`.

### Minor Changes

- fd5fcea: Bound sandbox lifecycle ownership across run cancellation and teardown.

  Sandbox creation now receives run cancellation and the run's remaining wall-clock timeout, cannot publish a handle after either boundary wins, and releases any handle that arrives late. A setup that ignores its signal therefore settles the run with `stopReason: 'timeout'` instead of pinning it forever. Teardown receives a fresh signal and waits for 30 seconds by default without allowing an implementation that ignores cancellation to pin the run. Set `sandboxTeardownTimeoutMs: 0` on SDK runs or agents to retain the former unbounded teardown wait. Custom providers should honor `SandboxCreateConfig.signal` and `SandboxDestroyOptions.signal`; remote allocation protocols still need a client-owned reconciliation key or fleet reaper for a resource committed behind a lost response.

  The CLI exposes the same compatibility control as `sandbox.teardownTimeoutMs` and carries it to live turns, delegated child agents, and durable resumes. Children and resumed runs now use the session's sandbox provider instead of silently executing through the host boundary; set `sandbox.enabled: false` only when host execution is intentional.

## 6.1.0

### Minor Changes

- 03e363c: Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

  **`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

  If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

  Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

  **`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.

## 6.0.1

### Patch Changes

- b2c005c: Make each README an npm package page rather than the package's manual.

  `@namzu/sdk`'s README was a twenty-four-section architecture tour, 45 KB of it; the others ran to several hundred lines each. That is the right shape for a single-package repository, where the README _is_ the documentation, and the wrong one here — it duplicated a `docs/` tree that already existed, and nothing checked that the two agreed.

  Each README is now what a reader needs in the first minute: what the package is, install with its Node requirement, one working example, and links. The long-form material moved into `docs/` whole — `docs/sdk/architecture.md`, `docs/cli/reference.md`, `docs/packages/<name>.md` — where the doc gates cover it.

  Two documentation defects fell out of the move, both in `@namzu/telemetry`'s session-export example, and both had been shipping: the config field is `redactors` and takes a list, not `redactor` taking one; and `secretRedactor` is a factory that has to be called. The required `destination` field was missing from the example entirely. They surfaced because a README is gated by nothing and `docs/` is compiled against the built SDK.

  No API change.

## 6.0.0

### Major Changes

- 7425f11: The sandbox worker no longer hands its own configuration to the code it contains

  Every command the agent runs was spawned with `{ ...process.env, ...body.env }` — the worker's **entire** environment, copied into every child by construction, on every call, and visible in a bare `env` in any shell transcript.

  That is a stronger exposure than "untrusted code could read `/proc/self/environ` if it thought to look". It is active propagation: the agent does not have to go looking.

  What rode along: `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` and `NAMZU_SANDBOX_WRITE_ROOTS` — **the confinement layout itself, handed to the code being confined** — plus every other worker setting. The boundary announced its own shape to the thing it was drawn around.

  Variables prefixed `NAMZU_SANDBOX_` are now stripped from the inherited environment.

  **Stripping by prefix rather than by an allowlist of known-safe names is the load-bearing choice**, and it is the difference between this working and this quietly breaking egress:

  - `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` are set on the container **on purpose**, so tooling inside routes through the egress boundary. An allowlist assembled from first principles drops them, and every proxied workload silently stops being proxied — which looks exactly like the policy working.
  - A host's own `options.env` arrives on the same channel and is meant to reach commands. Once both are in `process.env` it is indistinguishable from the worker's config; the prefix is the only thing that tells them apart.

  `body.env` is applied **after** the strip and is not filtered. Inheritance is implicit and gets the default; an explicit per-call value is a caller deciding, including one that deliberately sets a prefixed name.

  **What changes for you.** A command that read `NAMZU_SANDBOX_WORKSPACE`, `NAMZU_SANDBOX_READ_ROOTS` or `NAMZU_SANDBOX_WRITE_ROOTS` out of its own environment no longer sees them. Pass the value explicitly — `exec`'s `env`, or the provider's `options.env` under a name of your own — if a workload genuinely needs it. The workspace root is also the command's `cwd`, which is how most callers were getting it already.

  `major` because the environment a spawned command observes is behaviour a consumer can depend on, even though nothing in the type surface changed.

### Patch Changes

- 7aaa35d: Strings that were asserted into ids now go through the checked constructors, and three defects the assertions were hiding are fixed.

  **A docker sandbox's id had the wrong prefix.** `SandboxId` is `` `sbx_${string}` ``; `@namzu/sandbox`'s docker backend minted `sandbox_...` and an `as SandboxId` was the only reason that compiled. Every docker sandbox in the tree carried an id its own type says is impossible — the ACI backend already minted `sbx_`. Both now mint through `asSandboxId`, which is the call that would have caught it. **The container name derives from this** (`namzu-sandbox-${id}`), so a container started by this release is named differently from one an older build started. Nothing matches on the old spelling — teardown computes the name from the id it just minted, in the same process — but it is visible in `docker ps`, and any external tooling that pattern-matched `namzu-sandbox-sandbox_` needs updating.

  **A corrupt migration marker was honoured instead of refused.** `readMarker`'s shape check validated the envelope — `version`, `at`, and that `migratedThreads` is an array — and never looked inside the array. `{"migratedThreads":[null]}` therefore parsed cleanly and produced an entry whose `newProjectId` was `undefined` wearing a `ProjectId` annotation, which then reached a path join. Each element is now checked, and a bad one returns `null` — which is exactly what this function already promised to do about corruption, so the caller re-runs the migration rather than trusting it.

  **`namzu drain` accepted a mistyped scope flag.** `--tenant`, `--project` and `--session` were asserted straight into their id types, so `--tenant prj_a` reached the store and listed nothing — and "no runs" is the same output as a scope that really is empty, which made the typo invisible. Each flag is now prefix-checked, and the refusal names the prefix it wanted, in the same operator-readable shape the command's other refusals use.

  **Model-authored ids are checked before they become store keys.** `read_memory`, `task_update` and the RAG tool took an id straight from the model's tool input and asserted it. A malformed one read back as "not found", telling the model its record had disappeared rather than that it named the wrong thing. All three now refuse with `InvalidIdError`, whose message says which prefix was expected.

  Nothing here changes an exported type, a signature or a default. Sites where a cast is still correct — a value already guarded by an explicit prefix check, an id minted by a service outside this repo, a sentinel the type cannot express — keep the cast and now carry the reason next to it.

- 701bd02: Bring the worker and guest agent under the linter, and document what they already do

  `biome.json` restricted `files.include` to `src/**/*.ts` and the lint script ran `biome check src/`. Two independent exclusions of the same directories, so `worker/server.js` and `agent/agent.cjs` were checked by nothing — including the worker, which is the HTTP surface that executes commands inside the container and has no type checking either, being plain CommonJS.

  Turning it on immediately found dead code: an unused `readNdjson` helper in the worker's own test file. The rest were `useOptionalChain` rewrites in crash handlers, applied and reviewed one at a time — `err && err.stack ? err.stack : err` and `err?.stack ? err.stack : err` take the same branch for every input, including a non-`Error` throw.

  `noConsole` is off for these two directories. They are standalone processes, not modules this package imports, and stdout is their only channel: the host's readiness path and the test harness both wait on the worker's `listening on` line, and the crash handlers exist so an unhandled rejection is diagnosable rather than a silent exit. A logger abstraction would mean a dependency in files that deliberately have none. (The reason lives here and in the commit rather than beside the setting, because `biome.json` is strict JSON and rejects both comments and unknown keys.)

  Two documentation debts from earlier changes are cleared in the same pass:

  - The README's `--cap-drop=ALL` bullet carried only one of its two reasons. It also stops an `--internal` network's egress denial from being undone by a single `ip route add`, which is refused only because `NET_ADMIN` is absent.
  - The README said nothing about the environment a spawned command sees, which changed materially when the worker stopped passing on its own configuration. It now says what is stripped, what is inherited and why the proxy variables and `options.env` must be.

  No behaviour change.

## 5.0.0

### Major Changes

- a208ba8: The docker backend's default configuration could not create a sandbox, and the test that would have caught it had never run

  `create()` failed on the documented defaults — `network: 'none'`, `hostReachability: 'host-port'` — with `index of untyped nil` thrown out of a `docker inspect` template, reported as "the container exited immediately". The container was alive and well. Docker binds a published port to the container's address by NAT, so a container with no route out has no address to bind to and nothing is published; measured against Docker 29.6, `--network none --publish 127.0.0.1::2024` is _accepted_ and `NetworkSettings.Ports` comes back `{"2024/tcp":[]}`. An `--internal` network behaves the same way.

  `deny-all` had the same defect from the other side. It answered `--network none`, which reads as the strictest possible answer and removes the interface the worker is reached on — so it denied the way _in_ along with the way out, in both reachability modes.

  **Why no one noticed.** `packages/sandbox/vitest.config.ts` excludes `**/*.smoke.test.ts` from every run it governs, including the `test:smoke` run that exists to run them; naming the files as CLI arguments does not re-include them, because positional arguments filter what discovery already found. With `--passWithNoTests`, `pnpm sandbox:smoke` printed `No test files found, exiting with code 0` and the workflow went green — after building a Debian image with a browser and an office suite in it to run nothing. The suite's own fail-fast guard for a misconfigured CI could not fire either: it lives inside a file that was never loaded.

  **What changes for you.**

  - The smoke suite has its own config and no `--passWithNoTests`, so an empty run is now a failure.
  - `create()` checks the container's network against the daemon before starting anything, and refuses with the reason. **The `network` default of `'none'` is one of the pairings it refuses** — name a bridge to reach the worker by host port, or set `hostReachability: 'container-network'`.
  - `deny-all` now keeps the configured network and **requires it to be one created with `docker network create --internal`**, verified rather than trusted. That is a real boundary: outbound gets `Network unreachable` from the kernel, not from an environment variable a workload may decline to read, while sibling containers still reach the worker by name.
  - Consequently **`deny-all` over a published host port is refused as impossible**, not unsupported: a published port needs a route out and `deny-all` needs none. Closing that means moving the worker's control channel off TCP, which is tracked separately.
  - `resolveNetwork` no longer returns `'none'` for `deny-all`. `assertNetworkCarriesThePolicy` and `isInternalNetwork` are exported alongside it.

### Patch Changes

- 3e591c7: Record why the capability drop is load-bearing for egress denial

  Comment only; no behaviour change.

  `deny-all` is now enforced by the container's network being `--internal`, and it was worth measuring what that is actually worth. A container on such a network has no default route — but `ip route add default via <sibling>` is refused with `Operation not permitted` under docker's **default** capability set, before `--cap-drop=ALL` is applied at all. `NET_ADMIN` is what would lift that.

  So the internal network removes the route and the capability drop removes the ability to put one back. Both are needed, and `HARDENING_ARGS` previously justified the drop only on unrelated grounds (`CAP_DAC_OVERRIDE` walking past read-only binds) — a rationale that would survive softening the flag, while this one would not.

  Also recorded: given `NET_ADMIN` and a manually installed route, a dual-homed sibling _does_ forward the packet (`net.ipv4.ip_forward` is `1` inside a container). No connection establishes because nothing masquerades the internal subnet, but the docblock says plainly that this is not a security property — one-way egress is enough for exfiltration, and what was measured is a failed handshake, not a dropped packet.

## 4.0.0

### Major Changes

- d33bfdd: The standby-pool backend refuses to claim a container group on a public address

  Omitting `subnetId` meant the platform assigned a public address, and the backend claimed the group and dialled it without comment. The worker answering there has no authentication of any kind — `worker/server.js` states "Authn: none" in its own docblock — so an unauthenticated execute endpoint was reachable from the internet, chosen by a caller who had never heard of a field.

  The backend now refuses that combination. Two ways forward, and the error names both:

  - **`subnetId`** — inject the group into a private network. This is the production answer, and the file already recommended it.
  - **`allowPublicAddress: true`** — a new option, off by default, for a benchmark where you mean it.

  **This is `major` and it will stop a deployment that works today.** If you run this backend with no `subnetId`, the next claim throws instead of succeeding. That is deliberate: the alternative is a warning on a path that otherwise succeeds, which is read once and never again.

  The trust-model docblock used to end "Caller decides". Nothing asked them — omitting a field chose the public address silently, which is not a decision. That sentence has been corrected rather than deleted, so a reader who saw the old one learns what changed.

### Minor Changes

- 3f44f0d: A command running in a sandbox now reports progress while it runs

  Both halves of this existed and neither was connected to the other.

  Every container worker streams its output a chunk at a time — the wire has always carried `stdout_delta` and `stderr_delta` events — and every backend concatenated those chunks into a string and returned it when the process exited. Separately, `ToolContext.report` exists precisely to answer "is it still working?", is supplied per call by the executor, emits a `tool_progress` event, and is mapped onto the event stream for live consumers. It had **no caller anywhere in the tree**.

  So a command that ran for eight minutes said nothing for eight minutes, over a transport that had been reporting the whole time.

  **New:** `SandboxExecOptions.onOutput`, called as output arrives. Optional and additive — a backend that cannot stream never calls it, and `SandboxExecResult.stdout` still carries the complete output either way, so a caller that ignores it behaves exactly as before. Wired through the two container backends that carry the streaming worker protocol.

  **The `bash` builtin now uses it**, sending the last non-empty line of each chunk to `context.report`. A progress slot renders one line and replaces it, so sending a whole chunk would put a wall of text in a space that shows one line of it.

  Progress is ephemeral by design — `tool_progress` is excluded from the durable transcript so a tool reporting every file it compiles cannot write thousands of lines into the record. The model is still given `result.stdout`; this is a status signal, not a second copy of the output.

### Patch Changes

- 1cb8cc9: The package description no longer claims an authentication this proxy does not have

  `package.json#description` described the container tier as an "HTTP worker + JWT-authenticated egress proxy". The egress proxy has no inbound authentication of any kind — no token, no JWT, no check. The only occurrence of `proxy-authorization` in `src/egress/proxy.ts` is in the list of hop-by-hop headers it deletes, so the header a client would authenticate with is explicitly stripped.

  This mattered more than an ordinary comment would, because a package description is the text on the registry page — where somebody decides whether this package is safe to depend on, before they have any source to read.

  The description now says what the proxy actually is: loopback-bound, deciding by resolved address rather than by hostname, and brokering outbound credentials so a token never enters the sandbox. Those are the controls it has, and they are the ones worth knowing about.

  No behaviour changes.

## 3.0.0

### Major Changes

- cfadac7: The egress boundary now decides by resolved address, not only by hostname

  `EgressProxy` allowed or refused on the client-supplied **name**, and nothing
  in the package resolved or inspected an address. An allowlisted name whose DNS
  the caller controls — or that simply has an inward-pointing record — resolved
  to loopback, to the private network the sandbox host sits on, or to the
  link-local address cloud metadata services answer on, and the proxy connected.

  On the plain-HTTP path the brokered credential is stamped onto the outbound
  headers **before** the request goes out, so the credential-brokering design
  that is the proxy's whole reason for existing was the delivery mechanism: the
  token reached whatever the name resolved to. `BrokeredCredential.host` exists
  to stop exactly that, and it could not while its scope was a name.

  Both paths now screen the address. Refused, whatever the allowlist says:
  loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local
  (`169.254.0.0/16` — the metadata block), shared address space
  (`100.64.0.0/10`), unspecified, multicast and reserved on v4; `::1`,
  `fc00::/7`, `fe80::/10` and `ff00::/8` on v6; and a v4 address wearing a v6
  spelling in any of its forms, since a v4-only screen is a known way through
  this kind of filter.

  **This denies configurations that worked before, which is why it is major.**
  A sandbox whose allowlist names a host on a private network — a registry, an
  artifact cache, a service on the host's own LAN — starts getting `403` with a
  reason naming the address kind. That is the intended behaviour, and the remedy
  is per host:

  ```ts
  createSandboxProvider({
    backend: {
      tier: "container",
      image: "namzu/sandbox:latest",
      allowInwardFor: [".internal.example", "registry.corp"],
    },
    layout,
  });
  ```

  Matched by the allowlist's own rules, so `.internal.example` covers
  subdomains. There is deliberately no switch that turns the screen off: one
  would hand every other allowlisted name the same reach, which is the hole the
  screen exists to close. `EgressProxyOptions.allowInwardFor` is the same knob
  when constructing `EgressProxy` directly.

  One limit stated rather than implied: on the `CONNECT` path this bounds where
  the tunnel terminates and nothing more. The bytes inside it are opaque to the
  proxy, including the name the caller puts in its own TLS handshake, so a
  tunnel to an allowlisted host is not a guarantee that only allowlisted traffic
  crosses it.

## 2.0.3

### Patch Changes

- 48d9d67: Published tarballs no longer contain test files.

  `files: ["dist", "src", ...]` reads as "the build output and the sources" and
  means "everything the compiler emitted and everything in the tree", so every
  compiled test, its declaration, and both source maps shipped to the registry —
  and for the twelve packages that also ship `src`, the raw test sources went with
  them.

  Measured on the versions currently published:

  | package      | files       | of which tests | unpacked           |
  | ------------ | ----------- | -------------- | ------------------ |
  | `@namzu/sdk` | 3879 → 2239 | 1640 (42%)     | 12.73 MB → 6.81 MB |
  | `@namzu/cli` | 462 → 282   | 180 (39%)      | 1.21 MB → 0.73 MB  |

  Nothing you can import changes. Every package restricts `exports` to `"."`, so
  Node refused a deep subpath into those files already — they were weight in the
  tarball and nothing else. Hence `patch`: there is no consumer-visible surface
  here, only less to download.

  The exclusions are at the packaging layer, not the compiler. Adding `exclude`
  to `tsconfig.json` would have kept tests out of `dist` and also dropped them
  from `tsc --noEmit`, silently ending type-checking of the entire test suite —
  trading a packaging defect for a much worse one.

## 2.0.2

### Patch Changes

- ee1aa38: Remove references that pointed readers at a directory they can never open.

  Agent working memory in this repository is gitignored, and several published
  artifacts cited paths inside it. None of them resolved for anyone but the
  maintainer, and four cited session folders that no longer exist at all.

  What a consumer sees change:

  - `@namzu/sandbox` raised `Sandbox backend 'x' is not implemented yet. Track
progress in <a local notes directory>/...` — a runtime error
    instructing the reader to open a path that is not in the package, not in the
    repository, and not on the internet. It now names what does ship instead.
  - `@namzu/computer-use`'s README linked to an adapter-pattern document under a
    directory that does not exist in any checkout. It now links to the two
    published pages that actually carry the adapter contract, the capability
    protocol, and the platform command matrix.
  - `@namzu/cli`'s README linked to a session folder on the code host that
    returns 404, to explain the doctor's protocol/runtime split. The split is now
    explained in the sentence itself.
  - `@namzu/sdk` source comments cited design documents by path. They cite the
    session by name instead, which is what the reference was ever worth.

  No API, type, or behaviour change. The `@namzu/sandbox` message text is the
  only runtime string affected, and nothing asserts on it.

## 2.0.1

### Patch Changes

- 4be54ca: Three sandbox and delegation gaps, all of the same kind: something declared,
  threaded through types, and never driven.

  **`SandboxExecOptions.signal` now works — on the backend where it can.** The
  option was declared, documented and exported, with a docstring stating that
  without it "a Stop could only ever abandon the _wait_ — the sandboxed process
  kept running after the host believed the run had been cancelled". Every
  backend dropped it, so that is exactly what happened. The local sandbox now
  merges the caller's signal with the call's own deadline and hands the result to
  `spawn`, so the child actually dies; a cancelled run is no longer reported as
  `timedOut`, because a run someone stopped did not run too long, and telling the
  model otherwise invites a retry with a bigger budget.

  The remote backends still ignore it, now explicitly and with the reason in the
  source. Their wire has no cancel op, so aborting the request would abandon the
  wait while the command kept running — the original failure, wearing the
  appearance of a fix. `SandboxExecOptions.signal` documents which backends
  honour it.

  **`ls` respects the sandbox.** It read the host through `node:fs` and named
  `context.sandbox` nowhere, in the one builtin whose whole job is telling the
  model what exists — so under a container or microVM backend the model's picture
  of the filesystem was the host's. Its paths were host-relative too, while
  `read`, `grep` and `glob` all resolve inside the sandbox, so an ls-to-read
  handoff either failed or opened a different file than the one listed. `glob`
  had the identical defect, was fixed, and its fix notes that "every sibling
  builtin already remembers this branch"; this was the sibling that did not.

  One behaviour difference worth knowing: inside a sandbox, directories are
  derived from file paths, because `listFiles` reports files. An empty directory
  is invisible there.

  **The `Agent` tool's header described a design that no longer exists.** It told
  readers to prefer `Agent` because `create_task` was a non-blocking trio driven
  by notification callbacks. `create_task` blocks and returns the worker's output
  as its own result, and `continue_task` / `cancel_task` are not registered at
  all. The two tools are separated by how much of the coordinator surface they
  bring, not by timing.

## 2.0.0

### Major Changes

- 935b8f3: **Breaking:** `@namzu/sandbox` declares only the backends it has.

  Four of the shapes this package offered could type-check and then throw: a `process` tier, a `passthrough` tier, and two adapters to third-party managed schedulers, none of which was ever written. Each demanded required configuration for a call that was never made — the `self-hosted` microvm arm went further and required three fields belonging to a local-daemon path that does not exist, while the two fields the working path needs were optional. So the only configuration that ran had to supply three values nothing reads, and omitting the two that matter compiled its way to a runtime throw.

  `SandboxTier` is now `container | microvm`. `MicroVMBackendConfig` is one shape whose `orchestratorEndpoint` and `getToken` are required. `SandboxBackendNotImplementedError` stays exported and thrown: a JS host that invents a tier gets a named refusal rather than a provider that confines nothing.

  The `sandbox.platform` health check now asks the provider what this host enforces instead of answering from a table keyed on the OS name. That table had drifted both ways — it called the Linux probe unimplemented long after the provider began probing real flags, and it told a Windows operator that sandboxing is "not supported", which is true of the in-process tier and silent about the container tier that runs there. Every non-passing result now names the missing controls and what to do about them.

  `SANDBOX_ISOLATION_CONTROLS` is exported as a value from `@namzu/sdk`. It was reachable only through `export type *`, so importing it type-checked and then failed on the first line of a built binary.

### Minor Changes

- 935b8f3: The two gaps that were deferred as needing their own design session.

  **A question raised inside a tool is now durable, and the answer reaches
  the tool that asked.** `ask_user_question` parked through the raw handler
  under a synthetic `cp_question_<toolUseId>` id that was never written
  anywhere. The checkpoint did not exist: nothing on disk said a human owed
  this run an answer, the pending-checkpoint lookup could never return it,
  and a remote host could not even _observe_ the question except through the
  in-process callback. Kill the process while somebody is looking at the card
  and the answer could never be applied — the restore path stripped the whole
  assistant turn, discarding work that sibling tools in the same batch had
  already finished, and re-billed the turn.

  The park is now a real checkpoint, with `user_question_asked` /
  `user_question_answered` on the event stream, `question.asked` /
  `question.answered` on the SSE wire, and an `input-required` A2A status —
  the same surfaces a tool-review park has always had.

  The re-entry contract was the deferred half, and it turned out to reuse
  machinery that already exists. A question checkpoint is written
  mid-execution, so it holds the assistant turn with its `tool_use` blocks
  unanswered — the same shape a tool-review park leaves. Re-executing that
  batch is _how_ the asking tool gets re-entered; a carried-answer registry
  is what makes the re-entry return the recorded answer instead of parking a
  second time; and every sibling that already completed is answered from the
  transcript by the crash-resume recovery, so nothing runs twice. An answer
  that does not name a call in this turn is refused rather than delivered to
  whichever tool now holds that slot.

  **The egress policy has a boundary to be enforced at.** Two of its four
  shapes were honourable nowhere: the container backend refused a host
  allowlist outright because it had nothing to filter through, so `deny-all`
  and `allow-all` were the whole spectrum — all or nothing.

  `EgressProxy` enforces the other two. Matching has exactly two forms —
  exact host, and `.example.com` for a domain and its subdomains — and
  substring is deliberately not one of them: `host.includes(entry)` would
  admit `example.com.attacker.net`, and plain suffix matching would admit
  `notexample.com`. A policy that cannot be read denies, because an allowlist
  that fails open is not an allowlist. A request addressed to the proxy
  itself is refused rather than forwarded — found by a test that hung instead
  of failing, which is exactly the shape that failure takes in production.

  `Sandbox.setNetworkPolicy` narrows or widens a **live** sandbox, so "clone
  with a token, then drop to deny-all before running untrusted build scripts"
  is expressible; it was not, because the policy was frozen at provider
  construction. A backend that cannot enforce it throws.

  And `brokeredCredentials` settles where the token lives. Any credential the
  agent needed to reach an allowed host had to be inside the sandbox, in the
  environment, readable by the untrusted code it is meant to be isolated from
  — via `/proc/self/environ`, or via a prompt injection that exfiltrates it
  over the very egress the policy permits. The real value is now held
  host-side and applied at the boundary, scoped per host: a credential
  attached to every request is a credential handed to whichever host the
  agent was talked into contacting.

  One limit, stated rather than hidden: a credential cannot be injected into
  a CONNECT tunnel, because reading those bytes would mean terminating TLS
  with a CA the sandbox trusts — a strictly larger risk than the one being
  mitigated. A workload that needs brokering speaks plain HTTP to the proxy
  and lets it upgrade upstream. The allowlist is enforced on CONNECT either
  way, since the target names the host in clear text.

- 935b8f3: Two blast-radius controls that were accepted and silently dropped.

  **The standby-pool backend discarded every per-sandbox control.** Its create
  function took its options parameter underscore-prefixed and never read it,
  and the request body it assembled carried no resources, no environment
  variables and no network policy — while the provider faithfully assembled
  all of them first. A host that set `deny-all` and a 512 MB cap got full
  outbound network, no memory cap and no process cap, with no error and no
  warning, from the same call shape that **is** enforced on the sibling
  container backend. Switching backends silently removed the controls.

  The claim API rejects every property override except a config map, so these
  genuinely cannot ride through per sandbox — which makes refusing the honest
  fix rather than a missing feature. It now throws, naming every field it
  cannot honour rather than the first, and saying where the limits do belong
  (the container group profile the pool is built from). namzu already held
  this norm next door, with the rationale in that backend's own comment: a
  policy accepted and quietly ignored is worse than one that is refused.

  **`allow-all` and `resolver` encoded identically on the microVM backend.**
  Both resolved to an omitted allowlist, so one encoding carried two opposite
  intentions — and the `resolve()` callback that produces a tenant-scoped list
  was never invoked anywhere in the repo. Whichever way the orchestrator reads
  an omitted field, one of the two was always mis-enforced, and the one that
  failed **open** was the one whose entire purpose is restriction.

  Each variant now has its own encoding: `allow-all` omits, `deny-all` sends
  an explicitly empty list, `static` forwards its hosts, and `resolver` calls
  `resolve()` and forwards the result — including an empty result, which is a
  real deny-all and not an absence. The switch is exhaustive, so a new variant
  fails to compile rather than falling through to unrestricted, and a resolver
  that throws propagates instead of degrading to open.

  The README's backend-by-policy table was wrong in both directions and is now
  accurate. Neither backend had a test directory; both do now.

### Patch Changes

- 935b8f3: Four defects an adversarial audit confirmed

  **A task could be created and then never found again.** `DiskTaskStore` writes under the run that created it and read only under the store's default run, so every lookup missed as soon as the two differed — the normal case, since the task tools are built with the live run id while a long-lived host constructs the store once with a fixed default. `create` succeeded, `list` succeeded, and `update`, `delete`, `claim` and every dependency link answered "not found" for a task the caller could see. The in-memory store keys by task id alone, which is why nothing caught it.

  **A sub-agent's token reservation was never returned.** The debit at spawn reserves headroom so siblings cannot each be promised the same tokens, and nothing credited back the unused part — so a pool shrank by the full allocation on every spawn no matter what the child used. At a half-pool fraction, ten delegations left a parent with a thousandth of its budget and the next spawn was refused for a budget that had barely been spent. The debit also ran before provisioning, so a spawn rejected for capacity still burned its allocation — the one state change the comment there promised would not happen.

  **A failed sandbox create leaked a proxy holding real credentials.** The egress proxy starts before the container and its only close was in `destroy()`, which a create that never returned can never reach. Every failure in between left a listening server on loopback stamping credential headers, plus a retained event-loop handle, one per retry.

  **A remembered approval could overrule the operator.** The grant check ran before the verification gate and returned, so a remembered approval skipped the gate entirely — and because a tool-scoped grant matches any arguments, approving one harmless invocation authorised every other one, past a rule written to stop exactly that. The gate now runs first, and a grant can satisfy a review but never a denial.

- 935b8f3: Stop dropping tool-failure status on Bedrock, and stop accepting a sandbox
  egress policy this backend cannot enforce.

  - **Bedrock** flattened every failed tool result into an ordinary success.
    The executor computed `isError`, the SSE and A2A bridges carried it, and
    the driver dropped it — even though Converse has a first-class
    `toolResult.status`. The model's trained tool-failure recovery path keys
    off that field, so namzu was relying on prose formatting to convey "that
    call failed".

    Scope note: the five OpenAI-shaped drivers are NOT affected, because
    Chat Completions has no error field on a tool message at all. The error
    reaches those models inside the result text, which is the only channel
    the protocol has.

  - **Docker sandbox** accepted `EgressPolicy` and silently ignored it. A
    host that set `deny-all` believed the container had no network and it had
    whatever `network` was configured. A security control that is accepted
    and ignored is worse than one that does not exist. Now: `deny-all` maps
    to `--network none` (which Docker enforces natively), `allow-all` keeps
    the configured network, and `static` / `resolver` **throw** — this
    backend has no proxy to filter hosts through, and downgrading a
    restrictive policy to "allow everything" is exactly the failure worth
    refusing.

  - **Docker sandbox** containers now run with `--cap-drop=ALL` and
    `--security-opt=no-new-privileges`, plus an opt-in `runAsUser`.
    `CAP_DAC_OVERRIDE` alone walks past the read-only bind mounts the layout
    sets up, and without `no-new-privileges` a setuid binary in the image
    re-escalates.

- 935b8f3: Five places where namzu gave up, or claimed to recover, too early.

  **A transient failure now pauses instead of failing.** A 503 that survived
  every in-turn recovery — retry with jitter, the one-shot compaction relief,
  mid-stream salvage — settled the run as `failed`, identically to a bad API
  key. The host could not tell them apart, and recovering meant knowing about
  checkpoints and driving replay itself. The state was never the problem:
  checkpoints are written every iteration by default and the failed run is
  persisted with full messages. Only the settle and the signal were missing.

  A retryable failure with a checkpoint to resume from now emits `run_paused`
  naming that checkpoint, leaves the span OK rather than ERROR, and sets
  `stopReason: 'paused'`. Both conditions are required — pausing on a
  permanent error would invite a resume that cannot work, and pausing with
  nowhere to resume from produces a run nobody can ever pick up.

  **A forced compaction pass can no longer decline to do anything.** A forced
  pass runs because the provider _rejected_ the prompt as too long, and two
  things let it treat that as advisory. It re-applied the chars/4 estimate
  after clearing stale tool results — the estimate the provider had just
  refuted — and returned early if that said the context was fine. And relief
  reported success on ANY positive shed, so clearing one short result counted
  and the retry burned a whole model call to be told the same thing. The
  early return is now force-gated, and a shed has to clear a floor (a
  fraction of the prompt, at least a couple of thousand characters) to count.

  Separately, the relief latch is per **stuck point**, not per run. It exists
  to stop a second overflow immediately after a successful compaction from
  looping; as a run-scoped flag it meant one relief at iteration 3 disarmed
  the mechanism for the rest of the run, leaving iteration 40 to die with
  obvious moves left. It is now cleared by a turn that actually succeeded.

  **An eval case can no longer hang the suite.** `executeCase` was a bare
  await, so a `run` closure that never settled blocked its worker and
  `runExperiment` never returned — no report, no partial results, nothing to
  read. `ExperimentConfig.timeoutMs` bounds a case and hands `run` an
  `AbortSignal` as a third argument; a timed-out case is reported and the
  suite continues, exactly like a case that threw, with its real elapsed time
  rather than zero. Unset means no deadline, which is today's behaviour. The
  documented path already inherits deadlines from the runtime it drives; this
  covers what those cannot see — a closure that does not go through
  `query()`, and a mid-iteration provider stall.

  **A malformed content block is named, not smuggled.** One driver built an
  image block by calling `String()` on whatever `data` and `mediaType`
  happened to be, behind only a truthiness check — so a non-string `data`
  became the literal `"[object Object]"` as the base64 payload, and the wire
  rejected the whole request with nothing naming the block at fault. That is
  reachable: a remote tool result is cast without validation on the way in.
  It now type- and media-type-guards and degrades to a named placeholder,
  matching the sibling driver that already did, and without inlining the
  payload it refused to send.

  **Failures have somewhere to grow remediation.** A stale API key surfaced
  as whatever prose the vendor SDK happened to write: no id to grep in logs,
  no instruction on what to change, and no growth point — a newly-observed
  failure shape could only be given curated copy by editing the classifier.
  `explainError` adds an ordered, id-keyed rule layer matching on
  **structural** signals (code, status, an explicit hint) rather than
  volatile vendor prose. `run_failed` carries the result as `explanation`;
  `withHint(err, '…')` lets a throw site attach what only it knows, and
  outranks every generic rule. It returns `null` when no rule claims the
  failure — inventing advice for something uncharacterised is worse than
  saying nothing, because it sends the reader somewhere specific and wrong.
  The container backend's readiness, port-mapping and worker-fetch failures
  now carry hints.

- 935b8f3: Close every open code-scanning finding

  **Breaking:** `LocalExecutionContext.executeCommand` no longer interprets its arguments as shell syntax. `shell` defaulted to `true`, and spawning with a shell re-joins the command and its argument array into a single `sh -c` string — so every metacharacter inside an argument became syntax. An `args` array reads argv-safe and was not. The default is now `false`; `shell: true` remains available where a caller genuinely wants a pipeline. A consumer passing `"ls -la"` as one command string, or relying on glob expansion without asking for a shell, must now pass `shell: true`.

  **A sandbox timeout is bounded, and an out-of-range one is refused.** The bash tool's `timeout` argument is a number the model writes, with no ceiling of its own, and it reached both sandbox transports unmodified — so a single call could pin a container or a guest for as long as the platform's timer honours. Both transports now refuse a non-finite, non-positive or over-thirty-minute request rather than clamping it: running under a deadline the caller never chose, and never learns about, is the "accepted and silently not applied" failure this codebase treats as worse than not offering the control at all.

  **Seven quadratic-backtracking regexes are now linear scans**, each on a path an attacker can reach: shell output the agent captured, a tenant-supplied connector URL, a host-supplied workspace root, a model completion, and three endpoint strings that cross the same trust boundary. The worst measured over thirty seconds on a single pathological input, on a shared event loop. Three of the seven were not flagged by the scanner — the same pattern, the same boundary — and were fixed with the rest rather than left to be rediscovered.

## 1.1.0

### Minor Changes

- ff1e013: Add an additive control-plane mTLS dial to the Firecracker backend.

  `FirecrackerBackendInternalConfig` gains an optional `controlPlaneMtls`
  (`{ ca; cert; key; servername? }`, the SAME shape as the relay's `mtls`). When
  present, the orchestrator control-plane calls — `POST /sandboxes`,
  `DELETE /sandboxes/{id}:delete` — dial over a `node:https` request that presents
  the client cert and verifies the orchestrator's server cert against the injected
  CA (`rejectUnauthorized: true`, `minVersion: TLSv1.3`), INSTEAD of the plain
  global `fetch`. This secures the control plane when `orchestratorEndpoint` is an
  `https://` URL reached over the PUBLIC internet (the non-VNet-integrated
  caller→FC-host hop), where the shared-secret bearer alone would be exposed on
  the wire.

  The change is purely additive and opt-in: with no `controlPlaneMtls` injected,
  the EXISTING plain-`fetch` control-plane path runs byte-for-byte unchanged (the
  single-host live proofs + local dev). The shared-secret bearer is still sent in
  both modes — mTLS is defense in depth on top, not a replacement. `node:https` is
  used rather than a `fetch` + undici dispatcher because the package declares no
  undici dependency; `node:https` is always importable and adds nothing. The cert
  material is injected by the consumer's runtime (mirrors `getToken` and the relay
  `mtls`), so the package still reads no keys from disk and stays Azure-SDK free.

- 208d415: Add an `mtls` arm to the Firecracker agent transport for the cross-host
  client-proxy bridge.

  `SandboxAgentHandle` gains a third variant —
  `{ kind: 'mtls'; host; port; sandboxId; tls: { ca; cert; key; servername? } }` —
  alongside the existing `unix` and `vsock` arms. When the orchestrator runs on a
  different host from the caller (the owned-fleet production path), the host-local
  `v.sock` is unreachable over the network, so the dialer instead `tls.connect()`s
  to a per-FC-host mTLS relay, writes a `SANDBOX <sandboxId>\n` preamble, and then
  runs the IDENTICAL length-framed NDJSON loop. The relay terminates mTLS and
  bridges to the jailed `v.sock` (issuing the guest `CONNECT 1024` handshake
  itself), so one inbound mTLS connection maps to one fresh local `v.sock`
  connect — preserving the resume-survival property of opening a fresh connection
  per request.

  The change is purely additive: the `unix` and `vsock` arms and all framing,
  heartbeat, and reconnect-on-resume code are byte-for-byte unchanged (single-host
  deployments keep using `vsock`). The TLS material is injected by the consumer
  (never returned by the orchestrator), keeping the package free of any key
  management.

- 74a1198: Add the Firecracker microVM backend for a self-hosted orchestrator
  (`microvm:self-hosted`) and its host-side vsock transport.

  The `MicroVMBackendConfig` `self-hosted` arm gains the orchestrator seam:
  `orchestratorEndpoint` + `getToken` (the ACI `getArmToken` closure pattern, so
  the package keeps zero Azure-SDK deps) route to a new `backends/firecracker/`
  backend instead of throwing `SandboxBackendNotImplementedError`; `template`
  selects the golden snapshot revision and `agentVsockPort` /
  `readyTimeoutMs` / `readyPollIntervalMs` tune the agent dial. The legacy local
  `firecracker-containerd` shape (the three image fields alone) still throws.

  The backend is a sibling of `docker/` and `aci-standby-pool/` and a
  remote-copy backend like ACI (workspace seeded by archive-sync over the control
  channel, no host bind-mounts). It speaks the SAME NDJSON exec-stream + base64
  file-IO wire as the docker/ACI HTTP worker — only the transport differs:

  - One wire contract, factored into `backends/firecracker/protocol.ts`
    (`ExecRequest`, the `stdout_delta`/`stderr_delta`/`result`/`error` `ExecEvent`
    union, `ReadFileRequest`/`WriteFileRequest` + responses, the
    `ExecResultAccumulator` and `parseExecLine` the docker loop inlines today).
  - Two transports: HTTP for docker/ACI (UNCHANGED), and a NEW framed-over-vsock
    transport for FC (`backends/firecracker/transport.ts`), because across an FC
    snapshot resume a TCP control channel is dead-on-arrival while the vsock
    LISTEN socket survives (FC `snapshot-support.md`). Node `fetch` cannot dial
    AF_VSOCK, so the dialer, length-framing, heartbeat, and the
    reconnect-on-resume hardening (per-attempt connect/handshake timeout + retry
    budget to survive the FC #4713 `TRANSPORT_RESET`-not-delivered hang) are new.

  New public exports from `@namzu/sandbox`: `VsockAgentTransport`,
  `SandboxAgentHandle`, `VsockTransportOptions`, `FirecrackerBackendInternalConfig`,
  `OrchestratorTokenProvider`. The in-VM agent source (`agent/agent.cjs`, a vsock
  server reusing the worker spawn/jail + NDJSON shapes verbatim with the mandatory
  pre-ready entropy reseed) ships in the repo as a golden-rootfs build input,
  mirroring how `worker/server.js` is baked into the docker image — it is not a
  published runtime dependency.

### Patch Changes

- 0d1fb7b: Harden file intake and ACI readiness failure handling.

  The built-in read tool now guides Office and PDF packages through
  extractor tooling instead of treating binary document containers as
  UTF-8 text. The ACI Standby Pool backend now deletes a claimed
  container group when IP or worker readiness polling fails before a
  Sandbox handle is returned.

## 1.0.0

### Major Changes

- 8fd9349: feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

  Adds a declarative `ContainerSandboxLayout` shape that maps onto
  Anthropic's container architecture (Claude container blueprint,
  Code Interpreter, "skills"). The `Container` prefix is load-bearing
  — this layout is specific to the container tier; future microVM /
  process tiers will carry their own layout types when their adapters
  land. Layout is supplied at provider construction — not per
  `provider.create()` call — so the type system catches missing-layout
  mistakes at compile time:

  ```ts
  import {
    createSandboxProvider,
    SANDBOX_DEFAULT_OUTPUTS_PATH, // re-exported from @namzu/sdk
  } from "@namzu/sandbox";

  const provider = createSandboxProvider({
    backend: { tier: "container", image: "namzu-worker:latest" },
    layout: {
      outputs: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/<host>/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/<host>/sessions/<task>/uploads",
        },
      },
      skills: [
        {
          id: "pdf-tools",
          source: { type: "hostDir", hostPath: "/opt/skills/pdf-tools" },
        },
      ],
    },
  });
  ```

  Each mount carries a discriminated `ContainerSandboxMountSource`.
  The single variant today is `{ type: 'hostDir'; hostPath: string }`;
  future variants (squashfs skill bundles, managed volumes attached
  to a container backend) land additively as minor bumps without
  reshaping the consumer call site.

  Layout fields and their defaults:

  - `outputs` — RW. Default `/mnt/user-data/outputs`. **Required**.
  - `uploads` — RO. Default `/mnt/user-data/uploads`.
  - `toolResults` — RO. Default `/mnt/user-data/tool_results`.
  - `skills` — RO list, default `/mnt/skills/<id>` per entry.
  - `transcripts` — RO. Default `/mnt/transcripts`.

  The defaults are exported as constants from `@namzu/sdk`'s root
  barrel (`SANDBOX_DEFAULT_OUTPUTS_PATH`,
  `SANDBOX_DEFAULT_UPLOADS_PATH`, `SANDBOX_DEFAULT_TOOL_RESULTS_PATH`,
  `SANDBOX_DEFAULT_TRANSCRIPTS_PATH`, `SANDBOX_DEFAULT_SKILLS_PARENT`)
  and re-exported from `@namzu/sandbox`, so prompt-template generators
  and the backend agree on a single source of truth. Both import
  paths (`@namzu/sdk` and `@namzu/sandbox`) are pinned by tests.

  There is intentionally **no `scratchpad` field**: the
  container-internal RW area (`/home/<imageUser>`) is image-bake
  responsibility, not a runtime knob.

  **Validation** runs synchronously inside `createSandboxProvider` and
  collects every violation in one
  `ContainerSandboxLayoutValidationError.reasons[]`:

  - `outputs` must be present.
  - Skill IDs match `/^[a-zA-Z0-9_.-]+$/`, and `id.includes('..')` is
    rejected (path-traversal guard — covers `..`, `foo..bar`,
    `..foo`, `foo..`). Isolated dots (`pdf-tools.v2`) pass.
  - Skill IDs are unique.
  - Resolved `containerPath`s are unique across every mount slot.

  **Error transport.** `ContainerSandboxLayoutValidationError`
  carries a `cause` field (Error native), `toJSON()` keeps `reasons`
  (and `cause` when set), and a new helper
  `serializeSandboxError(err: unknown): SerializedSandboxError`
  returns a plain object that survives `structuredClone`,
  `postMessage`, and `JSON.stringify` round-trips uniformly. The
  helper is **cycle-safe** — a `WeakSet`-threaded recursion detects
  self-cycles (`a.cause = a`), two-node cycles (`a.cause = b;
b.cause = a`), and longer loops, replacing the offending node with
  a `{ name: 'CircularReference', message: '[circular]' }` sentinel
  rather than overflowing the stack. The helper is also
  **transport-safe** — non-Error causes (Function, Symbol, BigInt,
  NaN, ±Infinity, undefined, null, primitives, plain objects) are
  converted to a typed envelope by `serializeNonErrorCause` BEFORE
  they enter the wire shape, so values that `JSON.stringify` drops
  silently or `structuredClone` throws on never appear.
  `SerializedSandboxError.cause` is strictly typed
  `SerializedSandboxError | undefined`. Use the helper at any
  worker / IPC / log-shipper boundary; cloning the Error subclass
  itself is not supported.

  **Breaking changes** — the legacy single-mount paradigm is removed:

  - `SandboxCreateConfig.hostWorkspaceDir` is removed. Pass the host
    path on `layout.outputs.source.hostPath` at provider construction.
  - `ContainerBackendConfig.workspaceMount` is removed. Pass the
    in-container path on `layout.outputs.containerPath`.
  - `SandboxProviderConfig` is now a discriminated union: the
    container variant requires `layout: ContainerSandboxLayout`, the
    other variants do not carry the field. Constructing a docker
    provider without a layout fails at compile time.
  - `SandboxCreateConfig.layout` does NOT exist; layout is
    factory-baked. The SDK runtime cannot accidentally call a
    container provider without a layout.
  - The docker backend no longer allocates host directories
    (`mkdtemp`) or removes them on `destroy()`. Every bind source is
    consumer-owned. This also fixes an `EACCES: permission denied,
mkdir '/Users'` crash that hit sibling-container deployments.
  - The worker no longer reads `NAMZU_SANDBOX_LAYOUT` (it never
    branched on the env, only logged it; size grew with the skill
    list). Only `NAMZU_SANDBOX_WORKSPACE` is forwarded today.

  The reference Dockerfile pre-creates **only the parent directories**
  `/mnt`, `/mnt/user-data`, `/mnt/skills` — root-owned, mode 0555.
  Leaf paths (`outputs/`, `uploads/`, `tool_results/`, `transcripts/`,
  `<skill-id>/`) are intentionally NOT pre-created. When a bind is
  attached the docker daemon creates the leaf as the bind target;
  when not attached, the leaf does not exist — the model gets ENOENT
  instead of an empty writable dir that looks "mounted but uploaded
  nothing".

  `pnpm sandbox:smoke` (alias for `pnpm --filter @namzu/sandbox
test:smoke`) runs an opt-in docker integration test exercising the
  leaf-permission contract against a real docker daemon. Excluded
  from the default `pnpm test`; gated by a dedicated
  `.github/workflows/sandbox-smoke.yml` workflow that builds the
  reference image and runs the smoke test on PR / push when the
  sandbox surface changes. On CI (`process.env.CI === 'true'`), the
  smoke test fails fast if docker / the image are absent rather than
  silently skipping.

  `@namzu/sdk` exports `ContainerSandboxLayout`,
  `ContainerSandboxLayoutMount`, `ContainerSandboxMountSource`,
  `ContainerSandboxSkillMount`, `ResolvedContainerSandboxLayout`,
  and the five `SANDBOX_DEFAULT_*_PATH` constants from its root
  barrel. `@namzu/sandbox` re-exports those names plus
  `ContainerSandboxLayoutValidationError`, `serializeSandboxError`,
  and the `SerializedSandboxError` shape. The packed-tarball shape
  is verified by `.github/scripts/verify-consumer-install.sh`'s
  `@namzu/sandbox public-surface fixture`, which installs the
  package from a tarball into a clean project and asserts every
  documented constant + runtime export comes back via both
  `@namzu/sandbox` and `@namzu/sdk` import paths. `@namzu/sandbox`
  is also added to `ci.yml`'s `publint` and ATTW (Are The Types
  Wrong) gates.

### Minor Changes

- 04551a8: feat(sandbox): `container:docker` backend implementation

  P3.1 — first concrete backend lands. `createSandboxProvider({ backend: { tier: 'container', runtime: 'docker', image } })` now returns a working `SandboxProvider`:

  - Spawns one Docker container per `Sandbox` instance via the `docker` CLI (no node-docker SDK dep — keeps the package thin).
  - Container runs the small HTTP worker shipped under `packages/sandbox/worker/server.js`. The host adapter talks to it on `127.0.0.1:<random-port>`.
  - Worker exposes `/healthz` (liveness), `/execute` (NDJSON-streamed command run), `/read-file`, `/write-file`. All `Sandbox` interface methods route through these.
  - Container goes away on `Sandbox.destroy()` (`docker rm -f`).
  - Workspace bind-mount under `/tmp/namzu-sandbox-<id>-*` cleaned up on destroy.
  - Resource caps from `SandboxBackendOptions` map to Docker flags: `memoryLimitMb` → `--memory`, `maxProcesses` → `--pids-limit`. Default network is `none` (egress proxy plumbing is P3.2).

  Reference Dockerfile (`packages/sandbox/worker/Dockerfile`) ships with a comprehensive pre-installed toolchain so a greenfield namzu deployment "just works" against the typical agent workload:

  - **Office IO**: openpyxl, xlsxwriter, python-docx, python-pptx, pypdf, reportlab, pdfplumber, pymupdf, pdf2image, docx2pdf.
  - **Rendering**: weasyprint, pydyf, markdown, jinja2, beautifulsoup4, lxml, html5lib.
  - **Data**: pandas, polars, numpy, pyarrow, duckdb, sqlalchemy.
  - **Charting**: matplotlib, plotly, seaborn, kaleido.
  - **ML / stats**: scikit-learn, statsmodels, scipy.
  - **OCR / image**: pytesseract, Pillow, opencv-python-headless.
  - **OR / planning**: ortools, pulp, simpy, networkx, workalendar.
  - **HTTP**: requests, httpx, aiohttp.
  - **System tools**: LibreOffice, pandoc, Ghostscript, qpdf, poppler-utils, tesseract (eng+tur), ImageMagick, exiftool, optipng, jpegoptim, graphviz, Chromium (+ chromium-driver), ripgrep, jq, yq, tree, htop.
  - **Node toolchain**: `@mermaid-js/mermaid-cli`, xlsx, docx, pptxgenjs, pdf-lib, sharp, markdown-it, dompurify, jsdom.
  - **Fonts**: Noto (Latin + CJK + emoji + symbol), Liberation, DejaVu, FreeFont — Turkish-friendly.
  - **Distro**: Debian Bookworm slim, not Alpine — manylinux wheel coverage matters for the doc-gen path, where musl produces hard-to-debug failures.

  Hosts that want a leaner image build their own and reference it via `ContainerBackendConfig.image`. The fat default exists so the agent isn't told to use a tool that doesn't exist (the prompt-vs-runtime drift class of bugs).

  Trust model: container is the trust boundary; worker listens on loopback inside its own netns; outbound network defaults to `none` until the egress proxy lands in P3.2. Worker runs as non-root (`namzu:1001`) inside the container; host mounts `/workspace` writable to that uid.

- 663f504: feat(sandbox): new package — pluggable SandboxProvider for @namzu/sdk

  Introduces a new workspace package `@namzu/sandbox` that wraps the
  `SandboxProvider` shape `@namzu/sdk` already declares with concrete
  backends. Sandbox is intentionally split off the core SDK because:

  - Native dependencies (`bubblewrap` binary, seccomp filter generation,
    Docker SDK, parent-proxy machinery) shouldn't pollute every namzu
    consumer.
  - Anthropic itself ships their sandbox runtime as a separate package
    (`@anthropic-ai/sandbox-runtime`) for the same reason.
  - Hosts that don't need isolation (tests, trusted environments) can
    skip installing it.

  This commit is the **public-surface skeleton** — the package is
  declared, the contract is fixed, but no backend is implemented yet.
  Calling `createSandboxProvider({ backend })` throws
  `SandboxBackendNotImplementedError` for every backend tag. Backends
  arrive in subsequent commits per the
  `ses_004-native-agentic-runtime-and-sandbox` design session:

  - **P3.1** — `process` backend (Anthropic sandbox-runtime adapter).
  - **P3.2** — `EgressPolicy` plumbing with the proxy daemon.
  - **P3.3** — `container` backend (a long-lived worker container per task).

  The exported surface freezes:

  - `SandboxBackendKind = 'process' | 'container' | 'passthrough'`
  - `EgressPolicy` (deny-all / allow-all / static / resolver)
  - `SandboxBackend` and `SandboxBackendOptions`
  - `SandboxProviderConfig` and `createSandboxProvider`
  - `SandboxBackendNotImplementedError`

- 274bcfa: feat(sandbox)!: tiered backend taxonomy aligned with 2026 industrial standard

  Restructures the public surface from a flat backend-tag list into a
  four-tier taxonomy that mirrors how production agent platforms
  actually deploy code-execution sandboxes:

  - `process` — Claude Code-style host-process isolation
    (bubblewrap on Linux, Seatbelt on macOS, via Anthropic's
    `@anthropic-ai/sandbox-runtime`). For agents that run on the
    developer's own machine.
  - `container` — OCI container per task. Two runtime options:
    `docker` (default, universal local-dev fallback; what
    Northflank/Railway/Render/GitHub Actions
    runners ship) and `runsc` (Google gVisor, trusted-tenant tier;
    what OpenAI Code Interpreter and Modal Labs ship).
  - `microvm` — Firecracker microVM per task, three concrete
    services: `e2b` (managed, ~150ms cold-start via snapshot
    restore), `fly-machines` (managed, closer to bare-metal), and
    `self-hosted` (`firecracker-containerd` on KVM-enabled Linux for
    hosts that need to own the scheduler).
  - `passthrough` — no isolation; for tests and explicitly trusted
    environments.

  Each tier carries a tier-specific config shape (discriminated union
  on `tier`); picking a tier picks the shape automatically via TS
  narrowing. Industrial precedent for every choice is cited in the
  package README:

  - Adversarial multi-tenant → Firecracker microVMs (AWS Lambda /
    Fargate, Fly Machines, Replit, E2B, Daytona — Fly's
    "Sandboxing and Workload Isolation" post and the original
    Firecracker NSDI '20 paper are the canonical refs).
  - Trusted-tenant → gVisor (GKE Sandbox, Modal, OpenAI Code
    Interpreter — `gvisor.dev/docs/architecture_guide/security` is
    the reference).
  - Single-user developer machine → bubblewrap / Seatbelt
    (Anthropic Claude Code — `anthropic-experimental/sandbox-runtime`).
  - Single-tenant or co-trusted → plain Docker + seccomp default
    profile.

  We deliberately do NOT build our own Firecracker scheduler — that
  is E2B's and Fly's entire product, and writing our own would be a
  years-long detour. The `microvm` tier adapts to theirs and
  reserves `self-hosted` for compliance/air-gap deployments.

  `EgressPolicy.resolver` is now parameterless
  (`() => Promise<string[]>`). Per Codex's stop-time review, the
  prior shape took a `EgressResolveContext` with `tenantId` /
  `runId` / `agentId` fields the SDK runtime had no way to populate,
  so the resolver context was permanently unreachable. Hosts that
  need per-tenant policies bake the tenant into the closure that
  constructs the provider — the same way a server that mints
  per-tenant JWTs already knows the tenant when it issues one.

  Same reason for dropping `tenantId` / `runId` / `agentId` from
  `SandboxBackendOptions`: a contract the runtime can't fulfill is
  worse than not having it.

  **Breaking** for consumers of the still-pre-1.0 surface introduced
  in the previous skeleton commit (no implementations existed yet,
  so realistic migration cost is zero).

  Phase plan unchanged in structure but renumbered for clarity:
  P3.1 ships `container:docker` first (works locally and in any
  cloud), P3.2 the egress proxy, P3.3 the `microvm` managed adapters,
  P3.4 the `process` tier, P3.5 the adversarial-multi-tenant tier.

### Patch Changes

- 8022011: fix(sandbox): docker backend lifecycle leak + worker symlink escape

  Two issues Codex stop-time review caught on the just-shipped
  `container:docker` backend (#32):

  **HIGH — container lifecycle leak.** `spawnDockerSandbox`'s create
  path had no rollback on failure. If `docker run` succeeded but
  `/healthz` polling timed out (slow image, kernel under pressure,
  network-namespace setup hiccup), the temp workspace under `/tmp/`
  plus the running container were both orphaned. The
  `reservePort()` pattern also had a TOCTOU race: this process
  allocated a host port, closed the listening socket, then passed
  the number to `docker run --publish 127.0.0.1:PORT:…`, leaving a
  window where another process could bind the same port.

  Fixed:

  - `spawnDockerSandbox` now wraps create in `try/catch`. The catch
    arm runs `cleanupOnFailure()` which `docker rm -f`s the
    container if it started and removes `hostWorkspace` if it was
    created. Both are tracked via a flag/var captured in the outer
    scope.
  - Switched from pre-reserve-then-publish to letting Docker
    allocate via `--publish 127.0.0.1::WORKER_PORT`. The mapped
    host port is read back via `docker inspect --format
'{{(index ...).HostPort}}'`. No TOCTOU window.

  **MEDIUM — symlink escape in worker.** `resolveWithinWorkspace()`
  in the worker's `/read-file` and `/write-file` handlers checked
  the lexical path string but `fs.readFile` / `fs.writeFile`
  follow symlinks. A symlink inside `/workspace` pointing to
  `/etc/passwd` (or anywhere outside the bind-mount) bypassed the
  boundary.

  Fixed: added `realpathWithinWorkspace()` which `realpath`s both
  the workspace root and the requested target, then verifies the
  resolved real path is still inside the workspace. For writes
  where the target may not exist yet, the parent directory's
  realpath is checked instead. Both handlers now resolve through
  the new helper before touching the file.

- 63e44f7: Worker `handleExecute` no longer crashes the per-task container when a
  single request body is rejected by `resolveWithinWorkspace` (e.g. a host
  path forwarded as `cwd`) or by the workspace `mkdir`. Each fallible step
  now returns a typed `400` (or a terminal NDJSON `error` event for
  post-headers failures) and the worker stays alive for the next call —
  prior behaviour was an unhandled rejection on the `http.createServer`
  callback, which on Node ≥ 15 exits the process and gives every
  subsequent SDK call the bare `fetch failed` from `UND_ERR_SOCKET`.

  The docker backend's host-side `execViaWorker` and `writeFile` fetches
  now surface `error.cause.code` / `cause.message` instead of the
  stripped `fetch failed`. The bash builtin no longer forwards
  `context.workingDirectory` (a host-side path that has no meaning
  inside the sandbox container) as `cwd`; tools that need a sub-cwd
  inside the sandbox can be added later via an explicit
  `SandboxExecOptions` field.

  The SDK's iteration aggregator now derives
  `ChatCompletionResponse.toolCalls[i].function.arguments` from each
  bucket's parsed input rather than the raw `argsBuf` buffer. When a
  provider stream truncates with `stop_reason: "max_tokens"` mid-
  `input_json_delta`, downstream `JSON.parse` in
  `runtime/query/executor.ts:executeSingle` no longer rejects with the
  generic "Invalid JSON in tool arguments" — the tool runs against the
  empty parsed object and the input zod schema produces a readable
  "<field> is required" error instead.

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [38c4b62]
- Updated dependencies [265150b]
- Updated dependencies [a1c6694]
- Updated dependencies [52af97e]
- Updated dependencies [a71422a]
- Updated dependencies [d6b5bc1]
- Updated dependencies [8fd9349]
- Updated dependencies [63e44f7]
- Updated dependencies [63b4885]
- Updated dependencies [38c4b62]
- Updated dependencies [6b74cd0]
- Updated dependencies [d86b161]
  - @namzu/sdk@1.0.0
