import type { WindowMenu, WindowMenuEntry, WindowMenuModel } from '../shared/protocol.js'

/** The part of an Electron menu item the model reads and runs. */
export interface MenuItemLike {
	type?: string
	label?: string
	accelerator?: unknown
	enabled?: boolean
	visible?: boolean
	checked?: boolean
	submenu?: { items: MenuItemLike[] } | null
	click?: unknown
}
export interface ApplicationMenuLike {
	getMenuItemById(id: string): MenuItemLike | null
}

/** The menus the header's menu button shows after File, in this order. */
export const WINDOW_MENUS: readonly WindowMenu[] = ['edit', 'view', 'window']

function accelerator(item: MenuItemLike): string | undefined {
	const value = item.accelerator
	if (typeof value === 'string' && value) return value
	// A role's own shortcut is held as an object that prints as its key.
	if (value && typeof value === 'object') {
		const text = String(value)
		if (text && text !== '[object Object]') return text
	}
	return undefined
}

function entries(menu: WindowMenu, items: readonly MenuItemLike[]): WindowMenuEntry[] {
	const out: WindowMenuEntry[] = []
	items.forEach((item, index) => {
		if (item.visible === false) return
		if (item.type === 'separator') {
			// A separator at the start, the end or beside another one is no divider.
			if (out.length === 0 || out[out.length - 1]?.kind === 'separator') return
			out.push({ id: '', kind: 'separator', label: '', enabled: false })
			return
		}
		// A submenu inside these three is not drawn: none of them has one today.
		const shortcut = accelerator(item)
		out.push({
			id: `${menu}/${index}`,
			kind: item.type === 'checkbox' ? 'checkbox' : 'item',
			label: (item.label ?? '').replace(/&(?!&)/g, ''),
			...(shortcut ? { accelerator: shortcut } : {}),
			enabled: item.enabled !== false,
			...(item.type === 'checkbox' ? { checked: item.checked === true } : {}),
		})
	})
	while (out[out.length - 1]?.kind === 'separator') out.pop()
	return out
}

/** Edit, View and Window as the application menu holds them now, in order. File is the renderer's own. */
export function windowMenuModel(menu: ApplicationMenuLike | null): WindowMenuModel {
	const model: WindowMenuModel = { edit: [], view: [], window: [] }
	for (const name of WINDOW_MENUS)
		model[name] = entries(name, menu?.getMenuItemById(name)?.submenu?.items ?? [])
	return model
}

/** An id as `windowMenuModel` writes it; anything else is refused at the main-process boundary. */
export function readWindowMenuItemId(value: unknown): { menu: WindowMenu; index: number } {
	if (typeof value !== 'string') throw new Error('Unknown window menu item.')
	const match = /^(edit|view|window)\/(0|[1-9]\d{0,2})$/.exec(value)
	if (!match) throw new Error('Unknown window menu item.')
	return { menu: match[1] as WindowMenu, index: Number(match[2]) }
}

/** The item an id names, when it can be run: shown, enabled and not a divider. */
export function windowMenuItem(menu: ApplicationMenuLike | null, id: unknown): MenuItemLike {
	const { menu: name, index } = readWindowMenuItemId(id)
	const item = menu?.getMenuItemById(name)?.submenu?.items[index]
	if (!item || item.type === 'separator' || item.visible === false || item.enabled === false)
		throw new Error('This window menu item is unavailable.')
	return item
}

/** The same call a click in a native menu makes: a role runs on this window, a command runs its own handler. */
export function clickWindowMenuItem(item: MenuItemLike, window: unknown, contents: unknown): void {
	if (typeof item.click === 'function') item.click({}, window, contents)
}
