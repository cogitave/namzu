import { Toast, type ToastObject } from '@base-ui/react/toast'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The provider's store is not a public export; its timers are what a toast's lifetime is made of.
import { ToastStore } from '../../node_modules/@base-ui/react/esm/toast/store.js'
import { type ToastSink, createToastHub, defaultTimeoutMs } from './notify.js'
import { undoNotice, undoneFileCount } from './undo-model.js'

function recordingSink() {
	const added: Parameters<ToastSink['add']>[0][] = []
	const closed: (string | undefined)[] = []
	const leaving = new Map<string, () => void>()
	const sink: ToastSink = {
		add: (options) => {
			added.push(options)
			if (options.onClose) leaving.set(options.id, options.onClose)
			return options.id
		},
		close: (id) => void closed.push(id),
	}
	/** The toast's time is up, or the person dismissed it. */
	const leave = (id: string) => leaving.get(id)?.()
	return { sink, added, closed, leave }
}

describe('notify routing', () => {
	describe('errors are not closed by a newer notice', () => {
		it('does not close an error sent before any pane existed', () => {
			const hub = createToastHub()
			hub.notify("Couldn't save.", { tone: 'error' })
			hub.notify('Copied.')
			const { sink, added, closed, leave } = recordingSink()
			hub.register(sink)
			expect(added.map((item) => item.title)).toEqual(["Couldn't save."])
			expect(closed).toEqual([])
			leave(added[0]?.id ?? '')
			expect(added.map((item) => item.title)).toEqual(["Couldn't save.", 'Copied.'])
		})

		it('holds an info notice until the error has left', () => {
			const hub = createToastHub()
			const { sink, added, closed, leave } = recordingSink()
			hub.register(sink)
			const error = hub.notify("Couldn't save.", { tone: 'error' })
			hub.notify('Copied.')
			expect(added.map((item) => item.title)).toEqual(["Couldn't save."])
			expect(closed).toEqual([])
			leave(error)
			expect(added.map((item) => item.title)).toEqual(["Couldn't save.", 'Copied.'])
		})

		it('queues a second error behind the first and ahead of info', () => {
			const hub = createToastHub()
			const { sink, added, leave } = recordingSink()
			hub.register(sink)
			const first = hub.notify('First problem.', { tone: 'error' })
			hub.notify('Copied.')
			hub.notify('Second problem.', { tone: 'error' })
			expect(added).toHaveLength(1)
			leave(first)
			expect(added.map((item) => item.title)).toEqual(['First problem.', 'Second problem.'])
			leave(added[1]?.id ?? '')
			expect(added.map((item) => item.title)).toEqual([
				'First problem.',
				'Second problem.',
				'Copied.',
			])
		})

		it('keeps only the newest of several waiting info notices', () => {
			const hub = createToastHub()
			const { sink, added, leave } = recordingSink()
			hub.register(sink)
			const error = hub.notify('Problem.', { tone: 'error' })
			hub.notify('one')
			hub.notify('two')
			leave(error)
			expect(added.map((item) => item.title)).toEqual(['Problem.', 'two'])
		})

		it('shows an error at once over an info notice', () => {
			const hub = createToastHub()
			const { sink, added, closed } = recordingSink()
			hub.register(sink)
			const info = hub.notify('Copied.')
			hub.notify('Problem.', { tone: 'error' })
			expect(closed).toEqual([info])
			expect(added.map((item) => item.title)).toEqual(['Copied.', 'Problem.'])
		})

		it('does not repeat the same words, on screen or waiting', () => {
			const hub = createToastHub()
			const { sink, added, leave } = recordingSink()
			hub.register(sink)
			const first = hub.notify('Problem.', { tone: 'error' })
			expect(hub.notify('Problem.', { tone: 'error' })).toBe(first)
			hub.notify('Other problem.', { tone: 'error' })
			hub.notify('Other problem.', { tone: 'error' })
			leave(first)
			leave(added[1]?.id ?? '')
			expect(added.map((item) => item.title)).toEqual(['Problem.', 'Other problem.'])
		})

		it('lets a dismissed waiting notice go', () => {
			const hub = createToastHub()
			const { sink, added, leave } = recordingSink()
			hub.register(sink)
			const error = hub.notify('Problem.', { tone: 'error' })
			const info = hub.notify('Copied.')
			hub.dismiss(info)
			leave(error)
			expect(added.map((item) => item.title)).toEqual(['Problem.'])
		})
	})

	it('maps tone to type, priority and lifetime', () => {
		const hub = createToastHub()
		const { sink, added, leave } = recordingSink()
		hub.register(sink)
		hub.notify('Saved.')
		const error = hub.notify('Could not copy.', { tone: 'error' })
		hub.notify('Check this.', { tone: 'warning', timeoutMs: 0 })
		leave(error)
		expect(added.map((item) => [item.title, item.type, item.priority, item.timeout])).toEqual([
			['Saved.', 'neutral', 'low', 4000],
			['Could not copy.', 'error', 'high', 8000],
			['Check this.', 'warning', 'low', 0],
		])
		expect(defaultTimeoutMs('neutral', true)).toBe(8000)
	})

	it('queues notices sent before a pane exists and drops the oldest past the cap', () => {
		const hub = createToastHub()
		for (let index = 1; index <= 7; index++) hub.notify(`n${index}`)
		const { sink, added } = recordingSink()
		hub.register(sink)
		expect(added.map((item) => item.title)).toEqual(['n3', 'n4', 'n5', 'n6', 'n7'])
	})

	it('closes the earlier notice when a later one arrives, on whichever pane showed it', () => {
		const hub = createToastHub()
		const first = recordingSink()
		const second = recordingSink()
		hub.register(first.sink)
		const two = hub.register(second.sink)
		const a = hub.notify('a')
		two.focus()
		hub.notify('b')
		expect(first.closed).toEqual([a])
	})

	it('runs the action, then closes its toast', () => {
		const hub = createToastHub()
		const { sink, added, closed } = recordingSink()
		hub.register(sink)
		const onClick = vi.fn()
		const id = hub.notify('Archived.', { action: { label: 'Undo', onClick } })
		const props = added[0]?.actionProps
		expect(props?.children).toBe('Undo')
		props?.onClick()
		expect(onClick).toHaveBeenCalledOnce()
		expect(closed).toEqual([id])
	})

	it('still closes the toast when the action throws', () => {
		const hub = createToastHub()
		const { sink, added, closed } = recordingSink()
		hub.register(sink)
		const id = hub.notify('x', {
			action: {
				label: 'Undo',
				onClick: () => {
					throw new Error('boom')
				},
			},
		})
		expect(() => added[0]?.actionProps?.onClick()).toThrow('boom')
		expect(closed).toEqual([id])
	})

	it('sends notices to the pane focused last and falls back when it leaves', () => {
		const hub = createToastHub()
		const first = recordingSink()
		const second = recordingSink()
		const one = hub.register(first.sink)
		const two = hub.register(second.sink)
		hub.notify('a')
		two.focus()
		hub.notify('b')
		one.focus()
		hub.notify('c')
		one.dispose()
		hub.notify('d')
		expect(first.added.map((item) => item.title)).toEqual(['a', 'c'])
		expect(second.added.map((item) => item.title)).toEqual(['b', 'd'])
	})

	it('dismisses a shown toast on its own pane and forgets a waiting one', () => {
		const hub = createToastHub()
		const waiting = hub.notify('later')
		hub.dismiss(waiting)
		const { sink, added, closed } = recordingSink()
		hub.register(sink)
		expect(added).toEqual([])
		const id = hub.notify('now')
		hub.dismiss(id)
		expect(closed).toEqual([id])
	})
})

