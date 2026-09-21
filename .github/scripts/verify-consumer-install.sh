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
#      live events, returned text and the terminal record of the SDK session log.
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
# Runs locally too (for a pre-PR sanity check): invoke it from repo root.
#
# VERIFIED on Linux, which is what the gate itself runs on: every fixture below
# has been executed there. macOS is expected to work and is not verified here.
#
# Git Bash is where #415 was filed and is repaired on the reasoning of the
# failure, not by a run: no Windows host was used. `node_path` converts the one
# path this script hands a native Node, and the three manifest reads are passed
# as argv rather than spliced into a JavaScript string, so the two things a
# `/c/Users/...` path broke are addressed. What no run here has reached under
# MSYS, and what a Windows contributor is therefore still the first to exercise:
# `test -x node_modules/.bin/namzu` and the `./node_modules/.bin/namzu` it runs
# (the eval fixture), the three `tar` round trips — the `-T -` snapshot that
# `find -print0` feeds, the `.changeset` snapshot, and the untar in
# `restore_versions` — the fourth `tar` call, the `-tzf` listing that reads the
# live tarball's contents, the `sed` that indents npm's output and the `awk`
# that reads the package table, and `mktemp -d -t` (the three temp roots).
#
# When it refuses, it says why. Every `npm install` goes through `run_install`,
# which keeps the install's output and prints it under the package that failed,
# and an ERR trap names the step, the line and the command for anything else
# that aborts the script. `--silent` was removed from those installs for
# exactly this reason: it suppressed the resolution error this gate exists to
# report, leaving CI with a bare exit code (#415).

set -Eeuo pipefail

WORKSPACE_ROOT="${GITHUB_WORKSPACE:-$(pwd)}"
PACK_DIR=$(mktemp -d -t namzu-pack.XXXXXX)
CONSUMER_DIR=$(mktemp -d -t namzu-consumer.XXXXXX)
VERSION_SNAPSHOT=""

# A shell path is not always a path Node can open.
#
# Under Git Bash / MSYS2 / Cygwin the shell sees `/c/Users/you/...`, and Node
# is a native Windows binary that has never heard of it:
# `require('/c/Users/you/.../package.json')` dies with "Cannot find module".
# That is issue #415 — a Windows contributor got through every consumer
# install and the sandbox fixture, then fell over in the telemetry fixture on
# the way this script asked Node for a version. The gate most likely to fail
# for reasons unrelated to a change was also the one they could not run before
# pushing.
#
# `cygpath -m` maps the shell path onto the mixed `C:/Users/you/...` form Node
# accepts. Off Windows there is no cygpath and this is the identity, so what
# the gate verifies on Linux does not move.
#
# Under MSYS WITHOUT cygpath there is no conversion available, and returning
# the path unchanged would hand `/c/Users/...` to Node after a header comment
# promising Git Bash support — the original `Cannot find module` would come
# back with nothing saying why. So that case says why and returns 1 with
# NOTHING on stdout instead of guessing. The caller is a `node -p` that reads
# the path from `$( )`: it is handed an empty argv and stops with Node's own
# `ERR_INVALID_ARG_VALUE` (`The argument 'id' must be a non-empty string`), so
# the run ends at that line rather than continuing with a path that was never
# converted — with this function's three lines saying what was missing above
# it. `cygpath` ships with MSYS2's base package; a Git Bash without it is a Git
# Bash that cannot run this script.
node_path() {
  case "$(uname -s 2>/dev/null || true)" in
    MINGW* | MSYS* | CYGWIN*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -m "$1"
        return 0
      fi
      echo "✗ $1 cannot be converted: this is an MSYS shell with no 'cygpath' on PATH." >&2
      echo "  A native Node cannot open a /c/Users/... path. Install MSYS2's base" >&2
      echo "  package (cygpath) or run this gate on Linux or macOS." >&2
      return 1
      ;;
  esac
  printf '%s\n' "$1"
}

