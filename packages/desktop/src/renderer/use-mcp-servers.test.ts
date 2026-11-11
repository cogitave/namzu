import { describe, expect, it } from 'vitest'
import type { McpServersView } from '../shared/protocol.js'
import { type McpServersRead, McpServersReader, readFor } from './use-mcp-servers.js'

const viewOf = (name: string): McpServersView => ({
	servers: [{ name, origin: 'your-config', state: 'connected' }],
})
const later = <T>() => {
	let resolve!: (value: T) => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const settle = () => new Promise<void>((done) => setImmediate(done))

function harness(read: (id: string) => Promise<McpServersView | null>) {
	const seen: McpServersRead[] = []
	const reader = new McpServersReader(read, (next) => seen.push(next))
	return { reader, seen, last: () => seen[seen.length - 1] as McpServersRead }
}

describe('the tool server list for the project in front', () => {
	it('never shows another project’s servers under this project when its read fails or says nothing', async () => {
		const answers = new Map<string, Promise<McpServersView | null>>()
		const { reader, last } = harness((id) => answers.get(id) ?? Promise.resolve(null))
		answers.set('a', Promise.resolve(viewOf('from-a')))
		reader.load('a')
		await settle()
		expect(last().view?.servers[0]?.name).toBe('from-a')

		answers.set('b', Promise.reject(new Error('gone')))
		reader.load('b')
		expect(last()).toEqual({ projectId: 'b', loading: true })
		await settle()
		expect(last().view).toBeUndefined()
		expect(last().error).toBeTruthy()
		// What the screen derives for b is b's read only; a's never leaks through.
		expect(readFor(last(), 'a')).toBeUndefined()

		const never = later<McpServersView | null>()
		answers.set('c', never.promise)
		reader.load('c')
		expect(last()).toEqual({ projectId: 'c', loading: true })
	})

	it('reads the same project again without blanking it, and only the newest read answers', async () => {
		const first = later<McpServersView | null>()
		const second = later<McpServersView | null>()
		const queue = [first, second]
		const { reader, last } = harness(() => (queue.shift() as typeof first).promise)
		reader.load('a')
		first.resolve(viewOf('one'))
		await settle()
		reader.load('a')
		expect(last()).toMatchObject({ loading: true, view: viewOf('one') })
		second.resolve(viewOf('two'))
		await settle()
		expect(last().view).toEqual(viewOf('two'))
		expect(last().loading).toBe(false)
	})

	it('ignores a slow answer for a project that is no longer in front', async () => {
		const slow = later<McpServersView | null>()
		const { reader, last } = harness((id) =>
			id === 'a' ? slow.promise : Promise.resolve(viewOf('from-b')),
		)
		reader.load('a')
		reader.load('b')
		await settle()
		slow.resolve(viewOf('from-a'))
		await settle()
		expect(last().projectId).toBe('b')
		expect(last().view).toEqual(viewOf('from-b'))
	})
})
