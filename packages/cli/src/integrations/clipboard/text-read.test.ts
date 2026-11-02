import { describe, expect, it } from 'vitest'
import type { CommandResult, CommandRunner } from './image.js'
import { TEXT_READ_TIMEOUT_MS, looksLikeBinary, readClipboardText } from './text-read.js'

const MISSING: CommandResult = {
	code: null,
	stdout: Buffer.alloc(0),
	timedOut: false,
	spawnFailed: true,
}
const ok = (text: string): CommandResult => ({
	code: 0,
	stdout: Buffer.from(text),
	timedOut: false,
	spawnFailed: false,
})

function runner(answers: Record<string, CommandResult>) {
	const calls: { file: string; args: readonly string[]; timeoutMs: number }[] = []
	const run: CommandRunner = async (file, args, options) => {
		calls.push({ file, args, timeoutMs: options.timeoutMs })
		return answers[file] ?? MISSING
	}
	return { run, calls }
}
const noText = () => undefined

describe('telling text from binary', () => {
	it('flags a NUL and a run of replacement characters, not ordinary text', () => {
		expect(looksLikeBinary('abc\0def')).toBe(true)
		expect(looksLikeBinary(`${'a'.repeat(90)}${'�'.repeat(10)}`)).toBe(true)
		expect(looksLikeBinary(`${'a'.repeat(99)}�`)).toBe(false)
		expect(looksLikeBinary('Çalışma günü')).toBe(false)
		expect(looksLikeBinary('')).toBe(false)
	})
})

describe('reading the clipboard text', () => {
	it('asks PowerShell on WSL with a 2 second limit and the UTF-8 command', async () => {
		const { run, calls } = runner({ 'powershell.exe': ok('merhaba') })
		const text = await readClipboardText({
			platform: 'linux',
			env: { WSL_DISTRO_NAME: 'Ubuntu' },
			run,
			readText: noText,
		})
		expect(text).toBe('merhaba')
		expect(calls[0]?.timeoutMs).toBe(TEXT_READ_TIMEOUT_MS)
		expect(TEXT_READ_TIMEOUT_MS).toBe(2_000)
		expect(calls[0]?.args.at(-1)).toContain('Get-Clipboard -Raw')
	})

	it('uses xclip then wl-paste on plain Linux', async () => {
		const { run, calls } = runner({ 'wl-paste': ok('from wayland') })
		const text = await readClipboardText({ platform: 'linux', env: {}, run, readText: noText })
		expect(text).toBe('from wayland')
		expect(calls.map((call) => call.file)).toEqual(['xclip', 'wl-paste'])
	})

	it('gives nothing for binary, empty, timed-out or unreadable clipboards', async () => {
		const read = (answer: CommandResult) =>
			readClipboardText({
				platform: 'darwin',
				env: {},
				run: runner({ pbpaste: answer }).run,
				readText: noText,
			})
		expect(await read(ok('a\0b'))).toBeNull()
		expect(await read(ok(''))).toBeNull()
		expect(await read({ ...MISSING, spawnFailed: false, timedOut: true })).toBeNull()
		expect(await read(MISSING)).toBeNull()
	})
})
