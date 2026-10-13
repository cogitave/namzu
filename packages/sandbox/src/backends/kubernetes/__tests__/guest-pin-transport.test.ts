import { afterEach, describe, expect, it } from 'vitest'
import { KubernetesAgentTransport } from '../transport.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const agents: ScriptedAgent[] = []
afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.close()
})

describe('an immutable guest transport', () => {
	it('checks the replacement wire before retrying idle against an older agent', async () => {
		const first = await startScriptedAgent({
			token: 'first',
			features: ['quiesce', 'quiesce-idle'],
		})
		const old = await startScriptedAgent({
			token: 'old',
			features: ['quiesce'],
			quiesceReply: { ok: true },
		})
		agents.push(first, old)
		let refreshes = 0
		const transport = new KubernetesAgentTransport(
			{ kind: 'tcp', host: '127.0.0.1', port: first.port, token: 'wrong' },
			{
				refreshHandle: async () => {
					refreshes++
					return { kind: 'tcp', host: '127.0.0.1', port: old.port, token: 'old' }
				},
			},
		)
		const options = { onlyIfIdle: true }
		const running = transport.quiesce(options)
		options.onlyIfIdle = false
		await expect(running).rejects.toMatchObject({ feature: 'quiesce-idle' })
		expect(refreshes).toBe(1)
		expect(old.requests.some((request) => request.op === 'quiesce')).toBe(false)
	})

	it('checks idle on the pinned guest and never follows a replacement', async () => {
		const agent = await startScriptedAgent({
			token: 'first-pod',
			guestBootId: 'first-boot',
			guestBound: true,
			features: ['quiesce', 'quiesce-idle'],
			quiesceReply: {
				ok: true,
				idle: true,
				scope: 'pid-namespace',
				rounds: 0,
				stopped: [],
				graceMs: 1000,
			},
		})
		agents.push(agent)
		let refreshes = 0
		const transport = new KubernetesAgentTransport(
			{
				kind: 'tcp',
				host: '127.0.0.1',
				port: agent.port,
				token: 'first-pod',
			},
			{
				refreshHandle: async () => {
					refreshes++
					return { kind: 'tcp', host: '127.0.0.1', port: agent.port, token: 'second-pod' }
				},
			},
		)
		const pinned = transport.pinGuest('first-boot')
		expect((await pinned.quiesce({ onlyIfIdle: true })).stopped).toEqual([])
		agent.setToken('second-pod')
		agent.setGuestBootId('second-boot')
		await expect(pinned.quiesce({ onlyIfIdle: true })).rejects.toThrow()
		expect(refreshes).toBe(0)
		const requests = agent.requests.filter((request) => request.op === 'guest-bound')
		expect(requests).toHaveLength(2)
		expect(requests[0]?.request).toEqual({ op: 'quiesce', body: { onlyIfIdle: true } })
		expect(requests.every((request) => request.guestBootId === 'first-boot')).toBe(true)
	})

	it('does not rebind a pinned mutation while an ordinary call can follow the pod', async () => {
		const agent = await startScriptedAgent({
			token: 'first-pod',
			guestBootId: 'first-boot',
			guestBound: true,
		})
		agents.push(agent)
		let refreshes = 0
		const address = {
			kind: 'tcp' as const,
			host: '127.0.0.1',
			port: agent.port,
			token: 'first-pod',
		}
		const transport = new KubernetesAgentTransport(address, {
			refreshHandle: async () => {
				refreshes++
				return { ...address, token: 'second-pod' }
			},
		})
		const pinned = transport.pinGuest('first-boot')
		await pinned.writeFile('/workspace/note', Buffer.from('first'))
		agent.setToken('second-pod')
		agent.setGuestBootId('second-boot')
		const results = await Promise.allSettled([
			pinned.writeFile('/workspace/refused', Buffer.from('old')),
			transport.writeFile('/workspace/ordinary', Buffer.from('new')),
		])
		expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled'])
		expect(refreshes).toBe(1)
		const guarded = agent.requests.filter((request) => request.op === 'guest-bound')
		expect(guarded).toHaveLength(2)
		expect(
			guarded.every(
				(request) => request.token === 'first-pod' && request.guestBootId === 'first-boot',
			),
		).toBe(true)
		await expect(pinned.writeFile('/workspace/still-refused', Buffer.from('old'))).rejects.toThrow()
		expect(refreshes).toBe(1)
	})

	it('never falls back to an ordinary operation on an older agent', async () => {
		const agent = await startScriptedAgent({ token: 'pod', guestBootId: 'boot' })
		agents.push(agent)
		const pinned = new KubernetesAgentTransport({
			kind: 'tcp',
			host: '127.0.0.1',
			port: agent.port,
			token: 'pod',
		}).pinGuest('boot')
		await expect(pinned.writeFile('/workspace/refused', Buffer.from('old'))).rejects.toThrow(
			'unknown_op',
		)
		expect(agent.requests.map((request) => request.op)).toEqual(['guest-bound'])
	})
})
