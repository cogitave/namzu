import { expect, it } from 'vitest'
import { type LivePeers, buildPeerTools } from './runtime.js'

const rows = [
	{ machine: 'studio', name: 'calm-heron', ref: 'aaaaaa', self: true },
	{ machine: 'studio', name: 'quiet-owl', ref: 'bbbbbb', self: false },
	{ machine: 'desk', name: 'red-fox', ref: 'cccccc', self: false },
]

function run(target: string) {
	const calls: string[] = []
	const peers = {
		list: async () => rows,
		setRole: async (t: string) => {
			calls.push(t)
			return { status: 'applied' as const }
		},
	} as unknown as LivePeers
	const tool = buildPeerTools(() => peers).find((t) => t.name === 'set_session_role')
	if (!tool) throw new Error('no tool')
	const context = { abortSignal: new AbortController().signal } as never
	return tool
		.execute({ target, role: 'orchestrator' } as never, context)
		.then((result) => ({ result, calls }))
}

it('sets a role on a session or the machine here, and never on another machine', async () => {
	for (const target of ['quiet-owl', 'studio/quiet-owl', 'studio/']) {
		const { result, calls } = await run(target)
		expect(result.success).toBe(true)
		expect(calls).toEqual([target])
	}
	for (const target of ['red-fox', 'desk/red-fox', 'desk/', 'nobody']) {
		const { result, calls } = await run(target)
		expect(result.success).toBe(false)
		expect(calls).toEqual([])
	}
})
