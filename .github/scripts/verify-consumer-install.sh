#!/usr/bin/env bash
# Pre-publish consumer install check (ses_012-bedrock-integration-feedback;
# extended by ses_004-sdk-dependency-diet with @namzu/telemetry + the
# single-@opentelemetry/api-instance invariant).
#
# Applies any pending changesets to a snapshot-protected copy of the
# manifests, packs every publishable @namzu/* package tarball at the version
# it will actually ship at, then installs them all together into a fresh
# throwaway project. If any peer range has drifted such that the new tarballs
# cannot resolve each other cleanly, `npm install` errors with ERESOLVE and
# this script exits non-zero — gating the Changesets publish step.
#
# After the SDK + consumer install, runs runtime assertions that cannot be
# established by directory presence alone:
#   1. The packed @namzu/cli binary discovers and runs the packed @namzu/evals
#      suites exactly as their README documents.
#   2. The packed @namzu/live entry point drives a complete LiveSession →
#      NamzuModel → SDK query() turn. The fixture checks the provider request,
#      live events, returned text and terminal run-store state.
#
# @namzu/telemetry then carries two additional assertions:
#   1. require.resolve('@opentelemetry/api') computed from
#      node_modules/@namzu/sdk MUST equal the same call from
#      node_modules/@namzu/telemetry. Differing paths mean two physical
#      OTEL api modules in the tree — the split-instance trace-loss case
#      documented in design §5.1.
#   2. A span emitted through @namzu/sdk after awaiting
#      @namzu/telemetry.registerTelemetry() MUST reach the in-memory
#      exporter. This is the smoke-path hookup check.
#
# Invoked from .github/workflows/release.yml only on the merged
# "Version Packages" PR commit. For every other push to main, the
# release workflow's `changesets/action` just refreshes the Version
# Packages PR and this script is not run.
#
# Runs locally too (for a pre-PR sanity check): just invoke it from repo root.

set -euo pipefail

WORKSPACE_ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
PACK_DIR=$(mktemp -d -t namzu-pack.XXXXXX)
CONSUMER_DIR=$(mktemp -d -t namzu-consumer.XXXXXX)
VERSION_SNAPSHOT=""

restore_versions() {
  # Put back exactly the manifests and changesets that were here on entry.
  # A snapshot rather than `git checkout`, because this script is documented
  # as runnable locally and a developer's uncommitted manifest edit is not
  # this script's to discard.
  if [ -n "$VERSION_SNAPSHOT" ] && [ -d "$VERSION_SNAPSHOT" ]; then
    rm -rf "$WORKSPACE_ROOT/.changeset"
    (cd "$VERSION_SNAPSHOT" && tar cf - .) | (cd "$WORKSPACE_ROOT" && tar xf -)
  fi
}

