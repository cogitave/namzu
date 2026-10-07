import { Toast, type ToastObject } from '@base-ui/react/toast'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// The provider's store is not a public export; its timers are what a toast's lifetime is made of.
import { ToastStore } from '../../node_modules/@base-ui/react/esm/toast/store.js'
import { type ToastSink, createToastHub, defaultTimeoutMs } from './notify.js'
import { undoNotice, undoneFileCount } from './undo-model.js'

function recordingSink() {
	const added: Parameters<ToastSink['add']>[0][] = []
	const closed: (string | undefined)[] = []
	const sink: ToastSink = {
		add: (options) => {
			added.push(options)
			return options.id
		},
		close: (id) => void closed.push(id),
	}
	return { sink, added, closed }
}

describe('notify routing', () => {
	it('maps tone to type, priority and lifetime', () => {
		const hub = createToastHub()
		const { sink, added } = recordingSink()
		hub.register(sink)
		hub.notify('Saved.')
		hub.notify('Could not copy.', { tone: 'error' })
		hub.notify('Check this.', { tone: 'warning', timeoutMs: 0 })
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

	it('keeps several toasts and lets each one go on its own timeout', () => {
		const hub = createToastHub()
		const { manager, live } = paneStore()
		hub.register(manager)
		hub.notify('first')
		vi.advanceTimersByTime(1000)
		hub.notify('second')
		hub.notify('third', { tone: 'error' })
		expect(live().map((item) => item.title)).toEqual(['third', 'second', 'first'])
		// 4 s toasts: the first is gone at t=4000, the second at t=5000; the error lasts 8 s.
		vi.advanceTimersByTime(3000)
		expect(live().map((item) => item.title)).toEqual(['third', 'second'])
		vi.advanceTimersByTime(1000)
		expect(live().map((item) => item.title)).toEqual(['third'])
		vi.advanceTimersByTime(3999)
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

	it('marks the oldest toast limited past the stack limit', () => {
		const hub = createToastHub()
		const { manager, toasts } = paneStore(2)
		hub.register(manager)
		for (const text of ['a', 'b', 'c']) hub.notify(text)
		expect(toasts().map((item) => [item.title, item.limited])).toEqual([
			['c', false],
			['b', false],
			['a', true],
		])
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
