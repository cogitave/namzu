import { describe, expect, it, vi } from 'vitest'
import { TrayController, type TrayHost, type TrayLike } from './tray-controller.js'

function setup(over: Partial<TrayHost> = {}) {
	const trays: (TrayLike & { clicks: (() => void)[]; destroyed: boolean; menu?: unknown })[] = []
	const host = {
		loadIcon: vi.fn(async () => 'icon' as unknown),
		makeTray: vi.fn(() => {
			const tray = {
				clicks: [] as (() => void)[],
				destroyed: false,
				menu: undefined as unknown,
				setToolTip: vi.fn(),
				setContextMenu(menu: unknown) {
					tray.menu = menu
				},
				on(_event: 'click', listener: () => void) {
					tray.clicks.push(listener)
				},
				destroy() {
					tray.destroyed = true
				},
			}
			trays.push(tray)
			return tray
		}),
		menu: vi.fn((template) => template),
		open: vi.fn(),
		quit: vi.fn(),
		record: vi.fn(),
		...over,
	} satisfies TrayHost
	return { host, trays, controller: new TrayController(host) }
}

describe('the tray', () => {
	it('shows an icon with Open and Quit, and a click opens a window', async () => {
		const { host, trays, controller } = setup()
		expect(controller.shown()).toBe(false)
		await controller.sync(true, 'System tray')
		expect(controller.shown()).toBe(true)
		const items = trays[0]?.menu as { label?: string; click?: () => void }[]
		expect(items.map((item) => item.label)).toEqual(['Open Namzu', undefined, 'Quit Namzu'])
		items[0]?.click?.()
		trays[0]?.clicks[0]?.()
		expect(host.open).toHaveBeenCalledTimes(2)
		items[2]?.click?.()
		expect(host.quit).toHaveBeenCalledTimes(1)
	})

	it('draws one icon however often it is asked, and removes it when switched off', async () => {
		const { trays, controller } = setup()
		await controller.sync(true, 'System tray')
		await controller.sync(true, 'System tray')
		expect(trays).toHaveLength(1)
		await controller.sync(false, 'System tray')
		expect(trays[0]?.destroyed).toBe(true)
		expect(controller.shown()).toBe(false)
		await controller.sync(true, 'System tray')
		expect(trays).toHaveLength(2)
	})

	it('runs calls in the order they were made', async () => {
		const { trays, controller } = setup()
		void controller.sync(true, 'System tray')
		void controller.sync(false, 'System tray')
		await controller.settled()
		expect(trays[0]?.destroyed).toBe(true)
		expect(controller.shown()).toBe(false)
	})

	it('says why and does not claim to be shown when there is no icon', async () => {
		const { controller } = setup({ loadIcon: async () => undefined })
		await controller.sync(true, 'Menu bar')
		expect(controller.shown()).toBe(false)
		expect(controller.problem()).toBe(
			'Namzu could not find its icon for the menu bar, so closing the window still quits.',
		)
		await controller.sync(false, 'Menu bar')
		expect(controller.problem()).toBeUndefined()
	})

	it('records a tray the system refused and keeps quitting on close', async () => {
		const failure = new Error('no tray here')
		const { host, controller } = setup({
			makeTray: () => {
				throw failure
			},
		})
		await controller.sync(true, 'System tray')
		expect(controller.shown()).toBe(false)
		expect(host.record).toHaveBeenCalledWith(failure)
		expect(controller.problem()).toContain('closing the window still quits')
	})
})