cleanup() {
  restore_versions
  rm -rf "$PACK_DIR" "$CONSUMER_DIR" "$VERSION_SNAPSHOT"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Verify the versions that will SHIP, not the ones sitting in the tree.
# ---------------------------------------------------------------------------
#
# On the release path this script runs after Changesets has bumped every
# version, so packing the workspace packs what publishes. On a PR it does not:
# the manifests still carry the previous release's versions, and packing them
# verifies a combination that will never exist on the registry.
#
# That difference is not cosmetic — it made the gate structurally unable to
# accept a NARROWED peer range. A driver that starts calling a kernel function
# added in the release it ships with has to say `>=<that version>`, and that
# version does not exist until Changesets computes it, so the pre-bump install
# always failed with ERESOLVE. The gate was rejecting the correct range for
# being correct, and the only way to satisfy it was to keep declaring a range
# the package had already outgrown.
#
# Applying the pending changesets first is what "pre-publish" was supposed to
# mean. The manifests are restored on exit, including on failure.
#
# `-quit` rather than `| head -1`, and this is a real defect that hid behind
# a small `.changeset/`. Under `set -euo pipefail`, `head -1` closing the pipe
# after one line sends `find` SIGPIPE; the pipeline reports 141 and `set -e`
# kills the script before it does any of its work. With two or three
# changesets `find` finishes before `head` exits and nothing happens — so the
# gate passed for as long as nobody had a large batch pending, and started
# exiting silently at 141 the moment somebody did.
#
# Exactly the shape of failure this gate exists to catch, in the gate itself.
PENDING_CHANGESETS=$(find "$WORKSPACE_ROOT/.changeset" -maxdepth 1 -name '*.md' ! -name 'README.md' -print -quit 2>/dev/null)

if [ -n "$PENDING_CHANGESETS" ]; then
  echo "=== Applying pending changesets to preview the shipping versions ==="
  VERSION_SNAPSHOT=$(mktemp -d -t namzu-preversion.XXXXXX)
  (
    cd "$WORKSPACE_ROOT"
    # Snapshot files from DISK rather than the index. A package can be new and
    # therefore untracked when this local gate runs; its version must still be
    # restored after the release preview. Ignore dependency trees so their
    # nested manifests never become part of repository state.
    find packages \
      -path '*/node_modules' -prune -o \
      -type f \( -name package.json -o -name CHANGELOG.md \) -print0 \
      | tar --null -cf - -T -
  ) | (cd "$VERSION_SNAPSHOT" && tar xf -)
  # `.changeset/` is snapshotted from DISK, not from the index, and that is
  # the whole point of separating it. `git ls-files` lists tracked files, an
  # uncommitted changeset is by definition untracked, and `restore_versions`
  # below does `rm -rf .changeset` before restoring — so every changeset a
  # developer had just written was deleted by running this script. Silently,
  # by a gate `AGENTS.md` tells every contributor to run before pushing, on
  # the one file that declares what the push is supposed to release.
  #
  # The comment on `restore_versions` already states the rule this broke:
  # a developer's uncommitted edit is not this script's to discard.
  if [ -d "$WORKSPACE_ROOT/.changeset" ]; then
    (cd "$WORKSPACE_ROOT" && tar cf - .changeset) | (cd "$VERSION_SNAPSHOT" && tar xf -)
  fi

  pnpm --dir "$WORKSPACE_ROOT" exec changeset version
else
  echo "=== No pending changesets; the tree already holds the shipping versions ==="
fi

# A changelog entry belongs to the versioning step, not to the feature commit.
# Pre-writing a future version heading makes `changeset version` append the
# same release a second time. It looks harmless in the source branch and only
# becomes visible in the release snapshot, so reject duplicate semver headings
# before any package is packed.
node - "$WORKSPACE_ROOT" <<'NODE'
const { readdirSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const [, , root] = process.argv
const changelogs = []

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) visit(path)
    else if (entry.name === 'CHANGELOG.md') changelogs.push(path)
  }
}