restore_versions() {
  # Put back exactly the manifests and changesets that were here on entry.
  # A snapshot rather than `git checkout`, because this script is documented
  # as runnable locally and a developer's uncommitted manifest edit is not
  # this script's to discard.
  if [ -n "$VERSION_SNAPSHOT" ] && [ -d "$VERSION_SNAPSHOT" ]; then
    # First releases create a changelog where none existed on entry. Untarring
    # cannot restore absence, so remove only those preview-created files next
    # to snapshotted manifests. Existing uncommitted changelogs are restored.
    if [ -d "$VERSION_SNAPSHOT/packages" ]; then
      while IFS= read -r -d '' manifest; do
        relative=${manifest#"$VERSION_SNAPSHOT"/}
        relative=${relative%package.json}CHANGELOG.md
        if [ ! -e "$VERSION_SNAPSHOT/$relative" ]; then
          rm -f -- "$WORKSPACE_ROOT/$relative"
        fi
      done < <(find "$VERSION_SNAPSHOT/packages" -type f -name package.json -print0)
    fi
    rm -rf "$WORKSPACE_ROOT/.changeset"
    (cd "$VERSION_SNAPSHOT" && tar cf - .) | (cd "$WORKSPACE_ROOT" && tar xf -)
  fi
}

# 0 when `$1` is one of the scratch directories this script created with
# `mktemp -d -t`: an absolute path, directly under the temporary root `mktemp`
# used, whose final component carries one of this script's three templates.
#
# The point is that the test is the PATTERN mktemp produced, not the value of
# the variable holding it, so that a variable set to something else cannot turn
# into a removal of something else.
is_our_temp_dir() {
  local path="$1" root="${TMPDIR:-/tmp}" base parent
  [ -n "$path" ] || return 1
  case "$path" in /*) ;; *) return 1 ;; esac

  # `TMPDIR=/tmp/` and a path under it must still compare: strip the trailing
  # slashes off both sides before comparing.
  while [ "$root" != "/" ] && [ "${root%/}" != "$root" ]; do root="${root%/}"; done
  base="${path##*/}"
  parent="${path%/*}"
  [ -n "$parent" ] || parent="/"
  while [ "$parent" != "/" ] && [ "${parent%/}" != "$parent" ]; do parent="${parent%/}"; done
  [ "$parent" = "$root" ] || return 1

  case "$base" in
    namzu-pack.* | namzu-consumer.* | namzu-preversion.*) return 0 ;;
  esac
  return 1
}

# Remove one scratch directory — the only kind of removal this function is
# allowed to perform.
#
# `cleanup` is a function a reader can source on its own and hand any value to,
# and one did: `PACK_DIR=/tmp` and `CONSUMER_DIR=/tmp`, followed by the
# `rm -rf` that used to be in the caller. That deleted other people's scratch —
# some 2180 unrelated entries, other sessions' task output among them — until a
# timeout stopped it. The script had created its directories with
# `mktemp -d -t namzu-pack.XXXXXX` and was not at fault; the shape is still one
# a reader can repeat, and what it costs is not theirs to lose.
#
# So the path is checked against the pattern mktemp produced, and anything else
# is reported and SKIPPED. Nothing here exits and nothing here fails: this runs
# from an EXIT trap, after whatever already ended the run, and under `set -e` a
# failing command here would replace that run's exit status with this one.
remove_temp_dir() {
  # `${2:-}`, not `$2`: a reader who sources this file and calls it with the
  # variable's name alone aborts the EXIT trap with `$2: unbound variable`,
  # which skips every removal after it and replaces the status of the run that
  # had already ended — the same shape, one argument wide, as the incident this
  # function exists for.
  local path="${2:-}"
  if [ -z "$path" ]; then
    # `VERSION_SNAPSHOT` is empty until the changesets step creates it, which
    # is the common path on a tree with nothing pending. Nothing to remove, and
    # nothing worth a line of output.
    return 0
  fi
  if ! is_our_temp_dir "$path"; then
    echo "  ! cleanup: $1=$path is not a directory this script created — NOT removing it" >&2
    return 0
  fi
  rm -rf "$path"
}

cleanup() {
  # Nothing here FAILS on purpose. A failure while restoring state is a failure
  # to report *after* whatever already ended the run, and with the ERR trap
  # still armed it would print the previous command as the culprit. A refused
  # removal is the one thing that speaks, and it speaks without failing — see
  # `remove_temp_dir`, and note that it runs from an EXIT trap, where under
  # `set -e` a failing command replaces the status of the run that just ended.
  trap - ERR
  restore_versions
  remove_temp_dir PACK_DIR "$PACK_DIR"
  remove_temp_dir CONSUMER_DIR "$CONSUMER_DIR"
  remove_temp_dir VERSION_SNAPSHOT "$VERSION_SNAPSHOT"
}
trap cleanup EXIT

