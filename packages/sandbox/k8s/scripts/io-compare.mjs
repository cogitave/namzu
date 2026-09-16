#!/usr/bin/env node
/**
 * Acceptance criterion 4: small-file IO on a persistent workspace's block
 * PVC stays within 1.5x of host ext4 — the number Block mode exists to
 * make true. `docs/sdk/kubernetes-sandbox.md#the-disk-is-fixed-at-creation-
 * and-must-be-block` names the alternative this backend refuses: a
 * `Filesystem`-mode PVC under a VM-isolating RuntimeClass reaches the guest
 * over virtio-fs, which is several times slower at exactly this workload
 * (many small files) rather than the bulk-throughput case virtio-fs
 * actually handles well. This script is what turns "several times slower"
 * into a measured number for THIS cluster's specific storage backend.
 *
 * Runs the identical `/bin/sh` benchmark — create N small files, read them
 * all back, remove them — inside the workspace's guest AND on the machine
 * running this script, so the two sides differ only in the filesystem
 * underneath, not in language or runtime overhead. "Host ext4" here means
 * THIS SCRIPT's own temp directory; run it as a pod on the same node class
 * this cluster schedules sandboxes onto (or pass `--host-dir` at a hostPath
 * mount) for a comparison that means something — a laptop's NVMe compared
 * against a cloud PV is not the number this criterion is asking for.
 *
 * Runs against the BUILT package (`pnpm -r build` first — see ../README.md).
 *
 * Usage:
 *   node io-compare.mjs --namespace namzu-sandboxes --template namzu-workspace \
 *     [--files 200] [--host-dir /some/ext4/mount] \
 *     [--in-cluster | --server URL --token TOKEN]
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createKubernetesWorkspace } from '@namzu/sandbox'
import { parseArgs, report, requireOption, resolveAccess } from './lib/cluster-access.mjs'

const flags = parseArgs(process.argv.slice(2))
const namespace = requireOption(flags, 'namespace', 'NAMZU_K8S_NAMESPACE')
const sandboxTemplateName = requireOption(flags, 'template', 'NAMZU_K8S_TEMPLATE')
const fileCount = Number(flags.files ?? 200)
const access = resolveAccess(flags)

// Same script, both sides: write N files, read N files back, remove the
// directory. `$1` is the target directory.
const BENCH_SCRIPT = `
set -e
dir="$1"
mkdir -p "$dir"
i=0
while [ "$i" -lt ${fileCount} ]; do
  printf 'namzu-io-compare-%s' "$i" > "$dir/file-$i.txt"
  i=$((i + 1))
done
i=0
while [ "$i" -lt ${fileCount} ]; do
  cat "$dir/file-$i.txt" > /dev/null
  i=$((i + 1))
done
rm -rf "$dir"
`

function timeHostBench() {
	const dir = flags['host-dir'] ?? mkdtempSync(join(tmpdir(), 'namzu-io-compare-'))
	const startedAt = process.hrtime.bigint()
	execFileSync('/bin/sh', ['-c', BENCH_SCRIPT, 'io-compare-host', dir])
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
	if (!flags['host-dir']) rmSync(dir, { recursive: true, force: true })
	return elapsedMs
}

async function timeSandboxBench(sandbox) {
	const startedAt = process.hrtime.bigint()
	const result = await sandbox.exec('/bin/sh', ['-c', BENCH_SCRIPT, 'io-compare-guest', '/workspace/io-compare'])
	const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000
	if (result.exitCode !== 0) {
		throw new Error(`guest benchmark exited ${result.exitCode}: ${result.stderr}`)
	}
	return elapsedMs
}

const config = {
	tier: 'microvm',
	service: 'kubernetes',
	namespace,
	access,
	sandboxTemplateName,
}

const workspace = await createKubernetesWorkspace(config, {
	workspaceId: flags['workspace-id'] ?? 'acceptance-io-compare',
	workingDirectory: '/workspace',
})

let ratio
try {
	const hostMs = timeHostBench()
	const guestMs = await timeSandboxBench(workspace)
	ratio = guestMs / hostMs
	console.log(
		`io-compare: host=${hostMs.toFixed(1)}ms guest=${guestMs.toFixed(1)}ms ratio=${ratio.toFixed(2)}x (${fileCount} files)`,
	)
} finally {
	await workspace.destroy({ deleteDisk: true }).catch(() => {})
}

report('guest small-file IO within 1.5x of host ext4', ratio <= 1.5, `measured ${ratio.toFixed(2)}x`)
