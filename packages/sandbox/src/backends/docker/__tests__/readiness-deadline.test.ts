import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
			'  rm) printf "rm\\n" >> "${NAMZU_TEST_DOCKER_LOG:?}"; if [ "${NAMZU_TEST_HOLD_DOCKER_RM:-}" = "1" ]; then sleep 1; fi; if [ "${NAMZU_TEST_FAIL_DOCKER_RM:-}" = "1" ]; then exit 9; fi ;;',
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
	process.env.NAMZU_TEST_FAIL_DOCKER_RM = undefined
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
	it('routes a cancellable exec through the worker lease protocol', async () => {
		const paths: string[] = []
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input)
			paths.push(url)
			if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
			if (url.endsWith('/executions/reserve')) {
				return new Response(
					JSON.stringify({
						ok: true,
						protocolVersion: 2,
						executionId: 'exec_00000000-0000-4000-8000-000000000001',
						leaseExpiresAt: Date.now() + 30_000,
					}),
					{ status: 201 },
				)
			}
			if (url.endsWith('/execute')) {
				return new Response('{"type":"result","exitCode":0,"timedOut":false,"durationMs":4}\n', {
					status: 200,
				})
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch
		const sandbox = await backend(100).create({ workingDirectory: workDir })

		await expect(
			sandbox.exec('true', [], { signal: new AbortController().signal }),
		).resolves.toMatchObject({ exitCode: 0 })
		expect(paths).toEqual([
			'http://127.0.0.1:65534/healthz',
			'http://127.0.0.1:65534/executions/reserve',
			'http://127.0.0.1:65534/execute',
		])
		await sandbox.destroy()
	})

	it('stays busy until every concurrent exec finishes and never resurrects after destroy', async () => {
		const releases: Array<() => void> = []
		let reservation = 0
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input)
			if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
			if (url.endsWith('/executions/reserve')) {
				reservation += 1
				return new Response(
					JSON.stringify({
						ok: true,
						protocolVersion: 2,
						executionId: `exec_00000000-0000-4000-8000-${String(reservation).padStart(12, '0')}`,
						leaseExpiresAt: Date.now() + 30_000,
					}),
					{ status: 201 },
				)
			}
			if (url.endsWith('/execute')) {
				return new Response(
					new ReadableStream({
						start(controller) {
							releases.push(() => {
								controller.enqueue(
									new TextEncoder().encode(
										'{"type":"result","exitCode":0,"timedOut":false,"durationMs":4}\n',
									),
								)
								controller.close()
							})
						},
					}),
					{ status: 200 },
				)
			}
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch
		const sandbox = await backend(100).create({ workingDirectory: workDir })
		const first = sandbox.exec('first')
		const second = sandbox.exec('second')
		while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 0))

		expect(sandbox.status).toBe('busy')
		releases[0]?.()
		await first
		expect(sandbox.status).toBe('busy')

		await Promise.all([sandbox.destroy(), sandbox.destroy()])
		expect(sandbox.status).toBe('destroyed')
		expect(cleanupCalls()).toBe(1)
		releases[1]?.()
		await second
		expect(sandbox.status).toBe('destroyed')
	})

	it('retires and fences an old worker after an identity-less execution outcome becomes unknown', async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input)
			if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
			if (url.endsWith('/executions/reserve')) {
				return new Response(JSON.stringify({ error: 'not_found' }), {
					status: 404,
				})
			}
			if (url.endsWith('/execute')) return new Response('not-json\n', { status: 200 })
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch
		const sandbox = await backend(100).create({ workingDirectory: workDir })

		try {
			await sandbox.exec('ambiguous')
			expect.unreachable('an identity-less remote outcome must retire its container')
		} catch (error) {
			expect(error).toMatchObject({ retirement: { accepted: true } })
			expect((error as Error).message).toMatch(/outcome is unknown/i)
		}
		expect(sandbox.status).toBe('destroyed')
		expect(cleanupCalls()).toBe(1)
		await expect(sandbox.readFile('anything')).rejects.toThrow(/no new worker operation/)
		await sandbox.destroy()
		expect(cleanupCalls()).toBe(1)
	})

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

	it('lets caller cancellation stop readiness and reconciles the known container name', async () => {
		let markHealthStarted!: () => void
		const healthStarted = new Promise<void>((resolve) => {
			markHealthStarted = resolve
		})
		let healthSignal: AbortSignal | undefined
		globalThis.fetch = vi.fn(async (_input, init) => {
			healthSignal = init?.signal ?? undefined
			markHealthStarted()
			return await new Promise<Response>(() => undefined)
		}) as typeof fetch
		const caller = new AbortController()
		const pending = backend(100).create({
			workingDirectory: workDir,
			signal: caller.signal,
		})

		await healthStarted
		const reason = new Error('operator stopped docker allocation')
		caller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(healthSignal?.aborted).toBe(true)
		expect(healthSignal?.reason).toBe(reason)
		expect(cleanupCalls()).toBe(1)
	})

	it('passes teardown authority to a held docker rm child', async () => {
		globalThis.fetch = vi.fn(async () => new Response('ok', { status: 200 })) as typeof fetch
		const sandbox = await backend().create({ workingDirectory: workDir })
		process.env.NAMZU_TEST_HOLD_DOCKER_RM = '1'
		const owner = new AbortController()
		const startedAt = performance.now()
		const pending = sandbox.destroy({ signal: owner.signal })
		while (!existsSync(dockerLog) || !readFileSync(dockerLog, 'utf8').includes('rm')) {
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
		owner.abort(new Error('teardown deadline'))

		await expect(pending).rejects.toThrow('teardown deadline')
		expect(owner.signal.aborted).toBe(true)
		expect(performance.now() - startedAt).toBeLessThan(500)
	})

	it('reports a failed security retirement instead of claiming the container was removed', async () => {
		globalThis.fetch = vi.fn(async (input) => {
			const url = String(input)
			if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
			if (url.endsWith('/executions/reserve')) {
				return new Response(JSON.stringify({ error: 'not_found' }), {
					status: 404,
				})
			}
			if (url.endsWith('/execute')) return new Response('not-json\n', { status: 200 })
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch
		const sandbox = await backend(100).create({ workingDirectory: workDir })
		process.env.NAMZU_TEST_FAIL_DOCKER_RM = '1'

		try {
			await sandbox.exec('ambiguous')
			expect.unreachable('an unconfirmed removal must remain observable')
		} catch (error) {
			expect(error).toMatchObject({
				retirement: { accepted: false, error: expect.any(Error) },
			})
		}
		expect(sandbox.status).toBe('destroyed')
		expect(cleanupCalls()).toBe(1)
		await expect(sandbox.readFile('anything')).rejects.toThrow(/no new worker operation/)
	})
})