# Generated state never reaches the operator's own state directory.
#
# Every SDK entry point that writes a session puts it under `NAMZU_HOME`
# (default `~/.namzu`), in `projects/<slug>/`, and never under the working
# directory. `NAMZU_HOME` is pointed into the consumer directory, which
# `cleanup` removes, so whatever a fixture here does write — the eval run, a
# fixture against an older SDK — lands in scratch rather than in the
# operator's `~/.namzu`. `XDG_STATE_HOME` is pointed there too: no current SDK
# reads it, and the live fixture asserts nothing appeared under it. The packed
# live fixture goes further and asserts it wrote nothing at all; see
# `run_live_fixture`.
STATE_SCRATCH="$CONSUMER_DIR/generated-state"
export XDG_STATE_HOME="$STATE_SCRATCH/xdg"
export NAMZU_HOME="$STATE_SCRATCH/namzu-home"

# ---------------------------------------------------------------------------
# A refusal has to be readable.
# ---------------------------------------------------------------------------
#
# Under `set -e` a failing command ends the script, and with no trap that is
# the entire report — a bare exit code. #415 is the CI run that motivated
# this: a gate that packs every publishable package and installs them into a
# throwaway consumer project, refusing with `Process completed with exit code
# 1` and nothing else, so "the registry blipped" and "this change broke a peer
# range" were indistinguishable. One of those is worth stopping a release for;
# the other is worth a re-run, and telling them apart cost a full CI cycle.
#
# The failing command's line is `BASH_LINENO[0]`, not `LINENO`: inside the
# trap function `LINENO` is the trap's own line. `set -E` is what lets the trap
# reach inside functions at all — without it a failure in `run_install` or
# `sibling_tarballs` would still abort silently.
CURRENT_STEP="startup"

on_error() {
  local status=$?
  # stderr, not stdout: the whole point is that it cannot be swallowed, and a
  # caller redirecting this script's stdout would otherwise redirect away the
  # one line that says what happened.
  echo "" >&2
  echo "✗ verify-consumer-install aborted (exit $status)" >&2
  echo "  step:    $CURRENT_STEP" >&2
  echo "  line:    ${BASH_LINENO[0]}" >&2
  echo "  command: $BASH_COMMAND" >&2
  return 0
}
trap on_error ERR

# One npm install, with its output kept.
#
# `--silent` is gone on purpose. It does not quieten progress, it quietens the
# ERROR: `npm install --silent /tmp/absent.tgz` prints nothing and exits 254,
# so `set -e` aborted a gate that had said nothing about what it could not
# resolve. `--no-fund --no-audit --no-save` are unchanged, and on success this
# is no noisier than before — the output is only printed when it is the answer.
run_install() {
  local log="$CONSUMER_DIR/npm-install.log"
  local status=0
  npm install --no-fund --no-audit --no-save "$@" >"$log" 2>&1 || status=$?
  if [ "$status" -eq 0 ]; then
    # `|| true` on purpose: an rm that cannot unlink its log must not turn an
    # install that just succeeded into an abort, and under `set -e` it would.
    rm -f "$log" || true
    return 0
  fi
  # stderr, with npm's own output beside it rather than somewhere else: this
  # is the block a reader of a failed CI step is looking for.
  echo "" >&2
  echo "✗ npm install failed (exit $status) — $CURRENT_STEP" >&2
  echo "  npm install --no-fund --no-audit --no-save $*" >&2
  echo "  ---- npm output ----" >&2
  if [ -s "$log" ]; then
    sed 's/^/  /' "$log" >&2
  else
    echo "  (npm wrote nothing to stdout or stderr)" >&2
  fi
  echo "  --------------------" >&2
  # npm's own status, not a generic 1, so 254 (npm itself could not run) stays
  # distinguishable from 1. It does NOT separate a resolution error from a
  # registry error: npm exits 1 for ERESOLVE and for an unreachable registry
  # alike, and the block printed above is what tells those apart.
  exit "$status"
}

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
#
# The step is labelled BEFORE the command it labels. The trap reports
# `CURRENT_STEP` as it stands when the failure happens, and `find` on a
# `WORKSPACE_ROOT` with no `.changeset` exits 1 with its stderr discarded — so
# with the label assigned on the next line, the one failure that produces no
# other output was also reported as `step: startup`.
CURRENT_STEP="applying pending changesets to preview the shipping versions"
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
CURRENT_STEP="changelog release-heading check"
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
CURRENT_STEP="reading the shipping versions and package table"
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

