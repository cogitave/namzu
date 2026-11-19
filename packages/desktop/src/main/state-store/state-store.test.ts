import { describe, expect, it } from 'vitest'
import { STATE_KEYS, defineOf } from '../../shared/state-registry.js'
import { STATE_FILE_VERSION } from './migrate.js'
import { DEBOUNCE_MS, type StateFs, StateStore } from './store.js'
import {
	type ModeWindow,
	applyWindowMode,
	captureWindowMode,
	readWindowMode,
	writeWindowMode,
} from './window-mode.js'

const FILE = '/data/view-state.json'

/** A disk in memory that can be told to fail between the temporary write and the rename. */
function fakeDisk() {
	const files = new Map<string, string>()
	const disk = {
		files,
		failRename: false,
		renames: 0,
		fs: {
			read: (file) => files.get(file),
			write: (file, text) => {
				files.set(file, text)
			},
			rename: (from, to) => {
				disk.renames += 1
				if (disk.failRename) throw new Error('disk full')
				const text = files.get(from)
				if (text === undefined) throw new Error('missing')
				files.delete(from)
				files.set(to, text)
			},
			mkdirp: () => {},
		} satisfies StateFs,
	}
	return disk
}

/** A scheduler that runs nothing until the test says so: no real time passes in these tests. */
function fakeClock() {
	let now = 1_000
	const pending: { run: () => void; ms: number; cancelled: boolean }[] = []
	return {
		now: () => now,
		advance: (ms: number) => {
			now += ms
		},
		schedule: (run: () => void, ms: number) => {
			const item = { run, ms, cancelled: false }
			pending.push(item)
			return () => {
				item.cancelled = true
			}
		},
		pending: () => pending.filter((item) => !item.cancelled),
		fire: () => {
			for (const item of pending.splice(0)) if (!item.cancelled) item.run()
		},
	}
}

function open(disk: ReturnType<typeof fakeDisk>, clock = fakeClock(), errors: unknown[] = []) {
	const store = new StateStore({
		file: FILE,
		fs: disk.fs,
		now: clock.now,
		schedule: clock.schedule,
		onError: (error) => errors.push(error),
	})
	return { store, clock, errors }
}

const onDisk = (disk: ReturnType<typeof fakeDisk>) => JSON.parse(disk.files.get(FILE) ?? 'null')

describe('the registry', () => {
	it('knows the keys the renderer used and refuses the rest', () => {
		expect(defineOf('namzu.sidebar-collapsed')?.id).toBe('ui.sidebar.collapsed')
		expect(defineOf('namzu.panes.1.group-a')?.id).toBe('ui.panes')
		expect(defineOf('namzu.workspace.presentation:abc')?.scope).toBe('conversation')
		expect(defineOf('namzu.terminal.debug')).toBeUndefined()
		expect(defineOf('api-token')).toBeUndefined()
		expect(defineOf('')).toBeUndefined()
	})

	it('gives every key a unique id, a positive cap and a way to match', () => {
		const ids = STATE_KEYS.map((def) => def.id)
		expect(new Set(ids).size).toBe(ids.length)
		for (const def of STATE_KEYS) expect(def.maxBytes).toBeGreaterThan(0)
	})
})

