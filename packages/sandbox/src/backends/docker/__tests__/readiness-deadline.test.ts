import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildDockerBackend, resolveLayout } from '../index.js'

const realFetch = globalThis.fetch
let workDir: string
let dockerShim: string
let dockerLog: string

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-docker-readiness-'))
	dockerShim = join(workDir, 'docker-shim')
	dockerLog = join(workDir, 'docker.log')
	process.env.NAMZU_TEST_DOCKER_LOG = dockerLog
	writeFileSync(
		dockerShim,
		[
			'#!/bin/sh',
			'case "$1" in',
			'  network) printf "false\\n" ;;',
			'  run) printf "container-id\\n" ;;',
			'  inspect) printf "65534\\n" ;;',
			'  rm) printf "rm\\n" >> "${NAMZU_TEST_DOCKER_LOG:?}"; if [ "${NAMZU_TEST_HOLD_DOCKER_RM:-}" = "1" ]; then sleep 30; fi ;;',
			'  *) exit 2 ;;',
			'esac',
		].join('\n'),
		{ mode: 0o755 },
	)
})

afterEach(() => {
	globalThis.fetch = realFetch
	process.env.NAMZU_TEST_DOCKER_LOG = undefined
	process.env.NAMZU_TEST_HOLD_DOCKER_RM = undefined
	rmSync(workDir, { recursive: true, force: true })
})

function backend(timeoutMs = 25) {
	return buildDockerBackend({
		image: 'worker:test',
		layout: resolveLayout({
			outputs: { source: { type: 'hostDir', hostPath: workDir } },
		}),
		dockerBinary: dockerShim,
		network: 'bridge',
		readyTimeoutMs: timeoutMs,
		readyPollIntervalMs: 5,
	})
}

function cleanupCalls(): number {
	return readFileSync(dockerLog, 'utf8').trim().split('\n').length
}

describe('docker worker readiness deadline', () => {
	it('settles and aborts a health fetch implementation that ignores cancellation', async () => {
		let healthSignal: AbortSignal | undefined
		globalThis.fetch = vi.fn(async (_input, init) => {
			healthSignal = init?.signal ?? undefined
			return await new Promise<Response>(() => undefined)
		}) as typeof fetch

		const startedAt = performance.now()
		await expect(backend().create({ workingDirectory: workDir })).rejects.toThrow(
			/did not become ready within 25ms/,
		)
		expect(healthSignal?.aborted).toBe(true)
		expect(cleanupCalls()).toBe(1)
		expect(performance.now() - startedAt).toBeLessThan(500)
	})

	it('kills a held cleanup child instead of hiding the readiness failure', async () => {
		process.env.NAMZU_TEST_HOLD_DOCKER_RM = '1'
		globalThis.fetch = vi.fn(
			async () => await new Promise<Response>(() => undefined),
		) as typeof fetch
		const startedAt = performance.now()

		await expect(backend(20).create({ workingDirectory: workDir })).rejects.toThrow(
			/did not become ready within 20ms/,
		)
		expect(cleanupCalls()).toBe(1)
		expect(performance.now() - startedAt).toBeLessThan(1_750)
	})
})
