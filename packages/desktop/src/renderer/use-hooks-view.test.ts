import { describe, expect, it } from 'vitest'
import { type HooksReport, readHooksReport } from '../shared/hooks-report.js'
import type { HooksView } from '../shared/protocol.js'
import { type HooksRead, HooksReader, hooksReadFor, readKey } from './use-hooks-view.js'

const viewOf = (path: string, own = false): HooksView => ({
	own,
	report: readHooksReport({
		version: 1,
		folder: { path, trusted: true },
		hooks: [],
	}) as HooksReport,
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

function harness(ask: (id: string | undefined) => Promise<HooksView | null>) {
	const seen: HooksRead[] = []
	const reader = new HooksReader(ask, (next) => seen.push(next))
	return { reader, last: () => seen[seen.length - 1] as HooksRead }
}

describe('the hooks of the project in front', () => {
	it('keys a read by its project, or by the person’s own settings when none is open', () => {
		expect(readKey('a')).toBe('a')
		expect(readKey(undefined)).toBe('own')
	})

	it('never shows another project’s hooks under this project, and says so when the engine cannot answer', async () => {
		const answers = new Map<string, Promise<HooksView | null>>()
		const { reader, last } = harness((id) => answers.get(id ?? 'own') ?? Promise.resolve(null))
		answers.set('a', Promise.resolve(viewOf('/a')))
		reader.load('a')
		await settle()
		expect(last().view?.report.folder.path).toBe('/a')

		const gone = later<HooksView | null>()
		answers.set('b', gone.promise)
		reader.load('b')
		gone.reject(new Error('gone'))
		expect(last()).toEqual({ key: 'b', loading: true })
		await settle()
		expect(last().view).toBeUndefined()
		expect(last().error).toBeTruthy()
		expect(hooksReadFor(last(), 'a')).toBeUndefined()

		answers.set('c', Promise.resolve(null))
		reader.load('c')
		await settle()
		expect(last()).toEqual({ key: 'c', loading: false, unsupported: true })
	})

	it('reads the same project again without blanking it, and only the newest read answers', async () => {
		const first = later<HooksView | null>()
		const second = later<HooksView | null>()
		const queue = [first, second]
		const { reader, last } = harness(() => (queue.shift() as typeof first).promise)
		reader.load('a')
		first.resolve(viewOf('/one'))
		await settle()
		reader.load('a')
		expect(last()).toMatchObject({ loading: true, view: viewOf('/one') })
		second.resolve(viewOf('/two'))
		await settle()
		expect(last().view?.report.folder.path).toBe('/two')

		const slow = later<HooksView | null>()
		const fast = later<HooksView | null>()
		const order = [slow, fast]
		const second2 = harness(() => (order.shift() as typeof slow).promise)
		second2.reader.load('a')
		second2.reader.load('a')
		fast.resolve(viewOf('/fast'))
		await settle()
		slow.resolve(viewOf('/slow'))
		await settle()
		expect(second2.last().view?.report.folder.path).toBe('/fast')
	})

	it('keeps what was shown when a later read of the same project fails', async () => {
		const answers = [() => Promise.resolve(viewOf('/a')), () => Promise.reject(new Error('down'))]
		const { reader, last } = harness(() => (answers.shift() as () => Promise<HooksView | null>)())
		reader.load('a')
		await settle()
		reader.load('a')
		await settle()
		expect(last().view?.report.folder.path).toBe('/a')
		expect(last().error).toBeTruthy()
	})
})