visit(join(root, 'packages'))
let failed = false
for (const path of changelogs) {
  const headings = [...readFileSync(path, 'utf8').matchAll(/^## (\d+\.\d+\.\d+(?:[-+][^\s]+)?)\s*$/gm)].map(
    (match) => match[1],
  )
  const duplicates = [...new Set(headings.filter((heading, index) => headings.indexOf(heading) !== index))]
  if (duplicates.length === 0) continue
  console.error(`✗ ${path}: duplicate release heading(s): ${duplicates.join(', ')}`)
  failed = true
}
if (failed) process.exit(1)
console.log(`  ✓ ${changelogs.length} changelogs have unique release headings`)
NODE

PACKAGE_TABLE="$PACK_DIR/workspaces.tsv"
node - "$WORKSPACE_ROOT" "$PACKAGE_TABLE" <<'NODE'
const { execFileSync } = require('node:child_process')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const [, , root, output] = process.argv
const workspaces = JSON.parse(execFileSync(
  'pnpm',
  ['--dir', root, 'list', '--recursive', '--depth', '-1', '--json'],
  { encoding: 'utf8' },
))

const rows = workspaces
  .filter((workspace) => workspace.path !== root && workspace.name?.startsWith('@namzu/') && workspace.private !== true)
  .map((workspace) => {
    const manifest = JSON.parse(readFileSync(path.join(workspace.path, 'package.json'), 'utf8'))
    const sdkRange = manifest.peerDependencies?.['@namzu/sdk'] ?? manifest.dependencies?.['@namzu/sdk'] ?? ''
    return {
      name: manifest.name,
      packagePath: path.relative(root, workspace.path),
      version: manifest.version,
      sdkRange,
      sdkDependent: sdkRange !== '',
      sdkRelation: manifest.peerDependencies?.['@namzu/sdk'] ? 'peer' : sdkRange ? 'dependency' : '',
    }
  })
  .sort((left, right) => left.name.localeCompare(right.name))

writeFileSync(
  output,
  rows.map((row) => `${row.name}\t${row.packagePath}\t${row.sdkDependent ? '1' : '0'}`).join('\n') + '\n',
)

console.log('')
console.log('  Shipping versions:')
for (const row of rows) {
  const relation = row.sdkRange ? `${row.sdkRelation} @namzu/sdk ${row.sdkRange}` : ''
  console.log('   ', row.name.padEnd(22), row.version.padEnd(10), relation)
}
console.log('')
NODE

echo "=== Packing publishable Namzu packages ==="
while IFS=$'\t' read -r pkg_name pkg_path sdk_dependent; do
  echo "  • $pkg_name"
  pnpm --dir "$WORKSPACE_ROOT" --filter "$pkg_name" pack --pack-destination "$PACK_DIR" >/dev/null
done < "$PACKAGE_TABLE"

SDK_TARBALL=$(ls "$PACK_DIR"/namzu-sdk-*.tgz | head -1)
test -f "$SDK_TARBALL" || { echo "✗ Missing SDK tarball in $PACK_DIR"; exit 1; }
TELEMETRY_TARBALL=$(ls "$PACK_DIR"/namzu-telemetry-*.tgz | head -1)
test -f "$TELEMETRY_TARBALL" || { echo "✗ Missing telemetry tarball in $PACK_DIR"; exit 1; }
PACKED_COUNT=$(find "$PACK_DIR" -maxdepth 1 -name '*.tgz' | wc -l | tr -d ' ')
echo "  ✓ Packed $PACKED_COUNT tarballs → $PACK_DIR"

echo ""
# The tarballs of the workspace packages a package's `dependencies` name,
# from the pack directory. A dependent that itself depends on other
# workspace packages (the CLI on the providers and leaves it ships with)
# must get THOSE from the pack directory too: the gate runs before anything
# is published, so a train that bumps the CLI and one sibling together
# would otherwise ask the registry for a version that does not exist yet
# and fail with ETARGET — a false verdict about a release that is fine.
# Peers are deliberately not included: the peer range against the shipping
# SDK is what a pairing tests.
sibling_tarballs() {
  node -e '
    const { readFileSync } = require("node:fs")
    const { join } = require("node:path")
    const manifest = JSON.parse(readFileSync(join(process.argv[1], process.argv[2], "package.json"), "utf8"))
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (!dep.startsWith("@namzu/") || dep === "@namzu/sdk") continue
      console.log(dep.slice("@namzu/".length))
    }
  ' "$WORKSPACE_ROOT" "$1" | while read -r sibling; do ls "$PACK_DIR"/namzu-"${sibling}"-*.tgz 2>/dev/null | head -1; done
}

echo "=== Consumer install dry-run (SDK + each dependent) ==="
cd "$CONSUMER_DIR"
npm init -y >/dev/null