describe('writing', () => {
	it('keeps a value in memory at once and writes it to disk after the debounce, atomically', () => {
		const disk = fakeDisk()
		const { store, clock } = open(disk)
		expect(store.set('namzu.surface', 'cli')).toBe('ok')
		expect(store.get('namzu.surface')).toBe('cli')
		expect(onDisk(disk).entries['namzu.surface']).toBeUndefined()
		expect(clock.pending()).toHaveLength(1)
		expect(clock.pending()[0]?.ms).toBe(DEBOUNCE_MS)
		clock.fire()
		expect(onDisk(disk).entries['namzu.surface'].v).toBe('cli')
		expect([...disk.files.keys()]).toEqual([FILE])
	})

	it('batches a burst of writes into one disk write', () => {
		const disk = fakeDisk()
		const { store, clock } = open(disk)
		const before = disk.renames
		for (const value of ['a', 'b', 'c']) store.set('namzu.surface', value)
		expect(clock.pending()).toHaveLength(1)
		clock.fire()
		expect(disk.renames - before).toBe(1)
		expect(onDisk(disk).entries['namzu.surface'].v).toBe('c')
	})

	it('refuses an unknown key and a value over its cap, and never cuts a value', () => {
		const disk = fakeDisk()
		const { store, errors } = open(disk)
		expect(store.set('namzu.unknown', 'x')).toBe('unknown-key')
		expect(store.set('namzu.surface', 'x'.repeat(100))).toBe('too-large')
		expect(store.get('namzu.surface')).toBeUndefined()
		expect(errors).toHaveLength(1)
	})

	it('leaves the old file whole when the rename fails, and keeps the value for the next try', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.surface', 'cli')
		first.store.flush()
		const good = disk.files.get(FILE)
		disk.failRename = true
		const second = open(disk)
		second.store.set('namzu.surface', 'desktop')
		second.store.flush()
		expect(second.errors.length).toBeGreaterThan(0)
		expect(disk.files.get(FILE)).toBe(good)
		expect(second.store.get('namzu.surface')).toBe('desktop')
		disk.failRename = false
		second.store.flush()
		expect(onDisk(disk).entries['namzu.surface'].v).toBe('desktop')
	})

	it('drops the oldest entries of a family past its cap, never the one just written', () => {
		const disk = fakeDisk()
		const { store, clock } = open(disk)
		const cap = defineOf('namzu.workspace.panel-width:a')?.maxEntries ?? 0
		expect(cap).toBeGreaterThan(0)
		for (let index = 0; index <= cap; index++) {
			store.set(`namzu.workspace.panel-width:pane${index}`, '400')
			clock.advance(1)
		}
		expect(store.get('namzu.workspace.panel-width:pane0')).toBeUndefined()
		expect(store.get(`namzu.workspace.panel-width:pane${cap}`)).toBe('400')
		expect(Object.keys(store.snapshot())).toHaveLength(cap)
	})
})

describe('how the last run ended', () => {
	it('calls a first start a first run and writes that the run is not over', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		expect(store.closeState).toBe('first-run')
		expect(onDisk(disk).cleanShutdown).toBe(false)
		expect(onDisk(disk).version).toBe(STATE_FILE_VERSION)
	})

	it('restores everything after a quit that flushed', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.sidebar-collapsed', 'true')
		first.store.set('namzu.workspace.presentation:abc', '{"panelTab":"changes"}')
		first.store.markCleanShutdown()
		expect(onDisk(disk).cleanShutdown).toBe(true)
		const second = open(disk)
		expect(second.store.closeState).toBe('clean')
		expect(second.store.get('namzu.sidebar-collapsed')).toBe('true')
		expect(second.store.get('namzu.workspace.presentation:abc')).toBe('{"panelTab":"changes"}')
	})

	it('keeps the clean marker when a window writes after the quit has been recorded', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.workspace.presentation:abc', '{"panelTab":"changes"}')
		first.store.markCleanShutdown()
		// A window still alive writes: a debounced flush must not undo the marker.
		first.store.set('namzu.sidebar-collapsed', 'true')
		first.store.remove('namzu.workspace.presentation:abc')
		first.clock.fire()
		first.store.flush()
		expect(onDisk(disk).cleanShutdown).toBe(true)
		const second = open(disk)
		expect(second.store.closeState).toBe('clean')
		expect(second.store.get('namzu.sidebar-collapsed')).toBe('true')
	})

	it('restores the last checkpoint after a crash, but starts soft keys over', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.sidebar-collapsed', 'true')
		first.store.set('namzu.workspace.presentation:abc', '{"panelTab":"changes"}')
		first.store.flush()
		// No markCleanShutdown: the process was killed.
		const second = open(disk)
		expect(second.store.closeState).toBe('crash')
		expect(second.store.get('namzu.sidebar-collapsed')).toBe('true')
		expect(second.store.get('namzu.workspace.presentation:abc')).toBeUndefined()
	})

	it('loses at most what was written after the last flush when it crashes', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.surface', 'cli')
		first.store.flush()
		first.store.set('namzu.surface', 'desktop')
		const second = open(disk)
		expect(second.store.get('namzu.surface')).toBe('cli')
	})

	it('restores after a restart for an update the same as after a quit', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.set('namzu.session-panel-open', 'true')
		first.store.markCleanShutdown()
		expect(open(disk).store.get('namzu.session-panel-open')).toBe('true')
	})

	it('keeps state when the app only closed to the tray: the process never reloaded it', () => {
		const disk = fakeDisk()
		const { store, clock } = open(disk)
		store.set('namzu.surface', 'cli')
		clock.fire()
		expect(store.get('namzu.surface')).toBe('cli')
		expect(store.closeState).toBe('first-run')
	})
})

