import { describe, expect, it, vi } from 'vitest'
import {
	type ApplicationMenuLike,
	type MenuItemLike,
	clickWindowMenuItem,
	readWindowMenuItemId,
	windowMenuItem,
	windowMenuModel,
} from './window-menu.js'

const sep = { type: 'separator' }
function fake(menus: Record<string, MenuItemLike[]>): ApplicationMenuLike {
	return { getMenuItemById: (id) => (menus[id] ? { submenu: { items: menus[id] ?? [] } } : null) }
}
const app = fake({
	edit: [
		{ label: 'Undo', accelerator: 'CmdOrCtrl+Z' },
		sep,
		{ label: 'Cut', accelerator: { toString: () => 'CmdOrCtrl+X' } },
		{ label: 'Hidden', visible: false },
	],
	view: [
		{ label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0' },
		sep,
		{ type: 'checkbox', label: 'Show conversation tabs', checked: true },
		sep,
		sep,
		{ label: 'Greyed', enabled: false },
		sep,
	],
	window: [{ label: 'Minimize' }],
})

describe('the window menu model', () => {
	it('lists Edit, View and Window in the application menu order, with shortcuts and states', () => {
		const model = windowMenuModel(app)
		expect(model.edit.map((e) => [e.id, e.kind, e.label, e.accelerator])).toEqual([
			['edit/0', 'item', 'Undo', 'CmdOrCtrl+Z'],
			['', 'separator', '', undefined],
			['edit/2', 'item', 'Cut', 'CmdOrCtrl+X'],
		])
		expect(model.view.map((e) => e.kind)).toEqual([
			'item',
			'separator',
			'checkbox',
			'separator',
			'item',
		])
		expect(model.view[2]).toMatchObject({ id: 'view/2', checked: true, enabled: true })
		expect(model.view[4]).toMatchObject({ label: 'Greyed', enabled: false })
		expect(model.window).toHaveLength(1)
	})
	it('is empty when there is no application menu', () => {
		expect(windowMenuModel(null)).toEqual({ edit: [], view: [], window: [] })
	})
	it('reads only ids the model writes, and refuses anything else', () => {
		expect(readWindowMenuItemId('view/2')).toEqual({ menu: 'view', index: 2 })
		for (const value of [
			undefined,
			1,
			'file/0',
			'view',
			'view/-1',
			'view/01',
			'view/2/3',
			'__proto__/0',
		])
			expect(() => readWindowMenuItemId(value)).toThrow('Unknown window menu item')
	})
	it('runs an item the way a native click does, and refuses a divider, a hidden or a disabled one', () => {
		const click = vi.fn()
		const menu = fake({
			edit: [
				{ label: 'Copy', click },
				sep,
				{ label: 'Off', enabled: false },
				{ label: 'Gone', visible: false },
			],
		})
		const window = {}
		const contents = {}
		clickWindowMenuItem(windowMenuItem(menu, 'edit/0'), window, contents)
		expect(click).toHaveBeenCalledWith({}, window, contents)
		for (const id of ['edit/1', 'edit/2', 'edit/3', 'edit/9', 'view/0'])
			expect(() => windowMenuItem(menu, id)).toThrow('unavailable')
	})
})
