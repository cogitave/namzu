import { describe, expect, it } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import { type TerminalTabView, terminalTabId } from '../shared/terminal-tabs.js'
import { TerminalTabsStore } from './terminal-store.js'

const tab = (n: number): TerminalTabView => ({
	id: terminalTabId(`0f0e0d0c-0b0a-4908-8706-05040302010${n}`),
	projectId: 'p',
	kind: 'shell',
	title: `sh ${n}`,
	status: 'running',
	createdAt: n,
})

function setup(read: () => Promise<TerminalTabView[]>) {
	let listener: ((event: DesktopEvent) => void) | undefined
	let stops = 0
	const api = {
		terminals: read,
		onEvent: (next: (event: DesktopEvent) => void) => {
			listener = next
			return () => {
				stops++
				listener = undefined
			}
		},
	}
	return {
		store: new TerminalTabsStore(api),
		push: (terminals: TerminalTabView[]) => listener?.({ kind: 'terminals', terminals }),
		stops: () => stops,
	}
}

describe('TerminalTabsStore', () => {
	it('fills from the first read and follows pushes', async () => {
		let answer: (tabs: TerminalTabView[]) => void = () => undefined
		const t = setup(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		const seen: number[] = []
		t.store.subscribe(() => seen.push(t.store.snapshot().length))
		expect(t.store.snapshot()).toEqual([])
		answer([tab(1)])
		await Promise.resolve()
		expect(t.store.snapshot()).toEqual([tab(1)])
		t.push([tab(1), tab(2)])
		expect(seen).toEqual([1, 2])
	})

	it('lets a push that arrives before the first read answers win', async () => {
		let answer: (tabs: TerminalTabView[]) => void = () => undefined
		const t = setup(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		t.store.subscribe(() => undefined)
		t.push([tab(1), tab(2)])
		answer([tab(1)])
		await Promise.resolve()
		expect(t.store.snapshot().map((item) => item.createdAt)).toEqual([1, 2])
	})

	it('stops listening with its last subscriber and tolerates a failed read', async () => {
		const t = setup(() => Promise.reject(new Error('no host')))
		const off = t.store.subscribe(() => undefined)
		await Promise.resolve()
		expect(t.store.snapshot()).toEqual([])
		off()
		expect(t.stops()).toBe(1)
	})
})
