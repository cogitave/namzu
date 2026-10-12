import { describe, expect, it } from 'vitest'
import { LocalCommandError, type LocalComputerCommandRunner } from '../engine.js'
import { RESUME_AT_SIGN_IN_KEY, type WslcSetupHost } from '../setup/contract.js'
import { clearResumeAtSignIn, registerResumeAtSignIn } from '../setup/resume.js'

interface Call {
	binary: string
	args: readonly string[]
}

function hostWith(
	respond: (call: Call) => string | Error,
	overrides: Partial<WslcSetupHost> = {},
): { host: WslcSetupHost; calls: Call[] } {
	const calls: Call[] = []
	const runner: LocalComputerCommandRunner = {
		async run(binary, args) {
			const call = { binary, args }
			calls.push(call)
			const answer = respond(call)
			if (answer instanceof Error) throw answer
			return answer
		},
	}
	const host = {
		platform: 'win32',
		arch: 'x64',
		windowsBuild: 22631,
		env: { SystemRoot: 'C:\\Windows' },
		runner,
		stateDirectory: 'C:\\Users\\Someone\\AppData\\Local\\Namzu\\setup',
		resumeRegistryKey: RESUME_AT_SIGN_IN_KEY,
		...overrides,
	} as WslcSetupHost
	return { host, calls }
}

describe('registerResumeAtSignIn', () => {
	it('writes NamzuPalComputerSetup as REG_SZ under the host key with reg.exe add /f', async () => {
		const { host, calls } = hostWith(() => '')
		const command =
			'"C:\\Users\\Someone\\AppData\\Local\\Programs\\Namzu\\Namzu.exe" --resume-setup'
		await registerResumeAtSignIn(host, command)
		expect(calls).toEqual([
			{
				binary: 'C:\\Windows\\System32\\reg.exe',
				args: [
					'add',
					'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce',
					'/v',
					'NamzuPalComputerSetup',
					'/t',
					'REG_SZ',
					'/d',
					command,
					'/f',
				],
			},
		])
	})

	it('uses a scratch key when the host points at one', async () => {
		const { host, calls } = hostWith(() => '', {
			resumeRegistryKey: 'HKCU\\Software\\NamzuT4Scratch',
		})
		await registerResumeAtSignIn(host, 'namzu.exe resume')
		expect(calls[0]?.args[1]).toBe('HKCU\\Software\\NamzuT4Scratch')
	})

	it.each([
		['an empty command', ''],
		['a blank command', '   '],
		['a line break', 'namzu.exe\r\ncalc.exe'],
		['a newline', 'namzu.exe\ncalc.exe'],
		['a NUL', 'namzu.exe\0'],
		['a command over 2048 characters', 'x'.repeat(2049)],
	])('refuses %s without calling reg.exe', async (_name, command) => {
		const { host, calls } = hostWith(() => '')
		await expect(registerResumeAtSignIn(host, command)).rejects.toThrow()
		expect(calls).toEqual([])
	})

	it('accepts a command of exactly 2048 characters', async () => {
		const { host, calls } = hostWith(() => '')
		await registerResumeAtSignIn(host, 'x'.repeat(2048))
		expect(calls).toHaveLength(1)
	})

	it.each(['', 'Software\\Foo', 'HKCU', 'HKCU\\a\nb', 'HKCU\\a"b', 'HKEY_FOO\\Software'])(
		'refuses the registry key %j',
		async (key) => {
			const { host, calls } = hostWith(() => '', { resumeRegistryKey: key })
			await expect(registerResumeAtSignIn(host, 'namzu.exe')).rejects.toThrow()
			await expect(clearResumeAtSignIn(host)).rejects.toThrow()
			expect(calls).toEqual([])
		},
	)

	it('passes a failure of reg.exe on', async () => {
		const { host } = hostWith(() => new Error('exit 1'))
		await expect(registerResumeAtSignIn(host, 'namzu.exe')).rejects.toThrow('exit 1')
	})
})

describe('clearResumeAtSignIn', () => {
	it('queries the value and then deletes it', async () => {
		const { host, calls } = hostWith(() => '')
		await clearResumeAtSignIn(host)
		const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce'
		expect(calls.map((call) => call.args)).toEqual([
			['query', key, '/v', 'NamzuPalComputerSetup'],
			['delete', key, '/v', 'NamzuPalComputerSetup', '/f'],
		])
		expect(calls.every((call) => call.binary === 'C:\\Windows\\System32\\reg.exe')).toBe(true)
	})

	it('treats an absent value as nothing to do', async () => {
		const { host, calls } = hostWith((call) =>
			call.args[0] === 'query' ? new LocalCommandError('absent', [], 1) : '',
		)
		await expect(clearResumeAtSignIn(host)).resolves.toBeUndefined()
		expect(calls.map((call) => call.args[0])).toEqual(['query'])
	})

	it('rethrows a query that failed for any reason but "not found"', async () => {
		for (const failure of [
			new LocalCommandError('access denied', [], 5),
			new LocalCommandError('could not start', ['ENOENT']),
			new Error('timed out'),
		]) {
			const { host, calls } = hostWith((call) => (call.args[0] === 'query' ? failure : ''))
			await expect(clearResumeAtSignIn(host)).rejects.toBe(failure)
			expect(calls.map((call) => call.args[0])).toEqual(['query'])
		}
	})

	it('reports a delete that fails after the value was found', async () => {
		const { host } = hostWith((call) => (call.args[0] === 'delete' ? new Error('exit 5') : ''))
		await expect(clearResumeAtSignIn(host)).rejects.toThrow('exit 5')
	})

	it('finds reg.exe through windir when SystemRoot is not set', async () => {
		const { host, calls } = hostWith(() => '', { env: { windir: 'D:\\Windows\\' } })
		await clearResumeAtSignIn(host)
		expect(calls[0]?.binary).toBe('D:\\Windows\\System32\\reg.exe')
	})

	it('never takes reg.exe from an environment-chosen folder', async () => {
		for (const root of [
			'C:\\Users\\evil',
			'D:\\Win',
			'\\\\server\\share\\Windows',
			'C:\\Windows\\..\\evil',
		]) {
			const { host, calls } = hostWith(() => '', { env: { SystemRoot: root } })
			await clearResumeAtSignIn(host)
			expect(calls[0]?.binary).toBe('C:\\Windows\\System32\\reg.exe')
		}
	})
})
