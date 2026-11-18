import { describe, expect, it, vi } from 'vitest'
import type { UserMcpServersView } from '../shared/config-lists-protocol.js'
import { UserMcpServers } from './user-mcp-servers.js'

const empty: UserMcpServersView = { file: '/h/config.yaml', servers: [] }
const withNotes: UserMcpServersView = {
	file: '/h/config.yaml',
	servers: [{ name: 'notes', kind: 'command', command: 'run', args: ['a'] }],
}

function build(view: UserMcpServersView = empty) {
	const save = vi.fn(async (_change: unknown, _dryRun: boolean) => view)
	const remove = vi.fn(async () => empty)
	return {
		save,
		remove,
		servers: new UserMcpServers({
			read: async () => view,
			readOne: async (name) => view.servers.find((server) => server.name === name),
			save,
			remove,
		}),
	}
}

describe('saving a tool server', () => {
	it('asks first when it runs a command, and writes nothing until the same change returns with the token', async () => {
		const { servers, save } = build()
		const change = { mode: 'add', name: 'notes', command: 'npx', args: ['-y', 'pkg'] }
		const first = await servers.save('w1', change)
		expect(first.status).toBe('confirm')
		if (first.status !== 'confirm') return
		expect(first.message).toBe('This server starts npx -y pkg when a conversation starts.')
		// The engine was asked whether it would take the change, and wrote nothing.
		expect(save).toHaveBeenCalledTimes(1)
		expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'notes' }), true)
		expect((await servers.save('w1', change, first.token)).status).toBe('saved')
		expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'notes' }), false)
	})

	it('binds the token to the window and the exact change, once', async () => {
		const { servers, save } = build()
		const change = { mode: 'add', name: 'notes', command: 'npx' }
		const first = await servers.save('w1', change)
		if (first.status !== 'confirm') throw new Error('expected a question')
		await expect(servers.save('w2', change, first.token)).rejects.toThrow(/expired/)
		await expect(servers.save('w1', { ...change, command: 'other' }, first.token)).rejects.toThrow(
			/expired/,
		)
		expect(save.mock.calls.every(([, dry]) => dry === true)).toBe(true)
		const again = await servers.save('w1', change)
		if (again.status !== 'confirm') throw new Error('expected a question')
		await servers.save('w1', change, again.token)
		await expect(servers.save('w1', change, again.token)).rejects.toThrow(/expired/)
	})

	it('never asks for an address, or for an edit that leaves the command as it is', async () => {
		const { servers, save } = build()
		expect(
			(await servers.save('w1', { mode: 'add', name: 'r', url: 'https://e.com' })).status,
		).toBe('saved')
		const kept = build(withNotes)
		expect(
			(await kept.servers.save('w1', { mode: 'edit', name: 'notes', command: 'run', args: ['a'] }))
				.status,
		).toBe('saved')
		const changed = build(withNotes)
		expect(
			(await changed.servers.save('w1', { mode: 'edit', name: 'notes', command: 'other' })).status,
		).toBe('confirm')
		expect(save).toHaveBeenCalledTimes(1)
	})

	it('shows a change the engine refuses as its own sentence, with no question and no write', async () => {
		const { servers, save } = build()
		save.mockRejectedValueOnce(new Error('Give a command or an address.'))
		await expect(servers.save('w1', { mode: 'add', name: 'n', command: 'x' })).rejects.toThrow(
			'Give a command or an address.',
		)
	})

	it('refuses a request that is not a tool server change', async () => {
		const { servers } = build()
		await expect(servers.save('w1', { mode: 'wipe' })).rejects.toThrow()
		await expect(servers.save('w1', { mode: 'add', name: 'n', command: 'x' }, 5)).rejects.toThrow(
			'Invalid confirmation.',
		)
	})
})

describe('removing a tool server', () => {
	it('removes by name and refuses anything else', async () => {
		const { servers, remove } = build(withNotes)
		await servers.remove('notes')
		expect(remove).toHaveBeenCalledWith('notes')
		await expect(servers.remove(3)).rejects.toThrow()
		await expect(servers.remove('')).rejects.toThrow()
		await expect(servers.remove('x'.repeat(65))).rejects.toThrow()
	})
})
