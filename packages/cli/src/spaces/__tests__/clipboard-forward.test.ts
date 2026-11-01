import { describe, expect, it } from 'vitest'
import { MAX_CLIPBOARD_TEXT_BYTES } from '../../integrations/clipboard/text.js'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { setup } from './support/harness.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

function rig(extra: Parameters<typeof setup>[1] = {}) {
	const clock = { now: 10_000 }
	const t = setup({ columns: 100, rows: 30 }, { now: () => clock.now, env: {}, ...extra })
	t.host.start()
	const pty = t.spawned[0] as FakePty
	const screen = (t.host.roster.selected?.child as { screen: { settled(): Promise<void> } }).screen
	const request = async (payload: string, end = BEL) => {
		const mark = t.written.length
		pty.print(`${ESC}]52;${payload}${end}`)
		await screen.settled()
		return t.written.slice(mark).join('')
	}
	return { t, pty, request, clock }
}

describe('a pane asking for the clipboard', () => {
	it('reaches the terminal, so /copy works inside a pane', async () => {
		const { request } = rig()
		expect(await request(`c;${b64('from the pane')}`)).toBe(
			`${ESC}]52;c;${b64('from the pane')}${BEL}`,
		)
	})

	it('also works with the string terminator and an empty selector', async () => {
		const { request, clock } = rig()
		expect(await request(`;${b64('one')}`, `${ESC}\\`)).toContain(b64('one'))
		clock.now += 300
		expect(await request(`p;${b64('two')}`)).toContain(b64('two'))
	})

	it('never answers or forwards a query', async () => {
		const { request, pty } = rig()
		expect(await request('c;?')).toBe('')
		expect(pty.writes).toEqual([])
	})

	it('drops what is not valid base64, an unknown target, or nothing to set', async () => {
		const { request } = rig()
		expect(await request('c;not*base64!')).toBe('')
		expect(await request('c;abc')).toBe('')
		expect(await request('c;')).toBe('')
		expect(await request(`s;${b64('x')}`)).toBe('')
		expect(await request(b64('x'))).toBe('')
	})

	it('drops text above the limit', async () => {
		const { request, clock } = rig()
		expect(await request(`c;${b64('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1))}`)).toBe('')
		clock.now += 300
		expect(await request(`c;${b64('a'.repeat(MAX_CLIPBOARD_TEXT_BYTES))}`)).toContain(ESC)
	})

	it('lets one request through every 250 ms', async () => {
		const { request, clock } = rig()
		expect(await request(`c;${b64('a')}`)).toContain(b64('a'))
		clock.now += 249
		expect(await request(`c;${b64('b')}`)).toBe('')
		clock.now += 1
		expect(await request(`c;${b64('c')}`)).toContain(b64('c'))
	})

	it('is wrapped for tmux like any other copy', async () => {
		const { request } = rig({ env: { TMUX: '1' } })
		expect(await request(`c;${b64('x')}`)).toBe(
			`${ESC}Ptmux;${ESC}${ESC}]52;c;${b64('x')}${BEL}${ESC}\\`,
		)
	})
})
