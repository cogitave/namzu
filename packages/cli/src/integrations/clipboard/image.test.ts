import { describe, expect, it } from 'vitest'
import type { FitResult } from './image-fit.js'
import {
	CLIPBOARD_SCRIPT,
	type CommandResult,
	type CommandRunner,
	parsePowershellOutput,
	powershellCandidates,
	readClipboardImage,
	runCommand,
} from './image.js'

const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(16, 7),
])
const MISSING: CommandResult = {
	code: null,
	stdout: Buffer.alloc(0),
	timedOut: false,
	spawnFailed: true,
}
const ok = (stdout: Buffer | string): CommandResult => ({
	code: 0,
	stdout: Buffer.from(stdout),
	timedOut: false,
	spawnFailed: false,
})
const exit = (code: number): CommandResult => ({
	code,
	stdout: Buffer.alloc(0),
	timedOut: false,
	spawnFailed: false,
})
const TIMED_OUT: CommandResult = {
	code: null,
	stdout: Buffer.alloc(0),
	timedOut: true,
	spawnFailed: false,
}

/** A runner answering by program name; records what was run. */
function runner(answers: Record<string, CommandResult>): { run: CommandRunner; calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		run: async (file, args) => {
			calls.push(file)
			return answers[`${file} ${args.join(' ')}`] ?? answers[file] ?? MISSING
		},
	}
}

const keep = async (bytes: Buffer): Promise<FitResult> => ({
	ok: true,
	data: bytes,
	mediaType: 'image/png',
})
const readImage = (deps: Parameters<typeof readClipboardImage>[0] = {}) =>
	readClipboardImage({ fit: keep, ...deps })
const XCLIP_TARGETS = 'xclip -selection clipboard -t TARGETS -o'
const XCLIP_PNG = 'xclip -selection clipboard -t image/png -o'
const XCLIP_BMP = 'xclip -selection clipboard -t image/bmp -o'
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(30, 1)])

const wslEnv = { WSL_DISTRO_NAME: 'Ubuntu' }
const noText = () => undefined

describe('reading an image on Linux', () => {
	it('lists the targets, then takes the first tool that yields a PNG', async () => {
		const { run, calls } = runner({
			[XCLIP_TARGETS]: ok('TARGETS\nimage/png\n'),
			[XCLIP_PNG]: ok(PNG),
		})
		const result = await readImage({ platform: 'linux', env: {}, run, readText: noText })
		expect(result.kind).toBe('image')
		expect(calls).toEqual(['xclip', 'wl-paste', 'xclip'])
	})

	it('falls through to wl-paste when xclip is missing', async () => {
		const { run } = runner({
			'wl-paste -l': ok('image/png\ntext/plain\n'),
			'wl-paste --type image/png': ok(PNG),
		})
		const result = await readImage({ platform: 'linux', env: {}, run, readText: noText })
		expect(result.kind).toBe('image')
	})

	it('reads a BMP when no PNG is offered, and hands it to the image fitter as BMP', async () => {
		const seen: Buffer[] = []
		const { run } = runner({ [XCLIP_TARGETS]: ok('image/bmp\n'), [XCLIP_BMP]: ok(BMP) })
		const result = await readImage({
			platform: 'linux',
			env: {},
			run,
			readText: noText,
			fit: async (bytes) => {
				seen.push(bytes)
				return { ok: true, data: Buffer.from(PNG), mediaType: 'image/png' }
			},
		})
		expect(seen).toEqual([BMP])
		expect(result.kind === 'image' && result.image.data).toBe(PNG.toString('base64'))
	})

	it('reports an image the fitter refuses, with its reason', async () => {
		const { run } = runner({ [XCLIP_TARGETS]: ok('image/png\n'), [XCLIP_PNG]: ok(PNG) })
		const result = await readImage({
			platform: 'linux',
			env: {},
			run,
			readText: noText,
			fit: async () => ({ ok: false, message: 'Too large.' }),
		})
		expect(result).toEqual({ kind: 'refused', message: 'Too large.' })
	})

	it('does not ask for an image when the targets list none', async () => {
		const { run, calls } = runner({ [XCLIP_TARGETS]: ok('TARGETS\ntext/plain\n') })
		const result = await readImage({ platform: 'linux', env: {}, run, readText: noText })
		expect(result).toEqual({ kind: 'empty' })
		expect(calls).toEqual(['xclip', 'wl-paste'])
	})

	it('says empty when a tool ran and found no image, and unavailable when none exists', async () => {
		const empty = await readImage({
			platform: 'linux',
			env: {},
			run: runner({ xclip: exit(1) }).run,
			readText: noText,
		})
		expect(empty).toEqual({ kind: 'empty' })
		const none = await readImage({
			platform: 'linux',
			env: {},
			run: runner({}).run,
			readText: noText,
		})
		expect(none.kind).toBe('unavailable')
		expect(none.kind === 'unavailable' && none.wsl).toBeFalsy()
	})
})