CURRENT_STEP="packing publishable Namzu packages"
echo "=== Packing publishable Namzu packages ==="
while IFS=$'\t' read -r pkg_name pkg_path sdk_dependent; do
  CURRENT_STEP="packing $pkg_name"
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
  CURRENT_STEP="$pkg_name + @namzu/sdk consumer install"
  TARBALL=$(ls "$PACK_DIR"/namzu-${dep}-*.tgz | head -1)
  test -f "$TARBALL" || { echo "    ✗ Missing tarball for $dep"; exit 1; }

  SIBLING_TARBALLS=$(sibling_tarballs "$pkg_path")

  rm -rf node_modules package-lock.json
  # shellcheck disable=SC2086
  run_install "$SDK_TARBALL" "$TARBALL" $SIBLING_TARBALLS

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
CURRENT_STEP="@namzu/cli + @namzu/evals documented command fixture"
CLI_PATH=$(awk -F'\t' '$1 == "@namzu/cli" { print $2 }' "$PACKAGE_TABLE")
CLI_SIBLINGS=$(sibling_tarballs "$CLI_PATH")
# shellcheck disable=SC2086
run_install "$SDK_TARBALL" "$CLI_TARBALL" "$EVALS_TARBALL" $CLI_SIBLINGS

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
CURRENT_STEP="@namzu/live packed runtime → SDK query fixture"
run_install "$SDK_TARBALL" "$LIVE_TARBALL"

cat > assert-live-runtime.mjs <<'EOF'
import { LiveAgent, LiveSession, NamzuModel } from '@namzu/live'
import {
  InMemorySessionLog, MockLLMProvider, ToolRegistry,
  generateProjectId, generateSessionId, generateTenantId, generateTopicId,
} from '@namzu/sdk'