describe('a damaged file', () => {
	it('moves an unreadable file aside and starts empty', () => {
		const disk = fakeDisk()
		disk.files.set(FILE, '{not json')
		const { store } = open(disk)
		expect(store.snapshot()).toEqual({})
		expect(disk.files.get(`${FILE}.unreadable`)).toBe('{not json')
	})

	it('drops a bad entry without losing the rest', () => {
		const disk = fakeDisk()
		disk.files.set(
			FILE,
			JSON.stringify({
				version: 1,
				cleanShutdown: true,
				legacyImported: true,
				entries: {
					'namzu.surface': { v: 'cli', t: 1 },
					'namzu.unknown': { v: 'x', t: 1 },
					'namzu.sidebar-collapsed': { v: 5, t: 1 },
					'namzu.appearance': { v: 'x'.repeat(500), t: 1 },
				},
			}),
		)
		expect(open(disk).store.snapshot()).toEqual({ 'namzu.surface': 'cli' })
	})

	it('never writes over a file a newer Namzu made', () => {
		const disk = fakeDisk()
		const newer = JSON.stringify({ version: 99, entries: { future: { v: 'x' } } })
		disk.files.set(FILE, newer)
		const { store } = open(disk)
		expect(store.set('namzu.surface', 'cli')).toBe('read-only')
		store.markCleanShutdown()
		expect(disk.files.get(FILE)).toBe(newer)
	})
})

describe('importing what localStorage held', () => {
	const legacy = {
		'namzu.sidebar-collapsed': 'true',
		'namzu.panes.1.group-a': '{"order":["a"]}',
		'namzu.workspace.files:abc': '["a.ts"]',
		'namzu.terminal.debug': '1',
		unrelated: 'x',
		'window.mode:w1': '{"maximized":true}',
	}

	it('copies the declared keys and names the ones the page may now delete', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		const result = store.importLegacy(legacy)
		expect(result.imported).toBe(3)
		expect(result.deletable.sort()).toEqual(
			['namzu.panes.1.group-a', 'namzu.sidebar-collapsed', 'namzu.workspace.files:abc'].sort(),
		)
		expect(store.get('namzu.panes.1.group-a')).toBe('{"order":["a"]}')
		expect(store.get('namzu.terminal.debug')).toBeUndefined()
		expect(store.get('window.mode:w1')).toBeUndefined()
	})

	it('survives a restart, and a saved layout is never lost on its way in', () => {
		const disk = fakeDisk()
		const first = open(disk)
		first.store.importLegacy(legacy)
		first.store.markCleanShutdown()
		const second = open(disk)
		expect(second.store.get('namzu.panes.1.group-a')).toBe('{"order":["a"]}')
		expect(second.store.get('namzu.sidebar-collapsed')).toBe('true')
	})

	it('is idempotent: a second window repeating it changes nothing', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		store.importLegacy(legacy)
		store.set('namzu.sidebar-collapsed', 'false')
		expect(store.importLegacy(legacy).imported).toBe(0)
		expect(store.get('namzu.sidebar-collapsed')).toBe('false')
	})

	it('keeps a newer stored value over an old localStorage one', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		store.set('namzu.sidebar-collapsed', 'false')
		store.importLegacy({ 'namzu.sidebar-collapsed': 'true' })
		expect(store.get('namzu.sidebar-collapsed')).toBe('false')
	})

	it('leaves a key in localStorage when its family cap dropped it', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		const cap = defineOf('namzu.workspace.files:x')?.maxEntries ?? 0
		const many: Record<string, string> = {}
		for (let i = 0; i < cap + 5; i++) many[`namzu.workspace.files:c${i}`] = '[]'
		const result = store.importLegacy(many)
		const kept = Object.keys(store.snapshot()).filter((k) => k.startsWith('namzu.workspace.files:'))
		expect(kept).toHaveLength(cap)
		expect(result.deletable.sort()).toEqual(kept.sort())
	})

	it('ignores a value that is not a string or is over its cap', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		const result = store.importLegacy({
			'namzu.surface': 5,
			'namzu.appearance': 'x'.repeat(500),
			'namzu.sidebar-collapsed': 'true',
		})
		expect(result.deletable).toEqual(['namzu.sidebar-collapsed'])
		expect(store.importLegacy(null).imported).toBe(0)
	})
})

