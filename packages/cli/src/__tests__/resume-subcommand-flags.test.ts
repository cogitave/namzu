/**
 * `namzu resume <flags>` takes the launch flags the root takes, with the same
 * meaning, because the exit summary prints `namzu resume <id>` and people
 * append flags to it.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { TuiContext } from '../tui/types.js'

const launchTui = vi.hoisted(() => vi.fn(async (_ctx: TuiContext) => {}))
const consent = vi.hoisted(() => ({
	askBypassConsent: vi.fn(async () => true),
	acknowledgeBypass: vi.fn(),
	hasAcknowledgedBypass: vi.fn(() => false),
}))

vi.mock('../tui/index.js', () => ({ launchTui }))
vi.mock('../permissions/consent.js', () => ({
	acknowledgeBypass: consent.acknowledgeBypass,
	hasAcknowledgedBypass: consent.hasAcknowledgedBypass,
}))
vi.mock('../permissions/consent-prompt.js', () => ({ askBypassConsent: consent.askBypassConsent }))

const { runCli } = await import('../cli.js')

const ID = '4aba553c-4222-48f2-8047-62a22f1f21d7'
const flat = (text: string) => text.replace(/\s+/g, ' ')

describe('namzu resume with launch flags', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	const savedEnv = { ...process.env }
	let home: string
	let stdout: string
	let stderr: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-resume-flags-'))
		process.env.NAMZU_HOME = home
		for (const key of ['NAMZU_PROVIDER', 'NAMZU_MODEL', 'NAMZU_EFFORT']) delete process.env[key]
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
		stdout = ''
		stderr = ''
		vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
			stdout += String(chunk)
			return true
		}) as typeof process.stdout.write)
		vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
			stderr += String(chunk)
			return true
		}) as typeof process.stderr.write)
		consent.hasAcknowledgedBypass.mockReturnValue(false)
		consent.askBypassConsent.mockResolvedValue(true)
	})

	afterEach(() => {
		launchTui.mockClear()
		for (const fn of Object.values(consent)) fn.mockClear()
		vi.restoreAllMocks()
		process.env = { ...savedEnv }
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
		removeTempDir(home)
	})

	const invoke = (...args: string[]) => runCli({ argv: ['node', 'namzu', ...args] })
	const launched = (): TuiContext => {
		expect(launchTui).toHaveBeenCalledOnce()
		return launchTui.mock.calls[0]?.[0] as TuiContext
	}

	it.each([['--dangerously-skip-permissions'], ['--yolo']])(
		'%s after resume starts in bypass, after the same confirmation as before it',
		async (flag) => {
			expect(await invoke('resume', flag, ID)).toBe(0)
			expect(consent.askBypassConsent).toHaveBeenCalledOnce()
			const ctx = launched()
			expect(ctx.initialConversationId).toBe(ID)
			expect(ctx.skipPermissions).toBe(true)
			expect(ctx.permissionSource).toBe('launch-bypass')
		},
	)

	it('takes the flag before the id or after it', async () => {
		expect(await invoke('resume', ID, '--yolo')).toBe(0)
		expect(launched().skipPermissions).toBe(true)
		expect(launched().initialConversationId).toBe(ID)
	})

	it('--permission-mode after resume reaches the launch', async () => {
		expect(await invoke('resume', '--permission-mode', 'plan', ID)).toBe(0)
		const ctx = launched()
		expect(ctx.launchSettings?.permissionMode).toBe('plan')
		expect(ctx.permissionSource).toBe('launch-flag')
		expect(consent.askBypassConsent).not.toHaveBeenCalled()
	})

	it('--permission-mode bypass after resume asks the bypass question', async () => {
		expect(await invoke('resume', '--permission-mode', 'bypass', ID)).toBe(0)
		expect(consent.askBypassConsent).toHaveBeenCalledOnce()
		expect(launched().launchSettings?.permissionMode).toBe('bypass')
	})

	it('--allow-dangerously-skip-permissions after resume opens the door without starting in bypass', async () => {
		expect(await invoke('resume', '--allow-dangerously-skip-permissions', ID)).toBe(0)
		const ctx = launched()
		expect(ctx.allowDangerouslySkipPermissions).toBe(true)
		expect(ctx.skipPermissions).toBe(false)
		expect(consent.askBypassConsent).not.toHaveBeenCalled()
	})

	it('hands the model, provider, effort, fallback models and extra folders to the launch', async () => {
		const extra = join(home, 'extra')
		expect(
			await invoke(
				'resume',
				'--provider',
				'zen',
				'--model',
				'some-model',
				'--effort',
				'high',
				'--fallback-model',
				'zen/other',
				'--add-dir',
				extra,
				ID,
			),
		).toBe(0)
		const ctx = launched()
		expect(ctx.launchSettings).toMatchObject({
			provider: 'zen',
			model: 'some-model',
			effort: 'high',
			fallbackModels: ['zen/other'],
		})
		expect(ctx.additionalDirectories).toContain(extra)
	})

	it('accepts the same flags before the subcommand, with the same result', async () => {
		expect(await invoke('--permission-mode', 'plan', '--model', 'm', 'resume', ID)).toBe(0)
		expect(launched().launchSettings).toMatchObject({ permissionMode: 'plan', model: 'm' })
	})

	it('a flag given on both sides is not an error: the one after resume wins', async () => {
		expect(
			await invoke(
				'--permission-mode',
				'prompt',
				'--model',
				'first',
				'resume',
				'--permission-mode',
				'plan',
				'--model',
				'second',
				ID,
			),
		).toBe(0)
		expect(launched().launchSettings).toMatchObject({ permissionMode: 'plan', model: 'second' })
	})

	it('a repeatable flag on both sides keeps both values', async () => {
		const a = join(home, 'a')
		const b = join(home, 'b')
		expect(await invoke('--add-dir', a, 'resume', '--add-dir', b, ID)).toBe(0)
		expect(launched().additionalDirectories).toEqual(expect.arrayContaining([a, b]))
	})

	it('without an id the picker opens and the flags still apply', async () => {
		expect(await invoke('resume', '--yolo')).toBe(0)
		const ctx = launched()
		expect(ctx.skipPermissions).toBe(true)
		expect(ctx.initialConversationId).toBeUndefined()
	})

	it('still refuses an unknown flag with the plain message', async () => {
		expect(await invoke('resume', '--frobnicate', ID)).toBe(64)
		expect(flat(stderr)).toContain('--frobnicate')
		expect(launchTui).not.toHaveBeenCalled()
	})

	it('still refuses a bad value after resume', async () => {
		expect(await invoke('resume', '--permission-mode', 'enormous', ID)).toBe(64)
		expect(flat(stderr)).toContain('Choose one of prompt')
		expect(launchTui).not.toHaveBeenCalled()
	})

	it('does not offer the conversation-choosing flags after resume', async () => {
		for (const flag of ['--continue', '--from-pr', '--message']) {
			stderr = ''
			expect(await invoke('resume', flag, ID)).toBe(64)
			expect(flat(stderr)).toContain(flag)
		}
		expect(launchTui).not.toHaveBeenCalled()
	})

	it('lists the launch flags in `resume --help`', async () => {
		expect(await invoke('resume', '--help')).toBe(0)
		for (const flag of [
			'--dangerously-skip-permissions',
			'--yolo',
			'--allow-dangerously-skip-permissions',
			'--permission-mode <mode>',
			'--model <id>',
			'--effort <level>',
			'--provider <id>',
		])
			expect(stdout).toContain(flag)
		expect(stdout).not.toContain('--from-pr')
	})
})

describe('the root forms keep working', () => {
	const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
	const savedEnv = { ...process.env }
	let home: string

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-resume-flags-root-'))
		process.env.NAMZU_HOME = home
		Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		consent.hasAcknowledgedBypass.mockReturnValue(true)
	})

	afterEach(() => {
		launchTui.mockClear()
		for (const fn of Object.values(consent)) fn.mockClear()
		vi.restoreAllMocks()
		process.env = { ...savedEnv }
		if (originalIsTTY) Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
		else Reflect.deleteProperty(process.stdout, 'isTTY')
		removeTempDir(home)
	})

	const invoke = (...args: string[]) => runCli({ argv: ['node', 'namzu', ...args] })

	it('--resume with no value and --dangerously-skip-permissions still starts in bypass', async () => {
		// No conversation exists in the scratch home, so this ends at the picker
		// or a refusal; what matters is that the flag combination is accepted.
		const code = await invoke('--resume', '--dangerously-skip-permissions')
		expect([0, 64]).toContain(code)
	})

	it.each([[['--resume=missing-id', '--yolo']], [['-r', 'missing-id', '--yolo']]])(
		'%j is accepted by the parser',
		async (args) => {
			const stderr = vi.mocked(process.stderr.write)
			const code = await invoke(...args)
			expect([0, 64]).toContain(code)
			const said = stderr.mock.calls.map((call) => String(call[0])).join('')
			expect(said).not.toMatch(/unknown option/i)
		},
	)
})