const expectedText = 'PACKED_LIVE_BRIDGE_OK'
const instructions = 'PACKED_LIVE_INSTRUCTIONS'
const userInput = 'Exercise the packed live bridge.'
const provider = new MockLLMProvider({ responseText: expectedText })
const sessionId = generateSessionId()
const sessionLog = new InMemorySessionLog({ sessionId })
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
        projectId: generateProjectId(),
        provider,
        resumeHandler: async () => ({ action: 'continue' }),
        turnConfig: {
          maxIterations: 4,
          maxResponseTokens: 512,
          model: 'packed-fixture-model',
          timeoutMs: 30_000,
          tokenBudget: 100_000,
        },
        sessionLog,
        sessionId,
        tenantId: generateTenantId(),
        tools: new ToolRegistry(),
        topicId: generateTopicId(),
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
if (!result.modelTurnId) {
  failures.push('completed turn omitted its SDK turn id')
}
if (result.modelSessionId !== sessionId) {
  failures.push(`completed turn named SDK session ${JSON.stringify(result.modelSessionId)}, expected ${JSON.stringify(sessionId)}`)
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

const log = await sessionLog.readAll()
const types = log.entries.map((entry) => entry.record.type)
if (!log.intact) {
  failures.push('SDK session log is not intact after one turn')
}
if (types[0] !== 'session_started') {
  failures.push(`SDK session log starts with ${JSON.stringify(types[0])}, expected "session_started"`)
}
if (types.at(-1) !== 'turn_completed') {
  failures.push(`SDK session log ends with ${JSON.stringify(types.at(-1))}, expected "turn_completed"`)
}
const turnStarted = log.entries.find((entry) => entry.record.type === 'turn_started')
if (!turnStarted || turnStarted.record.turnId !== result.modelTurnId) {
  failures.push('SDK session log does not record the reported turn id on turn_started')
}

if (failures.length > 0) {
  console.error('✗ @namzu/live packed-runtime check failed:')
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}

console.log('✅ packed @namzu/live completed one SDK-backed turn with public exports, events and session-log state intact')
EOF

# The fixture keeps its session in an `InMemorySessionLog` and names no
# `paths`, so the session's checkpoints and token ledger are held in memory
# with it. `NAMZU_HOME` and `XDG_STATE_HOME` are each required to be empty
# afterwards, and the working directory to have no `.namzu`: an SDK that wrote
# a session there, or fell back to an XDG or working-directory default, fails
# here rather than leaving a tree in the operator's home on every run of the
# gate.
run_live_fixture() {
  local root leftover
  rm -rf "$STATE_SCRATCH" .namzu
  mkdir -p "$XDG_STATE_HOME" "$NAMZU_HOME"
  node assert-live-runtime.mjs
  for root in "$XDG_STATE_HOME" "$NAMZU_HOME"; do
    leftover=$(find "$root" -mindepth 1 -print -quit)
    if [ -n "$leftover" ]; then
      echo "    ✗ The in-memory live fixture wrote generated state under $root:"
      find "$root" -type f | sed 's/^/      /'
      exit 1
    fi
  done
  if [ -e .namzu ]; then
    echo "    ✗ The in-memory live fixture created .namzu in the working directory:"
    find .namzu | sed 's/^/      /'
    exit 1
  fi
  echo "    ✓ no generated state under NAMZU_HOME, XDG_STATE_HOME or the working directory"
}

echo "    → packed live + shipping SDK"
CURRENT_STEP="@namzu/live packed runtime leaves no generated state"
run_live_fixture

# The peer range promises the first SDK version in the supported major too,
# not only the workspace head. Exercise that exact lower bound with the same
# packed live artifact so the declaration and runtime cannot drift apart.
#
# The manifest path is an ARGUMENT to node, never spliced into the JavaScript
# string: on Git Bash a shell path handed over this way is one MSYS converts
# for the native binary, and a Windows username containing an apostrophe or a
# space cannot break the expression either. `node_path` converts it to the
# form Node can open outright (#415).
LIVE_SDK_RANGE=$(node -p "require(process.argv[1]).peerDependencies['@namzu/sdk']" "$(node_path "$WORKSPACE_ROOT/packages/live/package.json")")
LIVE_MINIMUM_SDK=${LIVE_SDK_RANGE#>=}
LIVE_MINIMUM_SDK=${LIVE_MINIMUM_SDK%% *}
case "$LIVE_MINIMUM_SDK" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) echo "    ✗ Could not derive live's minimum SDK from peer range: $LIVE_SDK_RANGE"; exit 1 ;;
esac
echo "    → packed live + minimum supported SDK $LIVE_MINIMUM_SDK"
CURRENT_STEP="@namzu/live against the minimum supported SDK $LIVE_MINIMUM_SDK"
SHIPPING_SDK_VERSION=$(node -p 'require(process.argv[1]).version' "$(node_path "$WORKSPACE_ROOT/packages/sdk/package.json")")
if [ "$LIVE_MINIMUM_SDK" = "$SHIPPING_SDK_VERSION" ]; then
  # A package cannot be downloaded from the registry before this release has
  # published it. The shipping-tarball fixture immediately above already ran
  # this exact lower bound, so requiring the registry copy here creates a
  # bootstrap deadlock: the pre-publish gate waits for the publish it gates.
  echo "    ✓ minimum is the shipping SDK; packed fixture above covers it"
else
  rm -rf node_modules package-lock.json
  run_install "$LIVE_TARBALL" "@namzu/sdk@$LIVE_MINIMUM_SDK"
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
CURRENT_STEP="@namzu/sandbox public-surface fixture"
run_install "$SDK_TARBALL" "$SANDBOX_TARBALL"

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
CURRENT_STEP="@namzu/telemetry single-api-instance + span-smoke fixture"
SDK_VERSION=$(node -p 'require(process.argv[1]).version' "$(node_path "$WORKSPACE_ROOT/packages/sdk/package.json")")
SDK_MAJOR_MINOR="${SDK_VERSION%.*}"
case "$SDK_MAJOR_MINOR" in
  0.0|0.1|0.2|0.3)
    echo "  ⊘ SKIP: SDK version $SDK_VERSION is below telemetry peer range >=0.4.0."
    echo "    This fixture runs in CI after the Version Packages commit bumps SDK."
    exit 0
    ;;
esac

rm -rf node_modules package-lock.json
run_install \
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
