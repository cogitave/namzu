import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ResolvedContainerSandboxLayout } from '@namzu/sdk'

import { buildAciStandbyPoolBackend } from '../index.js'

const realFetch = globalThis.fetch
const layout: ResolvedContainerSandboxLayout = {
	outputs: {
		source: { type: 'inImage' },
		containerPath: '/workspace',
	},
}

afterEach(() => {
	globalThis.fetch = realFetch
})

function backend(timeoutMs = 25) {
	return buildAciStandbyPoolBackend({
		subscriptionId: 'sub',
		resourceGroup: 'rg',
		location: 'westeurope',
		standbyPoolResourceId: '/pools/p',
		containerGroupProfileResourceId: '/profiles/p',
		layout,
		getArmToken: async () => 'token',
		subnetId: '/subnets/private',
		readyTimeoutMs: timeoutMs,
		readyPollIntervalMs: 5,
	})
}

function stubClaim(
	options: {
		deleteSafetyMs?: number
		holdDelete?: boolean
		holdIp?: boolean
		ready?: boolean
	} = {},
): {
	healthSignal: () => AbortSignal | undefined
	ipSignal: () => AbortSignal | undefined
	deleteSignal: () => AbortSignal | undefined
	deleteCalls: () => number
} {
	let healthSignal: AbortSignal | undefined
	let ipSignal: AbortSignal | undefined
	let deleteSignal: AbortSignal | undefined
	let deleteCalls = 0
	globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input)
		const method = init?.method ?? 'GET'
		if (url.startsWith('https://management.azure.com') && method === 'PUT') {
			return new Response(
				JSON.stringify({
					properties: options.holdIp
						? { provisioningState: 'Creating' }
						: {
								provisioningState: 'Succeeded',
								ipAddress: { ip: '10.0.0.8' },
							},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		if (url.startsWith('https://management.azure.com') && method === 'GET') {
			ipSignal = init?.signal ?? undefined
			return await new Promise<Response>(() => undefined)
		}
		if (url === 'http://10.0.0.8:2024/healthz') {
			healthSignal = init?.signal ?? undefined
			if (options.ready) return new Response('ok', { status: 200 })
			return await new Promise<Response>(() => undefined)
		}
		if (url.startsWith('https://management.azure.com') && method === 'DELETE') {
			deleteCalls += 1
			deleteSignal = init?.signal ?? undefined
			if (!options.holdDelete) return new Response(null, { status: 204 })
			return await new Promise<Response>((_resolve, reject) => {
				const safety = options.deleteSafetyMs
					? setTimeout(() => reject(new Error('test safety release')), options.deleteSafetyMs)
					: undefined
				deleteSignal?.addEventListener(
					'abort',
					() => {
						if (safety !== undefined) clearTimeout(safety)
						reject(deleteSignal?.reason)
					},
					{ once: true },
				)
			})
		}
		return new Response('unexpected', { status: 500 })
	}) as typeof fetch
	return {
		healthSignal: () => healthSignal,
		ipSignal: () => ipSignal,
		deleteSignal: () => deleteSignal,
		deleteCalls: () => deleteCalls,
	}
}

describe('standby worker readiness deadline', () => {
	it('routes a cancellable exec through the worker lease protocol', async () => {
		const workerPaths: string[] = []
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.startsWith('https://management.azure.com') && method === 'PUT') {
				return new Response(
					JSON.stringify({
						properties: {
							provisioningState: 'Succeeded',
							ipAddress: { ip: '10.0.0.8' },
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (url.startsWith('https://management.azure.com') && method === 'DELETE') {
				return new Response(null, { status: 204 })
			}
			workerPaths.push(url)
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
		const sandbox = await backend(100).create({ workingDirectory: '/workspace' })

		await expect(
			sandbox.exec('true', [], { signal: new AbortController().signal }),
		).resolves.toMatchObject({ exitCode: 0 })
		expect(workerPaths).toEqual([
			'http://10.0.0.8:2024/healthz',
			'http://10.0.0.8:2024/executions/reserve',
			'http://10.0.0.8:2024/execute',
		])
		await sandbox.destroy()
	})

	it('bounds a health fetch by the caller-selected total readiness clock', async () => {
		const observed = stubClaim()
		const startedAt = performance.now()

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/worker \/healthz never responded \(25ms\)/,
		)
		expect(observed.healthSignal()?.aborted).toBe(true)
		expect(observed.deleteCalls()).toBe(1)
		expect(performance.now() - startedAt).toBeLessThan(500)
	})

	it('retires and fences an old worker after an identity-less execution outcome becomes unknown', async () => {
		let deleteCalls = 0
		globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			const method = init?.method ?? 'GET'
			if (url.startsWith('https://management.azure.com') && method === 'PUT') {
				return new Response(
					JSON.stringify({
						properties: {
							provisioningState: 'Succeeded',
							ipAddress: { ip: '10.0.0.8' },
						},
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (url.startsWith('https://management.azure.com') && method === 'DELETE') {
				deleteCalls += 1
				return new Response(null, { status: 410 })
			}
			if (url.endsWith('/healthz')) return new Response('ok', { status: 200 })
			if (url.endsWith('/executions/reserve')) {
				return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 })
			}
			if (url.endsWith('/execute')) return new Response('not-json\n', { status: 200 })
			throw new Error(`unexpected URL ${url}`)
		}) as typeof fetch
		const sandbox = await backend(100).create({ workingDirectory: '/workspace' })

		try {
			await sandbox.exec('ambiguous')
			expect.unreachable('an identity-less remote outcome must retire its container group')
		} catch (error) {
			expect(error).toMatchObject({ retirement: { accepted: true } })
			expect((error as Error).message).toMatch(/outcome is unknown/i)
		}
		expect(sandbox.status).toBe('destroyed')
		expect(deleteCalls).toBe(1)
		await expect(sandbox.writeFile('anything', 'nope')).rejects.toThrow(/no new worker operation/)
		await sandbox.destroy()
		expect(deleteCalls).toBe(1)
	})

	it('uses the same total clock while waiting for an IP address', async () => {
		const observed = stubClaim({ holdIp: true })
		const startedAt = performance.now()

		await expect(backend().create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/timed out waiting for container group IP \(25ms\)/,
		)
		expect(observed.ipSignal()?.aborted).toBe(true)
		expect(observed.deleteCalls()).toBe(1)
		expect(performance.now() - startedAt).toBeLessThan(500)
	})

	it('abandons a held ARM DELETE after the cleanup grace', async () => {
		const observed = stubClaim({ holdDelete: true })
		const startedAt = performance.now()

		await expect(backend(20).create({ workingDirectory: '/workspace' })).rejects.toThrow(
			/worker \/healthz never responded \(20ms\)/,
		)
		expect(observed.deleteCalls()).toBe(1)
		expect(observed.deleteSignal()?.aborted).toBe(true)
		expect(performance.now() - startedAt).toBeLessThan(1_750)
	})

	it('lets caller cancellation stop readiness and reconciles the known ARM name', async () => {
		const observed = stubClaim()
		const caller = new AbortController()
		const pending = backend(100).create({
			workingDirectory: '/workspace',
			signal: caller.signal,
		})
		while (!observed.healthSignal()) await new Promise((resolve) => setTimeout(resolve, 0))
		const reason = new Error('operator stopped standby allocation')
		caller.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(observed.healthSignal()?.aborted).toBe(true)
		expect(observed.healthSignal()?.reason).toBe(reason)
		expect(observed.deleteCalls()).toBe(1)
	})

	it('passes teardown authority to a held ARM DELETE', async () => {
		const observed = stubClaim({ ready: true, holdDelete: true, deleteSafetyMs: 100 })
		const sandbox = await backend().create({ workingDirectory: '/workspace' })
		const owner = new AbortController()
		const pending = Promise.all([
			sandbox.destroy({ signal: owner.signal }),
			sandbox.destroy({ signal: owner.signal }),
		])
		while (observed.deleteCalls() === 0) await new Promise((resolve) => setTimeout(resolve, 0))
		const reason = new Error('teardown deadline')
		owner.abort(reason)

		await expect(pending).rejects.toBe(reason)
		expect(observed.deleteSignal()?.reason).toBe(reason)
		expect(observed.deleteCalls()).toBe(1)
	})

	it('validates readiness before requesting a token or contacting ARM', () => {
		const getArmToken = vi.fn(async () => 'token')
		expect(() =>
			buildAciStandbyPoolBackend({
				subscriptionId: 'sub',
				resourceGroup: 'rg',
				location: 'westeurope',
				standbyPoolResourceId: '/pools/p',
				containerGroupProfileResourceId: '/profiles/p',
				layout,
				getArmToken,
				subnetId: '/subnets/private',
				readyTimeoutMs: 0,
			}),
		).toThrow(/aci-standby-pool\.readyTimeoutMs/)
		expect(getArmToken).not.toHaveBeenCalled()
	})
})
