/**
 * The Windows adapter with the accessibility host: the window list comes from
 * it while it is up and from the driver otherwise, a failure of it never loses
 * the call, and a window input is followed by a wait for the window to settle
 * instead of a fixed pause.
 */
import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import type {
	A11yFingerprint,
	A11yIdentityRequest,
	A11yResolution,
	A11yResolveRequest,
	A11ySeq,
	A11ySnapshot,
	A11ySnapshotRequest,
	A11yWaitRequest,
	A11yWaitResult,
	A11yWindow,
	AccessibilityBackend,
} from '../a11y/index.js'
import { CuaDriverAdapter, windowInfosFromHost } from '../adapters/cua-driver/adapter.js'
import type { Adapter } from '../adapters/types.js'
import { type FakeServerScript, fakeSpawner, pngHeader, toolResult } from './fake-mcp-process.js'

const win = (over: Partial<A11yWindow> & { windowId: string }): A11yWindow => ({
	processId: 42,
	processName: 'editor.exe',
	title: 'Notes',
	bounds: { x: 100, y: 80, width: 1200, height: 700 },
	minimized: false,
	focused: false,
	z: 0,
	...over,
})

class FakeBackend implements AccessibilityBackend {
	readonly id = 'fake'
	isReady = true
	warmed = 0
	windows: A11yWindow[] = [win({ windowId: '0x111', focused: true })]
	/** Throws from the next listWindows this many times. */
	failList = 0
	listCalls = 0
	log: string[] = []
	nextSeq = 100
	waits: A11yWaitRequest[] = []
	wait: () => Promise<A11yWaitResult> = async () => ({
		changed: true,
		settled: true,
		firstEventMs: 4,
		settledMs: 130,
		events: 3,
		newWindows: [],
	})
	seqFails = false

	warm(): void {
		this.warmed++
	}
	async ready(): Promise<boolean> {
		return this.isReady
	}
	readonly listOptions: unknown[] = []
	async listWindows(options?: { readonly includeOwned?: boolean }): Promise<readonly A11yWindow[]> {
		this.listOptions.push(options)
		this.listCalls++
		this.log.push('list')
		if (this.failList > 0) {
			this.failList--
			throw new Error('helper gone')
		}
		return this.windows
	}
	async listDisplays(): Promise<never[]> {
		return []
	}
	async snapshot(_request: A11ySnapshotRequest): Promise<A11ySnapshot> {
		throw new Error('not used')
	}
	async seq(windowId?: string): Promise<A11ySeq> {
		this.log.push(`seq ${windowId ?? ''}`)
		if (this.seqFails) throw new Error('no marker')
		return this.nextSeq++
	}
	async waitForChange(request: A11yWaitRequest): Promise<A11yWaitResult> {
		this.waits.push(request)
		this.log.push('wait')
		return this.wait()
	}
	async identity(_request: A11yIdentityRequest): Promise<A11yFingerprint> {
		throw new Error('not used')
	}
	async resolve(_request: A11yResolveRequest): Promise<A11yResolution> {
		throw new Error('not used')
	}
	async close(): Promise<void> {}
}

function driver(a11y: AccessibilityBackend | undefined, now: () => number = () => 0) {
	const calls: string[] = []
	const script: FakeServerScript = {
		tool: (call) => {
			calls.push(call.name)
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 0x111,
								pid: 42,
								title: 'Notes',
								app_name: 'editor.exe',
								bounds: { x: 100, y: 80, width: 1200, height: 700 },
								z_index: 1,
							},
						],
					})
				case 'get_window_state':
					return toolResult(
						{
							pid: 42,
							window_id: 0x111,
							// The driver's own rectangle for the window: not the host's.
							window_bounds: { x: 93, y: 80, width: 1214, height: 707 },
							screenshot_width: 600,
							screenshot_height: 350,
						},
						[
							{
								type: 'image',
								data: pngHeader(600, 350).toString('base64'),
								mimeType: 'image/png',
							},
						],
					)
				case 'click':
					calls.push('(click sent)')
					return toolResult({ effect: 'unverifiable', delivery: { mode: 'background' } })
				case 'set_agent_cursor_enabled':
					return toolResult({ enabled: false })
				default:
					return toolResult({})
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
		now,
		...(a11y ? { a11y } : {}),
	})
	return { adapter, calls }
}

