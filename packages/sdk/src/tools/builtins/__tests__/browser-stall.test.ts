import { describe, expect, it } from 'vitest'
import type {
	BrowserCapabilities,
	BrowserHost,
	BrowserPageInfo,
	BrowserResult,
} from '../../../types/browser/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { createBrowserTools } from '../browser.js'

const PAGE: BrowserPageInfo = {
	origin: 'https://shop.example.com',
	url: 'https://shop.example.com/cart',
	title: 'Cart',
	tab: 't1',
}

function ctx(turn = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2'): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: turn as never,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

/** A host whose answers the test scripts; it counts what reached it. */
function scriptedHost() {
	const state = { acts: 0, observes: 0, page: PAGE, tree: 'tree-1', message: 'clicked' }
	const host: BrowserHost = {
		id: 'fake',
		capabilities: {
			engine: 'fake',
			headless: true,
			screenshot: false,
			upload: false,
		} as BrowserCapabilities,
		async observe(): Promise<BrowserResult> {
			state.observes += 1
			return { page: state.page, snapshot: { page: state.page, text: state.tree } }
		},
		async act(): Promise<BrowserResult> {
			state.acts += 1
			return { page: state.page, message: state.message }
		},
		describeRef: () => undefined,
		session: () => ({ origin: state.page.origin }),
	}
	return { host, state }
}

const click = (ref = 'e3') => ({ action: 'click', origin: PAGE.origin, ref }) as const

describe('browser stall guard', () => {
	it('notes the third identical no-change click and refuses the fifth without reaching the host', async () => {
		const { host, state } = scriptedHost()
		const [, act] = createBrowserTools(host)
		const outputs: string[] = []
		for (let i = 1; i <= 4; i += 1) {
			const result = await act.execute(click() as never, ctx())
			expect(result.success).toBe(true)
			outputs.push(result.output)
		}
		expect(outputs[0]).not.toContain('Note')
		expect(outputs[1]).not.toContain('Note')
		expect(outputs[2]).toContain('this same call has now run 3 times')
		expect(outputs[3]).toContain('run 4 times')
		expect(state.acts).toBe(4)

		const fifth = await act.execute(click() as never, ctx())
		expect(fifth.success).toBe(false)
		expect(fifth.error).toContain('refused')
		expect(fifth.error).toContain('5 times')
		expect(fifth.error).toContain('clicked')
		expect(state.acts).toBe(4)
	})

	it('starts over when the page changed, the target differs, or a new turn begins', async () => {
		const { host, state } = scriptedHost()
		const [browser, act] = createBrowserTools(host)
		for (let i = 0; i < 4; i += 1) await act.execute(click() as never, ctx())
		// A whole-page snapshot that shows a different tree is a change.
		state.tree = 'tree-2'
		await browser.execute({ action: 'snapshot' } as never, ctx())
		const afterChange = await act.execute(click() as never, ctx())
		expect(afterChange.output).not.toContain('Note')
		// Another element is another call.
		const other = await act.execute(click('e9') as never, ctx())
		expect(other.output).not.toContain('Note')
		// A new turn forgets the count.
		for (let i = 0; i < 4; i += 1) await act.execute(click() as never, ctx())
		const fresh = await act.execute(click() as never, ctx('7a0c5d9e-0000-4000-8000-000000000001'))
		expect(fresh.success).toBe(true)
		expect(fresh.output).not.toContain('Note')
	})

	it('does not count a repeat that changes the page each time', async () => {
		const { host, state } = scriptedHost()
		const [, act] = createBrowserTools(host)
		for (let i = 0; i < 8; i += 1) {
			state.page = { ...PAGE, url: `https://shop.example.com/page/${i}` }
			const result = await act.execute(
				{ action: 'click', origin: PAGE.origin, ref: 'e3' } as never,
				ctx(),
			)
			expect(result.success).toBe(true)
			expect(result.output).not.toContain('Note')
		}
		expect(state.acts).toBe(8)
	})

	it('does not count looking: repeated snapshots are never refused', async () => {
		const { host, state } = scriptedHost()
		const [browser] = createBrowserTools(host)
		for (let i = 0; i < 7; i += 1) {
			const result = await browser.execute({ action: 'snapshot' } as never, ctx())
			expect(result.success).toBe(true)
		}
		expect(state.observes).toBe(7)
	})

	it('asks the model to say what blocks it after twelve calls with no new address, tree or tab', async () => {
		const { host } = scriptedHost()
		const [, act] = createBrowserTools(host)
		const outputs: string[] = []
		for (let i = 0; i < 12; i += 1) {
			// Different refs each time, so no single call repeats five times.
			const result = await act.execute(click(`e${i + 10}`) as never, ctx())
			outputs.push(result.output)
		}
		expect(outputs.slice(0, 11).every((text) => !text.includes('brought no new'))).toBe(true)
		expect(outputs[11]).toContain('12 calls in a row have brought no new address')
	})
})
