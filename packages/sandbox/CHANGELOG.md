# @namzu/sandbox

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
          hostPath: "/var/lib/vandal/sessions/<task>/outputs",
        },
      },
      uploads: {
        source: {
          type: "hostDir",
          hostPath: "/var/lib/vandal/sessions/<task>/uploads",
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
mkdir '/Users'` crash that hit sibling-container deployments
    (Vandal Cowork).
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
  - **Distro**: Debian Bookworm slim, not Alpine — manylinux wheel coverage matters for the doc-gen path; compass-platform hit musl issues on the same workload.

  Hosts that want a leaner image build their own and reference it via `ContainerBackendConfig.image`. The fat default exists so the agent isn't told to use a tool that doesn't exist (the prompt-vs-runtime drift class of bugs Codex flagged repeatedly in the Vandal Cowork iterations).

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
  - **P3.3** — `container` backend (compass-platform pattern).

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
    Northflank/Railway/Render/Compass-platform/GitHub Actions
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
  constructs the provider — exactly how compass-platform's
  JWT-minting flow already works.

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