describe('removing a conversation', () => {
	it('drops that conversation’s keys and keeps everything else', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		store.set('namzu.workspace.presentation:gone', '{}')
		store.set('namzu.workspace.files:gone', '[]')
		store.set('namzu.workspace.presentation:live', '{}')
		store.set('namzu.sidebar-collapsed', 'true')
		expect(store.forgetConversation('gone')).toBe(2)
		expect(Object.keys(store.snapshot()).sort()).toEqual([
			'namzu.sidebar-collapsed',
			'namzu.workspace.presentation:live',
		])
		expect(store.forgetConversation('')).toBe(0)
		expect(store.forgetConversation('never-had-keys')).toBe(0)
	})

	it('does not take a conversation whose id only starts the same way', () => {
		const { store } = open(fakeDisk())
		store.set('namzu.workspace.presentation:abc-2', '{}')
		expect(store.forgetConversation('abc')).toBe(0)
		expect(store.get('namzu.workspace.presentation:abc-2')).toBe('{}')
	})
})

describe('telling other windows', () => {
	it('reports each change and each removal once', () => {
		const disk = fakeDisk()
		const { store } = open(disk)
		const seen: unknown[] = []
		const stop = store.onChange((change) => seen.push(change))
		store.set('namzu.surface', 'cli')
		store.set('namzu.surface', 'cli')
		store.remove('namzu.surface')
		stop()
		store.set('namzu.surface', 'desktop')
		expect(seen).toEqual([
			{ key: 'namzu.surface', value: 'cli' },
			{ key: 'namzu.surface', value: null },
		])
	})
})

describe('a window’s mode', () => {
	const window = (state: Partial<Record<'max' | 'full' | 'dead', boolean>> = {}) => {
		const calls: string[] = []
		const value: ModeWindow = {
			isDestroyed: () => state.dead === true,
			isMaximized: () => state.max === true,
			isFullScreen: () => state.full === true,
			maximize: () => calls.push('maximize'),
			setFullScreen: (flag) => calls.push(`full:${flag}`),
		}
		return { value, calls }
	}

	it('remembers maximized and full screen, and nothing for an ordinary window', () => {
		const { store } = open(fakeDisk())
		writeWindowMode(store, 'w1', { maximized: true, fullscreen: false })
		expect(readWindowMode(store, 'w1')).toEqual({ maximized: true, fullscreen: false })
		writeWindowMode(store, 'w1', { maximized: false, fullscreen: false })
		expect(store.get('window.mode:w1')).toBeUndefined()
		expect(readWindowMode(store, 'w1')).toEqual({ maximized: false, fullscreen: false })
	})

	it('survives a restart', () => {
		const disk = fakeDisk()
		const first = open(disk)
		writeWindowMode(first.store, 'w1', { maximized: false, fullscreen: true })
		first.store.markCleanShutdown()
		expect(readWindowMode(open(disk).store, 'w1')).toEqual({ maximized: false, fullscreen: true })
	})

	it('puts a window back: full screen wins, maximized next, otherwise nothing', () => {
		const a = window()
		applyWindowMode(a.value, { maximized: true, fullscreen: true })
		expect(a.calls).toEqual(['full:true'])
		const b = window()
		applyWindowMode(b.value, { maximized: true, fullscreen: false })
		expect(b.calls).toEqual(['maximize'])
		const c = window()
		applyWindowMode(c.value, { maximized: false, fullscreen: false })
		expect(c.calls).toEqual([])
		const dead = window({ dead: true })
		applyWindowMode(dead.value, { maximized: true, fullscreen: false })
		expect(dead.calls).toEqual([])
	})

	it('captures what a window is now', () => {
		expect(captureWindowMode(window({ max: true }).value)).toEqual({
			maximized: true,
			fullscreen: false,
		})
		expect(captureWindowMode(window({ dead: true, max: true }).value)).toEqual({
			maximized: false,
			fullscreen: false,
		})
	})
})
