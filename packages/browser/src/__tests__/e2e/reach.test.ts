import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserActAction } from '@namzu/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LocalBrowserPlan } from '../../detect.js'
import { PlaywrightBrowserHost } from '../../host.js'
import { type ReachServer, startReachServer } from './reach/reach-server.js'

/**
 * Reaching the right element, against a real Chromium. Opt in with
 * NAMZU_BROWSER_E2E=1 (see `test:e2e:reach`); nothing is downloaded.
 */
const E2E = process.env.NAMZU_BROWSER_E2E === '1'

const plan: LocalBrowserPlan = {
	engine: 'local',
	platform: 'linux',
	browser: 'chromium',
	headless: true,
	display: false,
	warnings: [],
}

function refOf(text: string, pattern: RegExp): string {
	const line = text.split('\n').find((l) => pattern.test(l))
	const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined
	if (!ref) throw new Error(`no ref for ${pattern} in:\n${text}`)
	return ref
}

async function failure(run: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await run
	} catch (error) {
		return error as Record<string, unknown>
	}
	throw new Error('expected the call to be refused')
}

describe.skipIf(!E2E)('reaching the right element', { timeout: 60_000 }, () => {
	let server: ReachServer
	let home: string
	let host: PlaywrightBrowserHost

	const open = async (path: string) => {
		await host.observe({ action: 'navigate', url: `${server.main}${path}` })
	}
	const text = async () => {
		const result = await host.observe({ action: 'snapshot' })
		if (!result.snapshot) throw new Error('no snapshot')
		return result.snapshot.text
	}
	const act = (action: { action: string } & Record<string, unknown>) =>
		host.act({ ...action, origin: server.main } as unknown as BrowserActAction)

	beforeAll(async () => {
		server = await startReachServer()
		home = mkdtempSync(join(tmpdir(), 'namzu-reach-e2e-'))
		host = new PlaywrightBrowserHost({
			home,
			plan,
			profile: 'reach',
			sessionId: 'reach',
			// Short enough that a covered control fails fast; no test waits on it.
			actionTimeoutMs: 2_000,
			sites: { [server.main]: 'act', [server.alias]: 'act', [server.inner]: 'act', '*': 'ask' },
		})
	})

	afterAll(async () => {
		await host?.dispose()
		await server?.close()
		rmSync(home, { recursive: true, force: true })
	})

	describe('hover and click aim inside a container', () => {
		it('opens a hover menu from the ref of the wide section around its title', async () => {
			await open('/hover')
			const ref = refOf(await text(), /Products/)
			await act({ action: 'hover', ref })
			// The menu is open: its links are in the tree and one can be clicked.
			const after = await text()
			expect(after).toMatch(/link "Reports"/)
			await act({ action: 'click', ref: refOf(after, /link "Reports"/) })
			expect(await text()).toMatch(/Reports opened/)
		})

		it('lands on the control inside a wide container, not on its empty middle', async () => {
			await open('/wide')
			const ref = refOf(await text(), /group "Details panel"/)
			await act({ action: 'click', ref })
			expect(await text()).toMatch(/link clicked/)
		})

		it('keeps the middle for an element that is a control itself', async () => {
			await open('/ambiguous')
			const ref = refOf(await text(), /button "Save draft"/)
			await act({ action: 'click', ref })
			// No refusal and no extra effect: a plain click on a button still works.
			expect(await text()).toMatch(/button "Save draft"/)
		})
	})

	describe('click and hover by role and name, or by text', () => {
		it('hovers by visible text and then clicks by role and name', async () => {
			await open('/hover')
			await act({ action: 'hover', text: 'Products' })
			await act({ action: 'click', role: 'link', name: 'Reports' })
			expect(await text()).toMatch(/Reports opened/)
		})

		it('refuses several matches and lists the candidates', async () => {
			await open('/ambiguous')
			// "Save" also fits "Save draft", but the exact name narrows it to two.
			const error = await failure(act({ action: 'click', role: 'button', name: 'Save' }))
			expect(error).toMatchObject({ code: 'browser_target_unclear', matches: 2 })
			expect(error.candidates).toEqual([
				{ role: 'button', name: 'Save' },
				{ role: 'button', name: 'Save' },
			])
		})

		it('prefers the exact name when a short one also fits a longer one', async () => {
			await open('/ambiguous')
			// "Delete" is one link; "Save draft" matches "Save draft" exactly while "Save" is two buttons.
			await act({ action: 'click', role: 'button', name: 'Save draft' })
			await act({ action: 'click', role: 'link', name: 'Delete' })
		})

		it('refuses no match, listing the controls of that role', async () => {
			await open('/ambiguous')
			const error = await failure(act({ action: 'click', role: 'button', name: 'Publish' }))
			expect(error).toMatchObject({ code: 'browser_target_unclear', matches: 0 })
			expect((error.candidates as { name: string }[]).map((c) => c.name)).toEqual([
				'Save',
				'Save draft',
				'Save',
			])
		})

		it('refuses text that is not on the page', async () => {
			await open('/ambiguous')
			const error = await failure(act({ action: 'hover', text: 'No such words' }))
			expect(error).toMatchObject({ code: 'browser_target_unclear', matches: 0, candidates: [] })
		})
	})

	describe('press without a ref', () => {
		it('Escape closes a modal', async () => {
			await open('/modal')
			await act({ action: 'click', ref: refOf(await text(), /button "Open settings"/) })
			expect(await text()).toMatch(/Settings are open/)
			await act({ action: 'press', key: 'Escape' })
			expect(await text()).toMatch(/closed by Escape/)
		})

		it('accepts the named keys in any case and refuses the rest', async () => {
			await open('/modal')
			await act({ action: 'press', key: 'escape' })
			await act({ action: 'press', key: 'Shift+Tab' })
			const error = await failure(act({ action: 'press', key: 'Control+A' }))
			expect(String(error.message)).toContain('Escape, Enter, Tab, Shift+Tab')
		})

		it('refuses every named key while a password field has the focus', async () => {
			await open('/credentials')
			await act({ action: 'press', key: 'Tab' })
			await act({ action: 'press', key: 'Tab' })
			for (const key of ['Enter', 'Space', 'Tab', 'Escape']) {
				const error = await failure(act({ action: 'press', key }))
				expect(String(error.message)).toMatch(/password or one-time-code/)
			}
			expect(await text()).toMatch(/not submitted/)
		})

		it('refuses Enter in a text field whose form holds a password', async () => {
			await open('/credentials')
			await act({ action: 'press', key: 'Tab' })
			const error = await failure(act({ action: 'press', key: 'Enter' }))
			expect(String(error.message)).toMatch(/submit a form containing a password/)
			expect(await text()).toMatch(/not submitted/)
		})

		it('refuses Enter when the focus sits in a component it cannot read', async () => {
			await open('/closed-shadow')
			const error = await failure(act({ action: 'press', key: 'Enter' }))
			expect(String(error.message)).toMatch(/cannot be read/)
			// Keys that put nothing in a field are still allowed.
			await act({ action: 'press', key: 'PageDown' })
		})

		it('Enter with nothing focused does nothing and is allowed', async () => {
			await open('/hover')
			await act({ action: 'press', key: 'Home' })
		})
	})

	describe('type with real keys, clear and append', () => {
		it('autocomplete reacts to key events and not to a set value', async () => {
			await open('/autocomplete')
			const ref = refOf(await text(), /textbox "City"/)
			await act({ action: 'type', ref, text: 'li' })
			expect(await text()).not.toMatch(/option "Lisbon"/)
			await act({ action: 'type', ref, text: 'li', keys: true })
			const after = await text()
			expect(after).toMatch(/option "Lisbon"/)
			await act({ action: 'click', role: 'option', name: 'Lisbon' })
			expect(await text()).toMatch(/chose Lisbon/)
		})

		it('keys sends one key event per character', async () => {
			await open('/keys')
			const ref = refOf(await text(), /textbox "Query"/)
			await act({ action: 'type', ref, text: 'ab', keys: true })
			expect(await text()).toMatch(/a b/)
		})

		it('append keeps the existing text, with and without keys', async () => {
			await open('/keys')
			const ref = refOf(await text(), /textbox "Query"/)
			await act({ action: 'type', ref, text: '-1', append: true })
			expect(await text()).toMatch(/textbox "Query" \[ref=\w+\]: start-1$/m)
			await act({ action: 'type', ref, text: '-2', append: true, keys: true })
			expect(await text()).toMatch(/textbox "Query" \[ref=\w+\]: start-1-2$/m)
		})

		it('clear with empty text empties the field', async () => {
			await open('/keys')
			const ref = refOf(await text(), /textbox "Query"/)
			await act({ action: 'type', ref, text: '', clear: true })
			expect(await text()).not.toMatch(/start/)
		})
	})

	describe('a failed click says whether anything changed', () => {
		it('a covered control: nothing changed, one retry is safe', async () => {
			await open('/covered')
			const ref = refOf(await text(), /button "Submit order"/)
			const error = await failure(act({ action: 'click', ref }))
			expect(error).toMatchObject({
				code: 'browser_no_effect',
				outcome: 'unchanged',
				retrySafety: 'once-after-snapshot',
			})
			expect(String(error.message)).toContain('another element is covering it')
			expect(await text()).toMatch(/not clicked/)
		})

		it('a covered control fails the same way on hover', async () => {
			await open('/covered')
			const ref = refOf(await text(), /button "Submit order"/)
			const error = await failure(act({ action: 'hover', ref }))
			expect(error).toMatchObject({ code: 'browser_no_effect' })
		})
	})

	describe('a page that moved since the snapshot', () => {
		it('goes ahead when the site rules treat both origins alike, and says so', async () => {
			await open('/hover')
			const result = await host.act({
				action: 'hover',
				text: 'Products',
				origin: server.alias,
			})
			expect(result.message).toContain(`The page is now at ${server.main}, not ${server.alias}`)
		})

		it('refuses when the named origin is under other rules', async () => {
			await open('/hover')
			const error = await failure(
				host.act({ action: 'hover', text: 'Products', origin: 'https://example.com' }),
			)
			expect(error).toMatchObject({ code: 'browser_origin_mismatch' })
		})
	})

	describe('what the engine does with hard cases (recorded in docs/sdk/browser-host.md)', () => {
		it('a cross-origin frame: its content and refs are in the tree, and a click in it works', async () => {
			await open('/frame')
			const snap = await text()
			expect(snap).toMatch(/iframe \[ref=f\d+e\d+\]:/)
			const ref = refOf(snap, /button "Frame action"/)
			expect(ref).toMatch(/^f\d+e\d+$/)
			await act({ action: 'click', ref })
			expect(await text()).toMatch(/frame button pressed/)
			// By role and name, the lookup is the page's main frame only.
			const error = await failure(act({ action: 'click', role: 'button', name: 'Frame action' }))
			expect(error).toMatchObject({ code: 'browser_target_unclear', matches: 0 })
		})

		it('a cross-origin frame: typing works with a ref', async () => {
			await open('/frame')
			await act({ action: 'type', ref: refOf(await text(), /textbox "Note"/), text: 'hi' })
			expect(await text()).toMatch(/textbox "Note" \[ref=\w+\]: hi$/m)
		})

		it('a button in an open shadow root: it has a ref, and role and name find it', async () => {
			await open('/shadow')
			await act({ action: 'click', ref: refOf(await text(), /button "Shadow save"/) })
			expect(await text()).toMatch(/shadow pressed/)
			await open('/shadow')
			await act({ action: 'click', role: 'button', name: 'Shadow save' })
			expect(await text()).toMatch(/shadow pressed/)
		})

		it('a control drawn on a canvas: no ref and no name, so it cannot be addressed', async () => {
			await open('/canvas')
			const snap = await text()
			expect(snap).not.toMatch(/Draw OK/)
			expect(snap.split('\n')).toHaveLength(1)
			const error = await failure(act({ action: 'click', text: 'Draw OK' }))
			expect(error).toMatchObject({ code: 'browser_target_unclear', matches: 0 })
			expect(await text()).toMatch(/canvas untouched/)
		})

		it('a link that opens a tab: the new tab is adopted but not selected', async () => {
			await open('/popup')
			const result = await act({
				action: 'click',
				ref: refOf(await text(), /link "Open the report"/),
			})
			expect(result.message).toMatch(/new tab/i)
			expect(result.page?.tab).toBe('t1')
			const list = await host.observe({ action: 'tabs', op: 'list' })
			expect(list.tabs?.map((t) => [t.tab, t.active])).toEqual([
				['t1', true],
				['t2', false],
			])
			const selected = await host.observe({ action: 'tabs', op: 'select', tab: 't2' })
			expect(selected.page?.url).toBe(`${server.main}/popup-child`)
			expect(await text()).toMatch(/button "Print report"/)
			await host.observe({ action: 'tabs', op: 'close', tab: 't2' })
		})
	})
})
