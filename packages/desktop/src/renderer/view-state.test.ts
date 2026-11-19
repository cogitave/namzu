import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runInNewContext } from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ViewStateBridge } from '../shared/protocol.js'
import { ViewStateStorage, useStateKey } from './view-state.js'

type Change = { key: string; value: string | null }

function bridge(snapshot: Record<string, string> = {}) {
	const calls: string[] = []
	let listener: ((change: Change) => void) | undefined
	const value: ViewStateBridge & { push(change: Change): void; imported: unknown[] } = {
		snapshot,
		imported: [],
		importLegacy(entries) {
			value.imported.push(entries)
			return { snapshot: { ...snapshot, ...entries }, deletable: Object.keys(entries) }
		},
		set: (key, v) => calls.push(`set ${key}=${v}`),
		remove: (key) => calls.push(`remove ${key}`),
		onChange: (next) => {
			listener = next
			return () => {
				listener = undefined
			}
		},
		push: (change) => listener?.(change),
	}
	return { value, calls }
}

function legacyStorage(items: Record<string, string>) {
	return {
		get length() {
			return Object.keys(items).length
		},
		key: (index: number) => Object.keys(items)[index] ?? null,
		getItem: (key: string) => items[key] ?? null,
		removeItem: (key: string) => {
			delete items[key]
		},
	}
}

describe('the saved interface state as a Storage', () => {
	it('answers from main’s snapshot before anything is asked of main', () => {
		const { value } = bridge({ 'namzu.sidebar-collapsed': 'true' })
		const storage = new ViewStateStorage({ bridge: value })
		expect(storage.getItem('namzu.sidebar-collapsed')).toBe('true')
		expect(storage.getItem('namzu.surface')).toBeNull()
	})

	it('writes through to main and keeps the value at once', () => {
		const { value, calls } = bridge()
		const storage = new ViewStateStorage({ bridge: value })
		storage.setItem('namzu.surface', 'cli')
		storage.removeItem('namzu.surface')
		storage.removeItem('namzu.surface')
		expect(calls).toEqual(['set namzu.surface=cli', 'remove namzu.surface'])
	})

	it('keeps a key main does not declare, or a value over its cap, for this window only', () => {
		const { value, calls } = bridge()
		const storage = new ViewStateStorage({ bridge: value })
		storage.setItem('namzu.terminal.debug', '1')
		storage.setItem('namzu.surface', 'x'.repeat(100))
		expect(storage.getItem('namzu.terminal.debug')).toBe('1')
		expect(calls).toEqual([])
	})

	it('has no bridge in a test or a plain browser and then simply remembers', () => {
		const storage = new ViewStateStorage()
		storage.setItem('namzu.surface', 'cli')
		expect(storage.getItem('namzu.surface')).toBe('cli')
	})

	it('shows a change from another window and announces it as a storage event', () => {
		const { value } = bridge({ 'namzu.sidebar-collapsed': 'false' })
		const announced: unknown[] = []
		const storage = new ViewStateStorage({
			bridge: value,
			announce: (key, next, before) => announced.push([key, next, before]),
		})
		let notified = 0
		storage.subscribe(() => notified++)
		value.push({ key: 'namzu.sidebar-collapsed', value: 'true' })
		value.push({ key: 'namzu.sidebar-collapsed', value: null })
		expect(storage.getItem('namzu.sidebar-collapsed')).toBeNull()
		expect(notified).toBe(2)
		expect(announced).toEqual([
			['namzu.sidebar-collapsed', 'true', 'false'],
			['namzu.sidebar-collapsed', null, 'true'],
		])
	})
})

describe('moving what localStorage held', () => {
	it('hands over the declared keys once, deletes what main took, and leaves the rest', () => {
		const old = legacyStorage({
			'namzu.panes.1.group-a': '{"order":["a"]}',
			'namzu.sidebar-collapsed': 'true',
			'namzu.terminal.debug': '1',
			other: 'x',
		})
		const { value } = bridge()
		const storage = new ViewStateStorage({ bridge: value, legacy: old })
		expect(value.imported).toEqual([
			{ 'namzu.panes.1.group-a': '{"order":["a"]}', 'namzu.sidebar-collapsed': 'true' },
		])
		expect(storage.getItem('namzu.panes.1.group-a')).toBe('{"order":["a"]}')
		expect(old.getItem('namzu.panes.1.group-a')).toBeNull()
		expect(old.getItem('namzu.terminal.debug')).toBe('1')
		expect(old.getItem('other')).toBe('x')
	})

	it('asks nothing of main when there is nothing to hand over', () => {
		const { value } = bridge()
		new ViewStateStorage({ bridge: value, legacy: legacyStorage({ other: 'x' }) })
		expect(value.imported).toEqual([])
	})

	it('keeps old values in place when main does not answer', () => {
		const old = legacyStorage({ 'namzu.sidebar-collapsed': 'true' })
		const { value } = bridge()
		value.importLegacy = () => null
		new ViewStateStorage({ bridge: value, legacy: old })
		expect(old.getItem('namzu.sidebar-collapsed')).toBe('true')
	})
})

describe('the hook', () => {
	it('reads the saved value on the first render, with no flash of a default', () => {
		const storage = new ViewStateStorage({ bridge: bridge({ 'namzu.surface': 'cli' }).value })
		function Probe() {
			const [value] = useStateKey('namzu.surface', storage)
			return createElement('span', null, value ?? 'none')
		}
		expect(renderToStaticMarkup(createElement(Probe))).toBe('<span>cli</span>')
		function Missing() {
			const [value] = useStateKey('namzu.appearance', storage)
			return createElement('span', null, value ?? 'none')
		}
		expect(renderToStaticMarkup(createElement(Missing))).toBe('<span>none</span>')
	})
})

describe('the first paint reads main’s snapshot', () => {
	it('draws the saved theme from the snapshot when localStorage was already emptied', () => {
		const classes = new Set<string>()
		const element = {
			classList: {
				toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
				add: (name: string) => classes.add(name),
			},
			setAttribute: () => {},
			style: { setProperty: () => {} },
		}
		runInNewContext(readFileSync(new URL('../../public/theme-boot.js', import.meta.url), 'utf8'), {
			localStorage: { getItem: () => null },
			window: {
				matchMedia: () => ({ matches: true }),
				namzu: { viewState: { snapshot: { 'namzu.appearance': 'light' } } },
			},
			document: { documentElement: element },
		})
		expect(classes.has('dark')).toBe(false)
	})
})

describe('who may touch localStorage', () => {
	const here = new URL('.', import.meta.url).pathname
	const allowed = new Set([
		'view-state.ts',
		// A flag the end-to-end tests set to read a terminal's screen; it is never a saved choice.
		'terminal-registry.ts',
	])
	const files = (dir: string): string[] =>
		readdirSync(dir).flatMap((name) => {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) return files(path)
			return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
		})

	it('is only the state module (and the test flag), so nothing is kept where a restart loses it', () => {
		const offenders = files(here)
			.filter((path) => !allowed.has(relative(here, path)))
			.filter((path) => {
				const code = readFileSync(path, 'utf8')
					.replace(/\/\*[\s\S]*?\*\//g, '')
					.replace(/(^|[^:])\/\/.*$/gm, '$1')
				return /\blocalStorage\b|\bsessionStorage\b/.test(code)
			})
			.map((path) => relative(here, path))
		expect(offenders).toEqual([])
	})
})