const listCalls = (calls: string[]): number => calls.filter((c) => c === 'list_windows').length

describe('windowInfosFromHost', () => {
	it('keeps the id form, the app name without .exe, and the host order front to back', () => {
		const listed = windowInfosFromHost([
			win({ windowId: '0x20', z: 1, title: 'Back', processName: 'b.exe' }),
			win({ windowId: '0x10', z: 0, title: 'Front', processName: 'a.exe' }),
		])
		expect(listed.map((w) => [w.id, w.app, w.title])).toEqual([
			['0x10', 'a', 'Front'],
			['0x20', 'b', 'Back'],
		])
	})

	it('drops what the driver path drops: untitled, the driver’s own, the desktop, one pixel wide', () => {
		const listed = windowInfosFromHost([
			win({ windowId: '0x1', title: '  ' }),
			win({ windowId: '0x2', processName: 'cua-driver.exe' }),
			win({ windowId: '0x3', processName: 'explorer.exe', title: 'Program Manager' }),
			win({ windowId: '0x4', bounds: { x: 0, y: 0, width: 1, height: 50 } }),
			win({ windowId: '0x5', processName: 'explorer.exe', title: 'Documents' }),
			win({ windowId: 'junk' }),
		])
		expect(listed.map((w) => w.id)).toEqual(['0x5'])
	})

	it('marks the foreground window focused, else the front-most one that is not minimized', () => {
		const a = win({ windowId: '0x1', z: 0, minimized: true })
		const b = win({ windowId: '0x2', z: 1 })
		const c = win({ windowId: '0x3', z: 2, focused: true })
		expect(windowInfosFromHost([a, b, c]).map((w) => w.focused)).toEqual([false, false, true])
		expect(windowInfosFromHost([a, b, { ...c, focused: false }]).map((w) => w.focused)).toEqual([
			false,
			true,
			false,
		])
		// A foreground window that is minimized cannot be the one in front.
		expect(
			windowInfosFromHost([{ ...b, focused: true, minimized: true }, c]).map((w) => w.focused),
		).toEqual([false, true])
	})
})