describe('reading an image on WSL', () => {
	const b64 = PNG.toString('base64')

	it('asks PowerShell when no Linux tool exists, ignoring CRLF and a byte-order mark', async () => {
		const { run, calls } = runner({ 'powershell.exe': ok(`\uFEFF${b64}\r\n`) })
		const read = await readImage({ platform: 'linux', env: wslEnv, run, readText: noText })
		expect(read.kind).toBe('image')
		expect(read.kind === 'image' && read.image.data).toBe(b64)
		expect(calls).toEqual(['xclip', 'wl-paste', 'powershell.exe'])
	})

	it('finds powershell.exe at its fixed location when the PATH lacks it', async () => {
		const fixed = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
		const { run, calls } = runner({ [fixed]: ok(b64) })
		const read = await readImage({ platform: 'linux', env: wslEnv, run, readText: noText })
		expect(read.kind).toBe('image')
		expect(calls.at(-1)).toBe(fixed)
	})

	it('uses the drive mount root from wsl.conf', async () => {
		const moved = '/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
		const { run } = runner({ [moved]: ok(b64) })
		const read = await readImage({
			platform: 'linux',
			env: wslEnv,
			run,
			readText: (path) => (path === '/etc/wsl.conf' ? '[automount]\nroot=/win\n' : undefined),
		})
		expect(read.kind).toBe('image')
		expect(powershellCandidates('/win/')).toContain(moved)
	})

	it('reports empty for exit 3, failed for a timeout, and unavailable when nothing starts', async () => {
		const empty = await readImage({
			platform: 'linux',
			env: wslEnv,
			run: runner({ 'powershell.exe': exit(3) }).run,
			readText: noText,
		})
		expect(empty).toEqual({ kind: 'empty' })
		// Exit 1 is a script or interop error, never "no image".
		const broken = await readImage({
			platform: 'linux',
			env: wslEnv,
			run: runner({ 'powershell.exe': exit(1) }).run,
			readText: noText,
		})
		expect(broken).toEqual({ kind: 'failed', detail: 'exit 1' })
		expect(CLIPBOARD_SCRIPT).toContain('UTF8Encoding')
		const slow = await readImage({
			platform: 'linux',
			env: wslEnv,
			run: runner({ 'powershell.exe': TIMED_OUT }).run,
			readText: noText,
		})
		expect(slow).toEqual({ kind: 'failed', detail: 'timed out' })
		const none = await readImage({
			platform: 'linux',
			env: wslEnv,
			run: runner({}).run,
			readText: noText,
		})
		expect(none).toMatchObject({ kind: 'unavailable', wsl: true })
	})

	it('hands back image files copied in Explorer', async () => {
		const { run } = runner({
			'powershell.exe': ok('PATH:C:\\Users\\a\\1.png\r\nPATH:C:\\Users\\a\\2.jpg\r\n'),
		})
		const read = await readImage({ platform: 'linux', env: wslEnv, run, readText: noText })
		expect(read).toEqual({ kind: 'files', paths: ['C:\\Users\\a\\1.png', 'C:\\Users\\a\\2.jpg'] })
	})

	it('refuses output that is base64 but not a PNG', () => {
		expect(parsePowershellOutput(Buffer.from('QUJDREVGR0hJSktM\r\n')).kind).toBe('failed')
		expect(parsePowershellOutput(Buffer.from('#< CLIXML\r\nnoise\r\n')).kind).toBe('failed')
	})
})

describe('the PowerShell script', () => {
	it('is passed encoded, so no quoting reaches the shell', async () => {
		let seen: readonly string[] = []
		await readImage({
			platform: 'win32',
			env: {},
			run: async (_file, args) => {
				seen = args
				return exit(1)
			},
		})
		expect(seen.slice(0, 4)).toEqual(['-NoProfile', '-NonInteractive', '-Sta', '-EncodedCommand'])
		const script = Buffer.from(seen[4] ?? '', 'base64').toString('utf16le')
		expect(script).toContain('GetImage()')
		expect(script).toContain('2000')
	})
})

describe('the real command runner', () => {
	it('refuses to start a clipboard program when NAMZU_NO_CLIPBOARD is set', async () => {
		const before = process.env.NAMZU_NO_CLIPBOARD
		process.env.NAMZU_NO_CLIPBOARD = '1'
		try {
			const result = await runCommand('xclip', ['-o'], { timeoutMs: 5_000 })
			expect(result.spawnFailed).toBe(true)
			const ps = await runCommand('/mnt/c/Windows/powershell.exe', [], { timeoutMs: 5_000 })
			expect(ps.spawnFailed).toBe(true)
		} finally {
			if (before === undefined) Reflect.deleteProperty(process.env, 'NAMZU_NO_CLIPBOARD')
			else process.env.NAMZU_NO_CLIPBOARD = before
		}
	})

	it('reports a program that cannot start, without throwing', async () => {
		const result = await runCommand('namzu-no-such-program', [], { timeoutMs: 5_000 })
		expect(result.spawnFailed).toBe(true)
	})

	it('captures standard output and the exit code', async () => {
		const result = await runCommand(process.execPath, ['-e', 'process.stdout.write("hi")'], {
			timeoutMs: 30_000,
		})
		expect(result.code).toBe(0)
		expect(result.stdout.toString()).toBe('hi')
	}, 30_000)
})
