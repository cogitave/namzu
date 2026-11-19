import { afterEach, describe, expect, it, vi } from 'vitest'
import { callExtensions, debounced, listPollInterval } from './extensions-store.js'

describe('callExtensions: the language of a call', () => {
	afterEach(() => vi.unstubAllGlobals())

	it('sends the window language when the caller names none', async () => {
		vi.stubGlobal('navigator', { language: 'en-US' })
		const extensionsCall = vi.fn(async () => ({}))
		await callExtensions({ extensionsCall } as never, 'namzu/extensions/list')
		expect(extensionsCall).toHaveBeenCalledWith('namzu/extensions/list', { locale: 'en-US' })
	})

	it('keeps the language the notice was shown in when acknowledging', async () => {
		vi.stubGlobal('navigator', { language: 'en-US' })
		const extensionsCall = vi.fn(async () => ({}))
		await callExtensions({ extensionsCall } as never, 'namzu/extensions/acknowledge', {
			id: 'x',
			locale: 'tr',
		})
		expect(extensionsCall).toHaveBeenCalledWith('namzu/extensions/acknowledge', {
			locale: 'tr',
			id: 'x',
		})
	})
})

describe('where an extension page and Settings send the person', () => {
	it('the rail asks for Settings, and a page opened from Settings returns there with the same extension', async () => {
		const store = await import('./extensions-store.js')
		const { snapshotForTest } = store
		const before = snapshotForTest()
		store.openExtensionsPage()
		expect(snapshotForTest().settingsRequest).toBe(before.settingsRequest + 1)

		store.selectExtension('a.b.c')
		store.openExtensionPage('a.b.c', 'today', true)
		expect(snapshotForTest().page).toEqual({
			extensionId: 'a.b.c',
			pageId: 'today',
			fromSettings: true,
		})
		const returns = snapshotForTest().settingsReturn
		store.closeExtensionPage()
		expect(snapshotForTest().page).toBeUndefined()
		expect(snapshotForTest().selected).toBe('a.b.c')
		expect(snapshotForTest().settingsReturn).toBe(returns + 1)
	})

	it('a page opened anywhere else returns to the window it covered, and never opens Settings', async () => {
		const store = await import('./extensions-store.js')
		const { snapshotForTest } = store
		const returns = snapshotForTest().settingsReturn
		store.openExtensionPage('a.b.c', 'today')
		store.closeExtensionPage()
		expect(snapshotForTest().settingsReturn).toBe(returns)
		// Closing with nothing open does nothing.
		store.closeExtensionPage()
		expect(snapshotForTest().settingsReturn).toBe(returns)
	})

	it("a page's strip sends the person to that extension's screen with the dialog it named", async () => {
		const store = await import('./extensions-store.js')
		const { snapshotForTest } = store
		store.openExtensionPage('d.e.f', 'today')
		store.openExtensionPanel('d.e.f', 'licence')
		const now = snapshotForTest()
		expect(now.page).toBeUndefined()
		expect(now.selected).toBe('d.e.f')
		expect(now.panelRequest).toEqual({ id: 'd.e.f', kind: 'licence' })
		store.takePanelRequest()
		expect(snapshotForTest().panelRequest).toBeUndefined()
	})
})

describe('how often the extension list is re-read', () => {
	it('uses the slow beat while a page is open, never the 4 s one', () => {
		expect(listPollInterval({ pageOpen: true, settingsScreenOpen: false, anyEnabled: true })).toBe(
			15000,
		)
		expect(listPollInterval({ pageOpen: true, settingsScreenOpen: true, anyEnabled: true })).toBe(
			15000,
		)
		expect(listPollInterval({ pageOpen: true, settingsScreenOpen: false, anyEnabled: false })).toBe(
			60000,
		)
	})

	it("keeps the fast beat for Settings' own extension screen, and the slow ones otherwise", () => {
		expect(listPollInterval({ pageOpen: false, settingsScreenOpen: true, anyEnabled: true })).toBe(
			4000,
		)
		expect(listPollInterval({ pageOpen: false, settingsScreenOpen: false, anyEnabled: true })).toBe(
			15000,
		)
		expect(
			listPollInterval({ pageOpen: false, settingsScreenOpen: false, anyEnabled: false }),
		).toBe(60000)
	})
})

describe('debounced state-event refreshes', () => {
	afterEach(() => vi.useRealTimers())

	it('reads once for a burst of events, after the last one', () => {
		vi.useFakeTimers()
		const fn = vi.fn()
		const d = debounced(fn, 400)
		d.call()
		vi.advanceTimersByTime(300)
		d.call()
		vi.advanceTimersByTime(300)
		expect(fn).not.toHaveBeenCalled()
		vi.advanceTimersByTime(100)
		expect(fn).toHaveBeenCalledTimes(1)
	})

	it('still reads while events keep arriving closer together than the delay', () => {
		vi.useFakeTimers()
		const fn = vi.fn()
		const d = debounced(fn, 400, 1000)
		for (let i = 0; i < 20; i++) {
			d.call()
			vi.advanceTimersByTime(100)
		}
		expect(fn).toHaveBeenCalled()
	})

	it('reads nothing once cancelled', () => {
		vi.useFakeTimers()
		const fn = vi.fn()
		const d = debounced(fn, 400)
		d.call()
		d.cancel()
		vi.advanceTimersByTime(1000)
		expect(fn).not.toHaveBeenCalled()
	})
})