describe('the window list', () => {
	it('is served from the accessibility host while it is up, without a driver call', async () => {
		const a11y = new FakeBackend()
		const { adapter, calls } = driver(a11y)
		const windows = await adapter.listWindows()
		expect(windows).toEqual([
			{
				id: '0x111',
				title: 'Notes',
				app: 'editor',
				pid: 42,
				bounds: { x: 100, y: 80, width: 1200, height: 700 },
				minimized: false,
				focused: true,
			},
		])
		expect(listCalls(calls)).toBe(0)
		expect(a11y.listCalls).toBe(1)
		await adapter.dispose()
	})

	it('asks the host for the owned windows too, so a dialog is listed', async () => {
		const a11y = new FakeBackend()
		const { adapter } = driver(a11y)
		await adapter.listWindows()
		expect(a11y.listOptions).toEqual([{ includeOwned: true }])
		await adapter.dispose()
	})

	it('comes from the driver, as before, when there is no host, or the host is not up yet; and the host is started', async () => {
		const bare = driver(undefined)
		await bare.adapter.listWindows()
		expect(listCalls(bare.calls)).toBe(1)
		await bare.adapter.dispose()

		const a11y = new FakeBackend()
		a11y.isReady = false
		const { adapter, calls } = driver(a11y)
		const warmedAtStart = a11y.warmed
		const windows = await adapter.listWindows()
		expect(windows.map((w) => w.id)).toEqual(['0x111'])
		expect(listCalls(calls)).toBe(1)
		expect(a11y.listCalls).toBe(0)
		expect(a11y.warmed).toBeGreaterThan(warmedAtStart)
		// Once it is up, the next list is its.
		a11y.isReady = true
		await adapter.listWindows()
		expect(listCalls(calls)).toBe(1)
		expect(a11y.listCalls).toBe(1)
		await adapter.dispose()
	})

	it('falls back to the driver in the same call when the host fails, and leaves the host alone for a while', async () => {
		let clock = 1_000
		const a11y = new FakeBackend()
		a11y.failList = 1
		const { adapter, calls } = driver(a11y, () => clock)
		const first = await adapter.listWindows()
		expect(first.map((w) => w.id)).toEqual(['0x111'])
		expect(a11y.listCalls).toBe(1)
		expect(listCalls(calls)).toBe(1)

		// No retry storm: inside the pause the driver answers alone.
		await adapter.listWindows()
		await adapter.listWindows()
		expect(a11y.listCalls).toBe(1)
		expect(listCalls(calls)).toBe(3)

		// After the pause the host is tried again, and works.
		clock += 30_001
		await adapter.listWindows()
		expect(a11y.listCalls).toBe(2)
		expect(listCalls(calls)).toBe(3)
		await adapter.dispose()
	})

	it('gives up on the host for the session after repeated failures', async () => {
		let clock = 0
		const a11y = new FakeBackend()
		a11y.failList = 99
		const { adapter, calls } = driver(a11y, () => clock)
		for (let i = 0; i < 6; i++) {
			await adapter.listWindows()
			clock += 10 * 60_000
		}
		expect(a11y.listCalls).toBe(3)
		expect(listCalls(calls)).toBe(6)
		await adapter.dispose()
	})
})

describe('capturing a window with the host’s list', () => {
	it('judges that the window did not move against the host’s own rectangle, not the driver’s', async () => {
		const a11y = new FakeBackend()
		const { adapter } = driver(a11y)
		const shot = await adapter.captureWindow('0x111')
		expect(shot.window.bounds).toEqual({ x: 100, y: 80, width: 1200, height: 700 })
		await adapter.dispose()
	})

	it('refuses the capture when the window moved while it was taken', async () => {
		const a11y = new FakeBackend()
		let lists = 0
		a11y.listWindows = async () => {
			lists++
			// The list that resolves the window and the one before the capture agree; the one after does not.
			return lists <= 2
				? a11y.windows
				: [win({ windowId: '0x111', bounds: { x: 300, y: 80, width: 1200, height: 700 } })]
		}
		const { adapter } = driver(a11y)
		await expect(adapter.captureWindow('0x111')).rejects.toThrow(/moved, closed or was minimized/)
		await adapter.dispose()
	})
})