# Discover dependents from the shipping manifests rather than maintaining a
# second package list. That makes a newly added leaf package part of this gate
# on its first local run, before it has even been staged.
DEPENDENT_COUNT=0
while IFS=$'\t' read -r pkg_name pkg_path sdk_dependent; do
  if [ "$sdk_dependent" != "1" ] || [ "$pkg_name" = "@namzu/sdk" ]; then
    continue
  fi

  dep=${pkg_name#@namzu/}
  echo ""
  echo "  → $pkg_name + @namzu/sdk"
  TARBALL=$(ls "$PACK_DIR"/namzu-${dep}-*.tgz | head -1)
  test -f "$TARBALL" || { echo "    ✗ Missing tarball for $dep"; exit 1; }

  SIBLING_TARBALLS=$(sibling_tarballs "$pkg_path")

  rm -rf node_modules package-lock.json
  # shellcheck disable=SC2086
  npm install --no-fund --no-audit --no-save --silent "$SDK_TARBALL" "$TARBALL" $SIBLING_TARBALLS

  test -d "node_modules/$pkg_name" || { echo "    ✗ $pkg_name did not install"; exit 1; }
  test -d "node_modules/@namzu/sdk" || { echo "    ✗ @namzu/sdk did not install"; exit 1; }
  echo "    ✓ resolved"
  DEPENDENT_COUNT=$((DEPENDENT_COUNT + 1))
done < "$PACKAGE_TABLE"

SAVED_DEPENDENT_COUNT=$(node -p "Object.keys(require('./package.json').dependencies ?? {}).length")
test "$SAVED_DEPENDENT_COUNT" -eq 0 || {
  echo "✗ Consumer pair installs polluted package.json with $SAVED_DEPENDENT_COUNT saved dependencies"
  exit 1
}

echo ""
echo "✅ Consumer install verified for all $DEPENDENT_COUNT SDK-dependent packages"

# ---------------------------------------------------------------------------
# @namzu/evals documented consumer fixture.
# ---------------------------------------------------------------------------
#
# The suite package deliberately contains data and executable suite modules,
# not a CLI. Its README composes it with @namzu/cli, so verify that exact
# packed-package installation instead of accepting two independently
# installable directories as proof that the documented command works.

echo ""
echo "=== @namzu/cli + @namzu/evals documented command fixture ==="

CLI_TARBALL=$(find "$PACK_DIR" -maxdepth 1 -name 'namzu-cli-*.tgz' -print -quit)
test -f "$CLI_TARBALL" || { echo "    ✗ Missing CLI tarball in $PACK_DIR"; exit 1; }
EVALS_TARBALL=$(find "$PACK_DIR" -maxdepth 1 -name 'namzu-evals-*.tgz' -print -quit)
test -f "$EVALS_TARBALL" || { echo "    ✗ Missing evals tarball in $PACK_DIR"; exit 1; }

rm -rf node_modules package-lock.json eval-report.json
CLI_PATH=$(awk -F'\t' '$1 == "@namzu/cli" { print $2 }' "$PACKAGE_TABLE")
CLI_SIBLINGS=$(sibling_tarballs "$CLI_PATH")
# shellcheck disable=SC2086
npm install --no-fund --no-audit --no-save --silent "$SDK_TARBALL" "$CLI_TARBALL" "$EVALS_TARBALL" $CLI_SIBLINGS

test -x node_modules/.bin/namzu || { echo "    ✗ Packed CLI did not install an executable namzu binary"; exit 1; }
test -d node_modules/@namzu/evals || { echo "    ✗ Packed eval suites did not install"; exit 1; }

./node_modules/.bin/namzu eval --dir node_modules/@namzu/evals --out eval-report.json
node - <<'NODE'
const { readFileSync } = require('node:fs')

const report = JSON.parse(readFileSync('eval-report.json', 'utf8'))
if (!Array.isArray(report.suites) || report.suites.length === 0) {
  throw new Error('Packed eval command produced no suite reports')
}
if (!report.suites.every((entry) => Array.isArray(entry.report?.cases))) {
  throw new Error('Packed eval command produced an invalid report shape')
}
console.log(`    ✓ packed CLI ran ${report.suites.length} packed eval suites`)
NODE

# ---------------------------------------------------------------------------
# @namzu/live packed-runtime fixture (ses_022-live-agent-bridge).
# ---------------------------------------------------------------------------
#
# Installing a directory proves only that the peer graph resolved. Import the
# exact tarballs that will ship and drive the whole public bridge so a missing
# export, stale dist file, broken peer resolution or disconnected SDK model
# cannot pass this release gate as "installed".

echo ""
echo "=== @namzu/live packed runtime → SDK query fixture ==="

LIVE_TARBALL=$(ls "$PACK_DIR"/namzu-live-*.tgz | head -1)
test -f "$LIVE_TARBALL" || { echo "    ✗ Missing live tarball in $PACK_DIR"; exit 1; }

# A previous adapter was deleted from src/ while its compiled module remained
# in dist/. Incremental compilation quite correctly ignored an output it no
# longer owned, but `files: ["dist"]` packed it anyway. Require every shipped
# live runtime module to have a source owner so reused release workspaces
# produce the same artifact as clean ones.
LIVE_RUNTIME_FILES=0
LIVE_ORPHANS=0
while IFS= read -r entry; do
  case "$entry" in
    package/dist/*.js)
      relative=${entry#package/dist/}
      source="$WORKSPACE_ROOT/packages/live/src/${relative%.js}.ts"
      LIVE_RUNTIME_FILES=$((LIVE_RUNTIME_FILES + 1))
      if [ ! -f "$source" ]; then
        echo "    ✗ Packed live runtime module has no source owner: $entry"
        LIVE_ORPHANS=$((LIVE_ORPHANS + 1))
      fi
      ;;
  esac
done < <(tar -tzf "$LIVE_TARBALL")
test "$LIVE_RUNTIME_FILES" -gt 0 || { echo "    ✗ Live tarball contains no runtime modules"; exit 1; }
test "$LIVE_ORPHANS" -eq 0 || exit 1
echo "    ✓ $LIVE_RUNTIME_FILES packed runtime modules have source owners"

rm -rf node_modules package-lock.json
npm install --no-fund --no-audit --no-save --silent "$SDK_TARBALL" "$LIVE_TARBALL"

cat > assert-live-runtime.mjs <<'EOF'
import { LiveAgent, LiveSession, NamzuModel } from '@namzu/live'
import { InMemoryRunStore, MockLLMProvider, ToolRegistry } from '@namzu/sdk'

const expectedText = 'PACKED_LIVE_BRIDGE_OK'
const instructions = 'PACKED_LIVE_INSTRUCTIONS'
const userInput = 'Exercise the packed live bridge.'
const provider = new MockLLMProvider({ responseText: expectedText })
const runStore = new InMemoryRunStore()
const events = []
const session = new LiveSession()
session.onEvent((event) => events.push(event))

await session.start(
  new LiveAgent({
    instructions,
    model: new NamzuModel({
      createQueryParams: () => ({
        agentId: 'agent_packed_live',
        agentName: 'Packed live agent',
        projectId: 'project_packed_live',
        provider,
        resumeHandler: async () => ({ action: 'continue' }),
        runConfig: {
          maxIterations: 4,
          maxResponseTokens: 512,
          model: 'packed-fixture-model',
          timeoutMs: 30_000,
          tokenBudget: 100_000,
        },
        runStore,
        sessionId: 'session_packed_live',
        tenantId: 'tenant_packed_live',
        tools: new ToolRegistry(),
        topicId: 'topic_packed_live',
        workingDirectory: process.cwd(),
      }),
    }),
  }),
)

const result = await session.run({ userInput }).wait()
await session.close()

const failures = []
if (result.status !== 'completed') {
  failures.push(`turn status = ${JSON.stringify(result.status)}, expected "completed"`)
}
if (result.message?.content !== expectedText) {
  failures.push(`assistant text = ${JSON.stringify(result.message?.content)}, expected ${JSON.stringify(expectedText)}`)
}
if (!result.runId) {
  failures.push('completed turn omitted its SDK run id')
}

if (provider.requests.length !== 1) {
  failures.push(`provider request count = ${provider.requests.length}, expected 1`)
} else {
  const messages = provider.requests[0].messages
  const sawInstructions = messages.some(
    (message) => message.role === 'system' && JSON.stringify(message.content).includes(instructions),
  )
  const sawUserInput = messages.some(
    (message) => message.role === 'user' && JSON.stringify(message.content).includes(userInput),
  )
  if (!sawInstructions) failures.push('SDK provider request omitted the live agent instructions')
  if (!sawUserInput) failures.push('SDK provider request omitted the live user turn')
}

for (const requiredType of ['turn_started', 'assistant_text_delta', 'turn_completed']) {
  if (!events.some((event) => event.type === requiredType)) {
    failures.push(`live event stream omitted ${requiredType}`)
  }
}

if (runStore.snapshot().meta.status !== 'completed') {
  failures.push(`SDK run-store status = ${JSON.stringify(runStore.snapshot().meta.status)}, expected "completed"`)
}

if (failures.length > 0) {
  console.error('✗ @namzu/live packed-runtime check failed:')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log('✅ packed @namzu/live completed one SDK-backed turn with public exports, events and run-store state intact')
EOF

echo "    → packed live + shipping SDK"
node assert-live-runtime.mjs

# The peer range promises the first SDK version in the supported major too,
# not only the workspace head. Exercise that exact lower bound with the same
# packed live artifact so the declaration and runtime cannot drift apart.
LIVE_SDK_RANGE=$(node -p "require('$WORKSPACE_ROOT/packages/live/package.json').peerDependencies['@namzu/sdk']")
LIVE_MINIMUM_SDK=${LIVE_SDK_RANGE#>=}
LIVE_MINIMUM_SDK=${LIVE_MINIMUM_SDK%% *}
case "$LIVE_MINIMUM_SDK" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "    ✗ Could not derive live's minimum SDK from peer range: $LIVE_SDK_RANGE"; exit 1 ;;
esac
echo "    → packed live + minimum supported SDK $LIVE_MINIMUM_SDK"
SHIPPING_SDK_VERSION=$(node -p "require('$WORKSPACE_ROOT/packages/sdk/package.json').version")
if [ "$LIVE_MINIMUM_SDK" = "$SHIPPING_SDK_VERSION" ]; then
  # A package cannot be downloaded from the registry before this release has
  # published it. The shipping-tarball fixture immediately above already ran
  # this exact lower bound, so requiring the registry copy here creates a
  # bootstrap deadlock: the pre-publish gate waits for the publish it gates.
  echo "    ✓ minimum is the shipping SDK; packed fixture above covers it"
else
  rm -rf node_modules package-lock.json
  npm install --no-fund --no-audit --no-save --silent "$LIVE_TARBALL" "@namzu/sdk@$LIVE_MINIMUM_SDK"
  INSTALLED_LIVE_MINIMUM_SDK=$(node -p "require('./node_modules/@namzu/sdk/package.json').version")
  test "$INSTALLED_LIVE_MINIMUM_SDK" = "$LIVE_MINIMUM_SDK" || {
    echo "    ✗ Expected minimum SDK $LIVE_MINIMUM_SDK, installed $INSTALLED_LIVE_MINIMUM_SDK"
    exit 1
  }
  node assert-live-runtime.mjs
fi

# ---------------------------------------------------------------------------
# @namzu/sandbox public-surface fixture (ses_005-sandbox-multi-mount-layout).
# ---------------------------------------------------------------------------
#
# Vandal Cowork imports `SANDBOX_DEFAULT_OUTPUTS_PATH` and the
# `ContainerSandboxLayout` type by name from `@namzu/sandbox` (and via the
# SDK root barrel). The package.json `exports` map only exposes `"."`;
# subpath imports like `@namzu/sandbox/dist/index.js` would bypass the
# guarded surface and `@namzu/sdk/constants/sandbox` would fail outright.
# This assertion verifies the packed tarball's shape matches the workspace
# build by importing the public path from a clean install and checking
# every constant comes back with the documented value.

echo ""
echo "=== @namzu/sandbox public-surface fixture ==="

SANDBOX_TARBALL=$(ls "$PACK_DIR"/namzu-sandbox-*.tgz | head -1)
test -f "$SANDBOX_TARBALL" || { echo "    ✗ Missing sandbox tarball in $PACK_DIR"; exit 1; }

rm -rf node_modules package-lock.json
npm install --no-fund --no-audit --no-save --silent "$SDK_TARBALL" "$SANDBOX_TARBALL"

cat > assert-sandbox-public-surface.mjs <<'EOF'
import * as sandbox from '@namzu/sandbox'
import * as sdk from '@namzu/sdk'

const expected = {
  SANDBOX_DEFAULT_OUTPUTS_PATH: '/mnt/user-data/outputs',
  SANDBOX_DEFAULT_UPLOADS_PATH: '/mnt/user-data/uploads',
  SANDBOX_DEFAULT_TOOL_RESULTS_PATH: '/mnt/user-data/tool_results',
  SANDBOX_DEFAULT_TRANSCRIPTS_PATH: '/mnt/transcripts',
  SANDBOX_DEFAULT_SKILLS_PARENT: '/mnt/skills',
}

const failures = []
for (const [name, value] of Object.entries(expected)) {
  if (sandbox[name] !== value) {
    failures.push(`@namzu/sandbox.${name} = ${JSON.stringify(sandbox[name])}, expected ${JSON.stringify(value)}`)
  }
  if (sdk[name] !== value) {
    failures.push(`@namzu/sdk.${name} = ${JSON.stringify(sdk[name])}, expected ${JSON.stringify(value)}`)
  }
}

// Runtime classes / functions exported from @namzu/sandbox.
const expectedRuntime = ['createSandboxProvider', 'ContainerSandboxLayoutValidationError', 'serializeSandboxError', 'SandboxBackendNotImplementedError']
for (const name of expectedRuntime) {
  if (sandbox[name] === undefined) {
    failures.push(`@namzu/sandbox.${name} is undefined`)
  }
}

// `serializeSandboxError` smoke: a layout-validation error survives JSON
// round-trip with reasons preserved. Catches a shape regression in the
// packed tarball that the workspace tests would not see.
const err = new sandbox.ContainerSandboxLayoutValidationError(['x', 'y'])
const wire = JSON.parse(JSON.stringify(sandbox.serializeSandboxError(err)))
if (wire.name !== 'ContainerSandboxLayoutValidationError') {
  failures.push(`serialized name = ${wire.name}, expected ContainerSandboxLayoutValidationError`)
}
if (!Array.isArray(wire.reasons) || wire.reasons.length !== 2) {
  failures.push(`serialized reasons = ${JSON.stringify(wire.reasons)}, expected 2-item array`)
}

if (failures.length > 0) {
  console.error('✗ @namzu/sandbox public-surface check failed:')
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}

console.log('✅ @namzu/sandbox public surface intact: 5 constants + ' + expectedRuntime.length + ' runtime exports + serializeSandboxError JSON round-trip')
EOF

node assert-sandbox-public-surface.mjs

# ---------------------------------------------------------------------------
# @namzu/telemetry two-assertion fixture (ses_004-sdk-dependency-diet §5.1).
# ---------------------------------------------------------------------------
#
# Install SDK + telemetry + their peers (@opentelemetry/api, zod,
# zod-to-json-schema) in a single install step so peer-dep resolution is
# forced to settle on the consumer's root — not inside nested package
# trees. Then run two Node assertions inside the installed project.

echo ""
echo "=== @namzu/telemetry single-api-instance + span-smoke fixture ==="

# The telemetry peer range ">=0.4.0 <1.0.0" (packages/telemetry/package.json)
# will not resolve against a pre-bump SDK version. In CI this script fires
# only on the merged "Version Packages" PR commit, by which time Changesets
# has already bumped SDK to its release target. For local dev runs against
# the workspace state pre-bump, skip the fixture with a clear message —
# it will exercise in CI.
SDK_VERSION=$(node -p "require('$WORKSPACE_ROOT/packages/sdk/package.json').version")
SDK_MAJOR_MINOR="${SDK_VERSION%.*}"
case "$SDK_MAJOR_MINOR" in
  0.0|0.1|0.2|0.3)
    echo "  ⊘ SKIP: SDK version $SDK_VERSION is below telemetry peer range >=0.4.0."
    echo "    This fixture runs in CI after the Version Packages commit bumps SDK."
    exit 0
    ;;
esac

rm -rf node_modules package-lock.json
npm install --no-fund --no-audit --no-save --silent \
  "$SDK_TARBALL" \
  "$TELEMETRY_TARBALL" \
  @opentelemetry/api@^1.9.0 \
  @opentelemetry/sdk-trace-base@^1.30.0 \
  @opentelemetry/sdk-trace-node@^1.30.0 \
  zod@^3.23.0 \
  zod-to-json-schema@^3.23.0

test -d "node_modules/@namzu/sdk" || { echo "    ✗ @namzu/sdk did not install"; exit 1; }
test -d "node_modules/@namzu/telemetry" || { echo "    ✗ @namzu/telemetry did not install"; exit 1; }

# Assertion 1: single @opentelemetry/api module in the install tree.
# Using `require.resolve` with two distinct `paths` bases forces Node to
# compute the resolution path from each entrypoint's perspective; the
# result must be identical or the install has a split-instance problem.
cat > assert-api-identity.mjs <<'EOF'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const sdkDir = path.join(here, 'node_modules', '@namzu', 'sdk')
const telDir = path.join(here, 'node_modules', '@namzu', 'telemetry')

const fromSdk = require.resolve('@opentelemetry/api', { paths: [sdkDir] })
const fromTel = require.resolve('@opentelemetry/api', { paths: [telDir] })

if (fromSdk !== fromTel) {
  console.error('✗ @opentelemetry/api module-identity check failed:')
  console.error('  from @namzu/sdk:       ' + fromSdk)
  console.error('  from @namzu/telemetry: ' + fromTel)
  console.error('  Two physical api modules = split trace graph. See design §5.1.')
  process.exit(1)
}
console.log('✅ single @opentelemetry/api instance at ' + fromSdk)
EOF

node assert-api-identity.mjs

# Assertion 2: end-to-end span emission through SDK reaches the in-memory
# exporter after awaiting registerTelemetry(). Uses a custom TelemetryProvider
# subclass pattern? No — simpler: use `none` exporter type from telemetry,
# but install a BatchSpanProcessor backed by InMemorySpanExporter directly
# on the global TracerProvider via @opentelemetry/api.
#
# This check would require registerTelemetry to accept a custom exporter or
# to use a lower-level registration hook. Rather than bolting one onto
# @namzu/telemetry just for the fixture, we assert the narrower property
# that registerTelemetry({ exporterType: 'none' }) completes without
# throwing and installs a non-no-op tracer provider that is reachable from
# the SDK side.

cat > assert-span-smoke.mjs <<'EOF'
// Exercises the SDK tracer path ('namzu' namespace — same string used
// internally by @namzu/sdk's runtime-accessors.ts) and asserts an
// InMemorySpanExporter captures the span. This proves (a)
// registerTelemetry mutates @opentelemetry/api's globals to a real
// TracerProvider, (b) the SDK-side code path would produce valid spans
// post-registration, (c) the full export pipeline wires up.
import { registerTelemetry } from '@namzu/telemetry'
import { trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base'

// The fixture uses exporterType: 'none' on purpose: 'none' still
// installs a real TracerProvider and only suppresses the exporter, so
// our own InMemorySpanExporter captures spans emitted through the
// @opentelemetry/api globals without writing to the console or needing
// an OTLP endpoint.
//
// The processor is handed over at construction. The tracing SDK used to
// allow attaching one to an already-registered provider and no longer
// does, so `spanProcessors` is the only way in — which is also why the
// telemetry package accepts it.
const inMemory = new InMemorySpanExporter()
const telemetry = await registerTelemetry({
  serviceName: 'verify-consumer-install',
  exporterType: 'none',
  spanProcessors: [new SimpleSpanProcessor(inMemory)],
})

const tracerProvider = telemetry['tracerProvider']

// This is THE SDK path: @namzu/sdk's internal getTracer() calls
// trace.getTracer('namzu'). If it produces a valid span, the SDK's
// own spans will too.
const tracer = trace.getTracer('namzu')
const span = tracer.startSpan('verify.sdk.span')
span.setAttribute('test', true)
span.end()

// SimpleSpanProcessor.onEnd fires `void doExport(...)` — fire-and-forget.
// forceFlush drains pending exports before we read the buffer.
await tracerProvider.forceFlush()

const collected = inMemory.getFinishedSpans()

// shutdown() AFTER the read: InMemorySpanExporter.shutdown() sets
// _finishedSpans = []. Reading after shutdown would always return empty.
await telemetry.shutdown()

if (collected.length === 0) {
  console.error('✗ span-smoke: InMemorySpanExporter captured zero spans')
  console.error('  registerTelemetry must install a real TracerProvider that forwards to attached processors.')
  process.exit(1)
}

const captured = collected[0]
const zeroSpanId = '0000000000000000'
const zeroTraceId = '00000000000000000000000000000000'
if (captured.spanContext().spanId === zeroSpanId) {
  console.error('✗ span-smoke: captured span has zero spanId — tracer provider is no-op')
  process.exit(1)
}
if (captured.spanContext().traceId === zeroTraceId) {
  console.error('✗ span-smoke: captured span has zero traceId — tracer provider is no-op')
  process.exit(1)
}
if (captured.name !== 'verify.sdk.span') {
  console.error('✗ span-smoke: unexpected span name captured: ' + captured.name)
  process.exit(1)
}

console.log('✅ span-smoke: InMemorySpanExporter captured 1 span with name "' + captured.name + '" via trace.getTracer("namzu")')
EOF

node assert-span-smoke.mjs

echo ""
echo "✅ @namzu/telemetry fixture: single-api-instance + span-smoke both green"
