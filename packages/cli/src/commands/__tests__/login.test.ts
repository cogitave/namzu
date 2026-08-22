import { describe, expect, it } from 'vitest'

import { describeLoginOutcome, describeLoginStart } from '../../tui/login-prompt.js'
import { loginCommand, logoutCommand, parseLoginFlags } from '../login.js'

describe('parseLoginFlags', () => {
	it('defaults to launching a browser and waiting five minutes', () => {
		const flags = parseLoginFlags([])
		expect(flags.noBrowser).toBe(false)
		expect(flags.provider).toBeUndefined()
		expect(flags.timeoutMs).toBe(300_000)
		expect(flags.unknown).toEqual([])
	})

	it('requires an explicit subscription and accepts both user-facing names', () => {
		expect(parseLoginFlags(['claude']).provider).toBe('anthropic')
		expect(parseLoginFlags(['codex']).provider).toBe('codex')
	})

	it('takes --no-browser, which is the container case', () => {
		expect(parseLoginFlags(['--no-browser']).noBrowser).toBe(true)
	})

	it('takes a timeout in seconds', () => {
		expect(parseLoginFlags(['--timeout', '30']).timeoutMs).toBe(30_000)
	})

	it('refuses a timeout it cannot read rather than falling back to the default', () => {
		// `--timeout 5m` means something specific to whoever wrote it. Waiting
		// the default instead makes a flag look honoured when it was discarded.
		for (const bad of ['5m', '', '-1', '0', 'abc']) {
			expect(parseLoginFlags(['--timeout', bad]).unknown.length).toBeGreaterThan(0)
		}
	})

	it('refuses an unrecognised flag rather than ignoring it', () => {
		expect(parseLoginFlags(['--code', 'abc']).unknown).toContain('--code')
	})
})

describe('the commands are reachable and describe themselves', () => {
	it('login renders its own help, because passThrough turns commander’s off', () => {
		expect(loginCommand.passThrough).toBe(true)
		expect(loginCommand.help).toBeDefined()
		expect(loginCommand.help).toContain('namzu login')
	})

	it('logout takes no arguments to misread', () => {
		expect(logoutCommand.passThrough).not.toBe(true)
	})

	it('names itself for what an operator is trying to do', () => {
		expect(loginCommand.name).toBe('login')
		expect(logoutCommand.name).toBe('logout')
	})
})

/**
 * Instructions must name the surface they are printed on.
 *
 * This is the defect that made the sign-in unreachable, in miniature: a
 * message telling someone to type a slash command works only where a composer
 * exists, and both of the surfaces below have none.
 */
describe('a surface names its own spelling of the command', () => {
	it('the terminal tells you to run namzu login, not to type a slash command', () => {
		const text = describeLoginOutcome(
			{ ok: false, reason: 'Something failed.' },
			{ retry: 'namzu login', remove: 'namzu logout' },
		)
		expect(text).toContain('namzu login')
		expect(text).not.toContain('/login')
	})

	it('and names namzu logout on success', () => {
		const text = describeLoginOutcome(
			{
				ok: true,
				credential: { accessToken: 'zzz-secret' },
				storedAt: '/p/credentials.json',
			},
			{ retry: 'namzu login', remove: 'namzu logout' },
		)
		expect(text).toContain('namzu logout')
		expect(text).not.toContain('/logout')
		expect(text).not.toContain('zzz-secret')
	})

	it('keeps the chat spelling when no surface says otherwise', () => {
		expect(describeLoginOutcome({ ok: false, reason: 'x' })).toContain('/login')
	})

	it('the completion hint is the surface’s own, not the chat’s', () => {
		const terminal = describeLoginStart({
			url: 'https://example.invalid/a',
			loopback: true,
			browserOpened: false,
			completionHint: 'paste it here and press enter',
		})
		expect(terminal).toContain('paste it here and press enter')
		expect(terminal).not.toContain('/login <')
	})
})
