import { afterEach, describe, expect, it } from 'vitest'
import { KubernetesAgentTransport } from '../transport.js'
import { type ScriptedAgent, startScriptedAgent } from './fixtures/scripted-agent.js'

const agents: ScriptedAgent[] = []
afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.close()
})

describe('an immutable guest transport', () => {
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