describe('lifetime in the real Base UI store', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		// The store asks the document for its focused element when a toast closes; no viewport is mounted here.
		vi.stubGlobal('document', { activeElement: null })
	})
	afterEach(() => {
		vi.unstubAllGlobals()
		vi.useRealTimers()
	})

	// Mirrors how ToastProvider wires a manager to its store.
	function paneStore(limit = 3) {
		const manager = Toast.createToastManager()
		const store = new ToastStore({
			timeout: 5000,
			limit,
			viewport: null,
			toasts: [],
			hovering: false,
			focused: false,
			isWindowFocused: true,
			prevFocusElement: null,
		})
		manager[' subscribe'](({ action, options }) => {
			if (action === 'close') store.closeToast(options.id)
			else store.addToast(options)
		})
		// The store's state type is not reachable from its public typings.
		const toasts = () =>
			(store as unknown as { state: { toasts: ToastObject<object>[] } }).state.toasts
		const live = () => toasts().filter((item) => item.transitionStatus !== 'ending')
		return { manager, store, live, toasts }
	}

	it('shows one toast at a time: a newer notice replaces the one on screen', () => {
		const hub = createToastHub()
		const { manager, live } = paneStore()
		hub.register(manager)
		hub.notify('first')
		vi.advanceTimersByTime(1000)
		hub.notify('second')
		hub.notify('third', { tone: 'error' })
		expect(live().map((item) => item.title)).toEqual(['third'])
		// The error lasts 8 s on its own timeout.
		vi.advanceTimersByTime(7999)
		expect(live().map((item) => item.title)).toEqual(['third'])
		vi.advanceTimersByTime(1)
		expect(live()).toEqual([])
	})

	it('keeps a toast with timeoutMs 0 until it is dismissed', () => {
		const hub = createToastHub()
		const { manager, live } = paneStore()
		hub.register(manager)
		const id = hub.notify('stay', { timeoutMs: 0 })
		vi.advanceTimersByTime(600_000)
		expect(live().map((item) => item.title)).toEqual(['stay'])
		hub.dismiss(id)
		expect(live()).toEqual([])
	})

	it('pauses the timers while the pointer or focus is on the stack', () => {
		const hub = createToastHub()
		const { manager, store, live } = paneStore()
		hub.register(manager)
		hub.notify('hold')
		vi.advanceTimersByTime(3000)
		// The viewport does exactly this on pointer-enter and on focus-in.
		store.setHovering(true)
		store.pauseTimers()
		vi.advanceTimersByTime(60_000)
		expect(live()).toHaveLength(1)
		store.setHovering(false)
		store.resumeTimers()
		vi.advanceTimersByTime(999)
		expect(live()).toHaveLength(1)
		vi.advanceTimersByTime(1)
		expect(live()).toEqual([])
	})

	it('closes a toast whose action was taken', () => {
		const hub = createToastHub()
		const { manager, live, toasts } = paneStore()
		hub.register(manager)
		const onClick = vi.fn()
		hub.notify('Pinned.', { action: { label: 'Undo', onClick } })
		const props = toasts()[0]?.actionProps
		props?.onClick?.({} as never)
		expect(onClick).toHaveBeenCalledOnce()
		expect(live()).toEqual([])
	})
})

describe('undoneFileCount', () => {
	it('counts files written to disk, including later replies', () => {
		expect(
			undoneFileCount({
				turnId: 't',
				status: 'partially_undone',
				files: { a: 'restored', b: 'removed', c: 'skipped', d: 'noop', e: 'failed' },
				later: { t2: { f: 'restored', g: 'skipped' } },
			}),
		).toBe(3)
	})
})

describe('undoNotice', () => {
	it('never reports zero changed files as a success', () => {
		expect(undoNotice({ turnId: 't', status: 'undone', files: { a: 'skipped' } })).toEqual({
			text: 'No files were changed.',
			tone: 'warning',
		})
		expect(undoNotice({ turnId: 't', status: 'undone', files: { a: 'restored' } }).text).toBe(
			'Undid changes to 1 file.',
		)
	})
})