describe('settling after a window input', () => {
	const click = { type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' } as const

	it('takes the change marker before the input is sent and waits from it, for the quiet time, within the budget', async () => {
		const a11y = new FakeBackend()
		const { adapter, calls } = driver(a11y)
		a11y.log = calls
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, click)
		const sentAt = calls.indexOf('(click sent)')
		expect(sentAt).toBeGreaterThan(-1)
		// The first marker starts the watch while the window is captured; the second is the one the
		// settle counts from, and it was taken before the input was sent.
		const markers = calls.flatMap((c, i) => (c === 'seq 0x111' ? [i] : []))
		expect(markers).toHaveLength(2)
		expect(markers[1]).toBeLessThan(sentAt)

		const settled = await adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 })
		expect(settled).toEqual({ waitedMs: 130, changed: true })
		expect(a11y.waits).toEqual([{ windowId: '0x111', since: 101, quietMs: 120, timeoutMs: 500 }])
		await adapter.dispose()
	})

	it('counts a batch from its first input and consumes the marker', async () => {
		const a11y = new FakeBackend()
		const { adapter } = driver(a11y)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, click)
		await adapter.executeWindow(shot.captureId, click)
		await adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 })
		expect(a11y.waits[0]?.since).toBe(101)
		// Nothing was done since: nothing to wait on, so the tool pauses as it always did.
		await expect(
			adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await adapter.dispose()
	})

	it('forgets a marker when the window is captured again', async () => {
		const a11y = new FakeBackend()
		const { adapter } = driver(a11y)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, click)
		await adapter.captureWindow('0x111')
		await expect(
			adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await adapter.dispose()
	})

	it('shortens the quiet time to fit a small budget', async () => {
		const a11y = new FakeBackend()
		const { adapter } = driver(a11y)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, click)
		await adapter.settleAfterInput({ windowId: '0x111', budgetMs: 80 })
		expect(a11y.waits[0]).toMatchObject({ quietMs: 80, timeoutMs: 80 })
		await adapter.dispose()
	})

	it('reports an unchanged window as such', async () => {
		const a11y = new FakeBackend()
		a11y.wait = async () => ({ changed: false, timedOut: true, settledMs: 500 })
		const { adapter } = driver(a11y)
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, click)
		await expect(adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 })).resolves.toEqual({
			waitedMs: 500,
			changed: false,
		})
		await adapter.dispose()
	})

	it('says nothing when it cannot: no host, a host that is down, no window, a failed marker or a failed wait', async () => {
		// No host.
		const bare = driver(undefined)
		await expect(
			bare.adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await bare.adapter.dispose()

		// No window named (display input).
		const a = new FakeBackend()
		const one = driver(a)
		const shotA = await one.adapter.captureWindow('0x111')
		await one.adapter.executeWindow(shotA.captureId, click)
		await expect(one.adapter.settleAfterInput({ budgetMs: 500 })).resolves.toBeUndefined()
		// The host went down.
		a.isReady = false
		await expect(
			one.adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await one.adapter.dispose()

		// The marker could not be taken: the input still goes, the settle has nothing to count from.
		const b = new FakeBackend()
		const two = driver(b)
		const shotB = await two.adapter.captureWindow('0x111')
		b.seqFails = true
		await expect(two.adapter.executeWindow(shotB.captureId, click)).resolves.toMatchObject({
			delivery: expect.stringMatching(/^delivered/),
		})
		await expect(
			two.adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await two.adapter.dispose()

		// The wait failed.
		const c = new FakeBackend()
		c.wait = async () => {
			throw new Error('helper gone')
		}
		const three = driver(c)
		const shotC = await three.adapter.captureWindow('0x111')
		await three.adapter.executeWindow(shotC.captureId, click)
		await expect(
			three.adapter.settleAfterInput({ windowId: '0x111', budgetMs: 500 }),
		).resolves.toBeUndefined()
		await three.adapter.dispose()
	})
})

describe('the host’s settle', () => {
	const adapterWith = (settleAfterInput?: Adapter['settleAfterInput']): Adapter => ({
		capabilities: Object.freeze({
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: false,
			clipboard: false,
		}),
		getDisplayGeometry: async () => ({ width: 10, height: 10, scaleFactor: 1 }),
		execute: async () => ({ type: 'ok' }),
		...(settleAfterInput ? { settleAfterInput } : {}),
	})

	it('hands the tool’s request to the adapter and returns its answer', async () => {
		const seen: unknown[] = []
		const host = new SubprocessComputerUseHost({
			adapter: adapterWith(async (request) => {
				seen.push(request)
				return { waitedMs: 120, changed: true }
			}),
		})
		await expect(host.settle({ windowId: '0x1', budgetMs: 500 })).resolves.toEqual({
			waitedMs: 120,
			changed: true,
		})
		expect(seen).toEqual([{ windowId: '0x1', budgetMs: 500 }])
	})

	it('says nothing when the adapter has no way to know, so the tool pauses as it always did', async () => {
		const host = new SubprocessComputerUseHost({ adapter: adapterWith() })
		await expect(host.settle({ windowId: '0x1', budgetMs: 500 })).resolves.toBeUndefined()
	})
})
