/**
 * Docker smoke test — leaf-mount permission semantics.
 *
 * Concern Codex flagged: the Dockerfile pre-creates only the parent
 * dirs (`/mnt`, `/mnt/user-data`, `/mnt/skills`) as root-owned 0555.
 * The runtime claim is that:
 *
 *   1. When `outputs` IS bound, uid 1001 (the worker user) can write
 *      into it.
 *   2. When a leaf path (e.g. `/mnt/user-data/uploads`) is NOT bound,
 *      the path simply does not exist — `stat` returns ENOENT, NOT
 *      a writable empty dir.
 *
 * Both of those are kernel-level mount-namespace properties, not
 * unit-testable. This file exercises them against a real docker
 * daemon. Run via:
 *
 *   pnpm --filter @namzu/sandbox test:smoke
 *   # or, from the monorepo root:
 *   pnpm sandbox:smoke
 *
 * Excluded from the default `pnpm test` run by `vitest.config.ts`.
 *
 * Pre-requisites:
 *   - `docker` CLI on PATH.
 *   - A pre-built reference image. By default this test looks for
 *     `namzu-sandbox-worker:smoke`. Override with the
 *     `NAMZU_SANDBOX_SMOKE_IMAGE` env. Build the image once with:
 *       `docker build -t namzu-sandbox-worker:smoke -f packages/sandbox/worker/Dockerfile packages/sandbox`
 *   - A host-side scratch directory the test creates and tears down.
 *
 * On a developer machine without docker the test self-skips with a
 * clear message. On CI (`process.env.CI === 'true'`) the same
 * pre-conditions FAIL FAST instead of skipping, so a CI
 * misconfiguration cannot silently mask a regression — see the
 * `.github/workflows/sandbox-smoke.yml` workflow which is meant to
 * always run with docker available.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createSandboxProvider } from '../../../index.js'

const IMAGE = process.env.NAMZU_SANDBOX_SMOKE_IMAGE ?? 'namzu-sandbox-worker:smoke'
const IS_CI = process.env.CI === 'true'

function dockerAvailable(): boolean {
	const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
		stdio: 'ignore',
	})
	return probe.status === 0
}

function imagePresent(image: string): boolean {
	const probe = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
	return probe.status === 0
}

const skipReason = !dockerAvailable()
	? 'docker daemon not reachable — skipping smoke test'
	: !imagePresent(IMAGE)
		? `image ${IMAGE} not present — build it with \`docker build -t ${IMAGE} -f packages/sandbox/worker/Dockerfile packages/sandbox\` and re-run`
		: null

// CI fail-fast: the smoke workflow is meant to always have docker +
// the reference image. Skipping silently in that environment would
// let a regression land without the test even attempting to run.
// Locally (no `CI=true`) skipping with a hint is the right behaviour
// for a developer who hasn't built the image yet.
if (IS_CI && skipReason) {
	throw new Error(
		`smoke test pre-condition not satisfied on CI: ${skipReason}. Configure the workflow to install docker and build the reference image before running.`,
	)
}

describe.skipIf(skipReason !== null)('docker smoke — leaf permissions', () => {
	let outputsHost: string

	beforeAll(() => {
		outputsHost = mkdtempSync(join(tmpdir(), 'namzu-sandbox-smoke-out-'))
	})

	afterAll(() => {
		if (outputsHost) {
			rmSync(outputsHost, { recursive: true, force: true })
		}
	})

	it('uid 1001 can write to the outputs bind, and the host sees the file', async () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', image: IMAGE },
			layout: {
				outputs: { source: { type: 'hostDir', hostPath: outputsHost } },
			},
		})
		const sandbox = await provider.create()
		try {
			const result = await sandbox.exec('sh', [
				'-c',
				'id -u && echo "smoke" > /mnt/user-data/outputs/hello.txt',
			])
			expect(result.exitCode).toBe(0)
			expect(result.stdout.trim()).toBe('1001')
			// Host-side read confirms the bind round-trips.
			const hostContent = readFileSync(join(outputsHost, 'hello.txt'), 'utf8')
			expect(hostContent.trim()).toBe('smoke')
		} finally {
			await sandbox.destroy()
		}
	}, 60_000)

	it('unbound leaves do not exist — uploads/transcripts/tool_results are ENOENT, not empty', async () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', image: IMAGE },
			layout: {
				outputs: { source: { type: 'hostDir', hostPath: outputsHost } },
				// Intentionally leave uploads / toolResults / transcripts
				// unbound. The Dockerfile pre-creates only the parents
				// (`/mnt/user-data`, `/mnt/skills`); leaves should not
				// exist and `stat` should fail.
			},
		})
		const sandbox = await provider.create()
		try {
			for (const leafPath of [
				'/mnt/user-data/uploads',
				'/mnt/user-data/tool_results',
				'/mnt/transcripts',
			]) {
				const result = await sandbox.exec('sh', ['-c', `stat ${leafPath} 2>&1; echo --rc=$?`])
				// `stat` returns non-zero on ENOENT; the rc line carries
				// the failure. Either is the contract; we accept either
				// "No such file" or "cannot stat" wording across distros.
				expect(result.stdout).toMatch(/--rc=[1-9]/)
				expect(result.stdout.toLowerCase()).toMatch(/no such file|cannot stat|does not exist/)
			}
		} finally {
			await sandbox.destroy()
		}
	}, 60_000)

	it('uid 1001 cannot mkdir into the root-owned 0555 parent /mnt/user-data', async () => {
		const provider = createSandboxProvider({
			backend: { tier: 'container', image: IMAGE },
			layout: {
				outputs: { source: { type: 'hostDir', hostPath: outputsHost } },
			},
		})
		const sandbox = await provider.create()
		try {
			// The model trying to "create the missing leaf dir" hits
			// the 0555 root-owned parent and is denied — exactly what
			// distinguishes "not bound" from "writable empty dir".
			const result = await sandbox.exec('sh', [
				'-c',
				'mkdir /mnt/user-data/fake 2>&1; echo --rc=$?',
			])
			expect(result.stdout).toMatch(/--rc=[1-9]/)
			expect(result.stdout.toLowerCase()).toMatch(/permission denied/)
		} finally {
			await sandbox.destroy()
		}
	}, 60_000)
})
