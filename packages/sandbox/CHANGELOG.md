# @namzu/sandbox

## 1.0.0

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

- Updated dependencies [542f057]
- Updated dependencies [df09910]
- Updated dependencies [140bcc0]
- Updated dependencies [ea21863]
- Updated dependencies [265150b]
- Updated dependencies [a71422a]
  - @namzu/sdk@1.0.0
