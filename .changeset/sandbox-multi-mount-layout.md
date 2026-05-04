---
'@namzu/sandbox': major
'@namzu/sdk': major
---

feat(sandbox)!: Anthropic-style multi-mount container sandbox layout

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
  SANDBOX_DEFAULT_OUTPUTS_PATH,  // re-exported from @namzu/sdk
} from '@namzu/sandbox'

const provider = createSandboxProvider({
  backend: { tier: 'container', image: 'namzu-worker:latest' },
  layout: {
    outputs: { source: { type: 'hostDir', hostPath: '/var/lib/vandal/sessions/<task>/outputs' } },
    uploads: { source: { type: 'hostDir', hostPath: '/var/lib/vandal/sessions/<task>/uploads' } },
    skills: [
      { id: 'pdf-tools', source: { type: 'hostDir', hostPath: '/opt/skills/pdf-tools' } },
    ],
  },
})
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
