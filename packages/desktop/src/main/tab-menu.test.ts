import { expect, it, vi } from 'vitest'
import { tabMenuItems } from './tab-menu.js'

it('lists Close tab, Next tab and Previous tab with their shortcuts', () => {
	const items = tabMenuItems('linux', () => {})
	expect(items.map(({ label, accelerator }) => [label, accelerator])).toEqual([
		['Close tab', 'CmdOrCtrl+W'],
		['Next tab', 'Ctrl+Tab'],
		['Previous tab', 'Ctrl+Shift+Tab'],
	])
})

it('asks the window to run the matching tab action', () => {
	const send = vi.fn()
	const [close, next, previous] = tabMenuItems('win32', send)
	close?.click()
	next?.click()
	previous?.click()
	expect(send.mock.calls).toEqual([['close'], ['next'], ['previous']])
})

it('only shows the shortcut on Windows and Linux, so a terminal can hand the key on', () => {
	for (const platform of ['win32', 'linux'] as const)
		expect(tabMenuItems(platform, () => {}).every((item) => !item.registerAccelerator)).toBe(true)
	expect(tabMenuItems('darwin', () => {}).every((item) => item.registerAccelerator)).toBe(true)
})
