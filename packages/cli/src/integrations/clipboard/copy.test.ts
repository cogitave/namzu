import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	type ClipboardRunner,
	type CopyHost,
	NATIVE_TIMEOUT_MS,
	POWERSHELL_COPY_SCRIPT,
	bypassKey,
	createClipboardCopier,
	describeCopy,
	realRunner,
} from './copy.js'
import { MAX_CLIPBOARD_TEXT_BYTES } from './text.js'

const OSC = (text: string): string =>
	`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`

interface Call {
	command: string
	args: readonly string[]
	input: string
	timeoutMs: number
}

function rig(
	host: Omit<CopyHost, 'run'> & { present?: readonly string[]; failing?: readonly string[] },
	opts: { isTTY?: boolean } = {},
) {
	const calls: Call[] = []
	const written: string[] = []
	const { present = [], failing = [], ...rest } = host
	const run: ClipboardRunner = async (command, args, input, timeoutMs) => {
		calls.push({ command, args, input, timeoutMs })
		return !failing.some((f) => command.endsWith(f))
	}
	const which = (name: string): string | null => (present.includes(name) ? `/bin/${name}` : null)
	const copier = createClipboardCopier(
		{ isTTY: opts.isTTY ?? true, write: (d) => void written.push(d) },
		{ which, exists: () => false, ...rest, run },
	)
	return { copier, calls, written }
}

describe('native first', () => {
	it('uses pbcopy on macOS, text on stdin, 2 s', async () => {
		const { copier, calls, written } = rig({ platform: 'darwin', env: {}, present: ['pbcopy'] })
		const out = await copier.copy('hello')
		expect(calls).toEqual([{ command: '/bin/pbcopy', args: [], input: 'hello', timeoutMs: 2000 }])
		expect(NATIVE_TIMEOUT_MS).toBe(2000)
		expect(out).toMatchObject({ native: 'pbcopy', osc52: 'sent', chars: 5 })
		expect(written).toEqual([OSC('hello')])
	})

	it('uses powershell on Windows with UTF-8 set explicitly and the text only on stdin', async () => {
		const { copier, calls } = rig({ platform: 'win32', env: {} })
		await copier.copy('Çok güzel 你好')
		expect(calls).toHaveLength(1)
		expect(calls[0]?.command).toBe('powershell')
		expect(calls[0]?.args).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			POWERSHELL_COPY_SCRIPT,
		])
		expect(POWERSHELL_COPY_SCRIPT).toMatch(/InputEncoding = \$u/)
		expect(POWERSHELL_COPY_SCRIPT).toMatch(/OutputEncoding = \$u/)
		expect(POWERSHELL_COPY_SCRIPT).toContain('UTF8Encoding $false')
		expect(POWERSHELL_COPY_SCRIPT).toContain('Set-Clipboard')
		expect(calls[0]?.input).toBe('Çok güzel 你好')
		expect(calls[0]?.args.join(' ')).not.toContain('güzel')
	})

	it('finds powershell.exe on PATH under WSL and never reaches for clip.exe', async () => {
		const { copier, calls } = rig({
			platform: 'linux',
			env: { WSL_DISTRO_NAME: 'Arch' },
			present: ['powershell.exe', 'clip.exe'],
		})
		const out = await copier.copy('İstanbul ğüşöç')
		expect(calls.map((c) => c.command)).toEqual(['/bin/powershell.exe'])
		expect(calls[0]?.input).toBe('İstanbul ğüşöç')
		expect(out?.native).toBe('powershell.exe')
	})

	it('falls back to the Windows drive when PATH has no powershell.exe', async () => {
		const { copier, calls } = rig({
			platform: 'linux',
			env: { WSL_INTEROP: '/run/WSL/1_interop' },
			mountRoot: '/win/',
			exists: (p) => p === '/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
		})
		await copier.copy('x')
		expect(calls[0]?.command).toBe('/win/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
	})

	it('has no native tool under WSL when powershell.exe is nowhere, and does not try clip.exe', async () => {
		const { copier, calls, written } = rig({
			platform: 'linux',
			env: { WSL_DISTRO_NAME: 'Arch' },
			present: ['clip.exe', 'xclip'],
			mountRoot: '/mnt/',
		})
		const out = await copier.copy('x')
		expect(calls).toEqual([])
		expect(out).toMatchObject({ native: null, osc52: 'sent' })
		expect(written).toEqual([OSC('x')])
	})

	it('tries wl-copy (clipboard then primary), then xclip, then xsel, only for the display that is up', async () => {
		const env = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }
		const present = ['wl-copy', 'xclip', 'xsel']
		const a = rig({ platform: 'linux', env, present })
		await a.copier.copy('t')
		expect(a.calls.map((c) => [c.command, ...c.args])).toEqual([
			['/bin/wl-copy'],
			['/bin/wl-copy', '--primary'],
		])

		const b = rig({ platform: 'linux', env, present, failing: ['wl-copy', 'xclip'] })
		const out = await b.copier.copy('t')
		expect(b.calls.map((c) => c.command)).toEqual([
			'/bin/wl-copy',
			'/bin/xclip',
			'/bin/xsel',
			'/bin/xsel',
		])
		expect(out?.native).toBe('xsel')

		const c = rig({ platform: 'linux', env: { DISPLAY: ':0' }, present })
		await c.copier.copy('t')
		expect(c.calls.map((x) => [x.command, ...x.args])).toEqual([
			['/bin/xclip', '-selection', 'clipboard'],
			['/bin/xclip', '-selection', 'primary'],
		])

		const d = rig({ platform: 'linux', env: {}, present })
		expect((await d.copier.copy('t'))?.native).toBeNull()
		expect(d.calls).toEqual([])
	})

	it('skips the machine tool over a remote login', async () => {
		for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) {
			const { copier, calls, written } = rig({
				platform: 'darwin',
				env: { [key]: 'x' },
				present: ['pbcopy'],
			})
			const out = await copier.copy('t')
			expect(calls).toEqual([])
			expect(out).toMatchObject({ native: null, osc52: 'sent' })
			expect(written).toEqual([OSC('t')])
		}
	})
})

describe('the terminal request after the tool', () => {
	const linux = { platform: 'linux' as const, present: ['xclip'] }

	it('is skipped only when a Linux tool worked and the terminal is VTE-based', async () => {
		const vte = rig({ ...linux, env: { DISPLAY: ':0', VTE_VERSION: '7000' } })
		expect(await vte.copier.copy('t')).toMatchObject({ native: 'xclip', osc52: 'skipped' })
		expect(vte.written).toEqual([])

		const plain = rig({ ...linux, env: { DISPLAY: ':0' } })
		expect(await plain.copier.copy('t')).toMatchObject({ native: 'xclip', osc52: 'sent' })
		expect(plain.written).toEqual([OSC('t')])

		const toolFailed = rig({
			...linux,
			failing: ['xclip'],
			env: { DISPLAY: ':0', VTE_VERSION: '7' },
		})
		expect(await toolFailed.copier.copy('t')).toMatchObject({ native: null, osc52: 'sent' })

		const mac = rig({ platform: 'darwin', present: ['pbcopy'], env: { VTE_VERSION: '7' } })
		expect(await mac.copier.copy('t')).toMatchObject({ native: 'pbcopy', osc52: 'sent' })
	})

	it('wraps for tmux and also loads the buffer, retrying without -w', async () => {
		const env = { TMUX: '/tmp/tmux,1,0' }
		const ok = rig({ platform: 'linux', env, present: ['tmux'] })
		const out = await ok.copier.copy('hi')
		expect(ok.written[0]).toBe(
			`\x1bPtmux;\x1b\x1b]52;c;${Buffer.from('hi').toString('base64')}\x07\x1b\\`,
		)
		expect(ok.calls).toEqual([
			{ command: '/bin/tmux', args: ['load-buffer', '-w', '-'], input: 'hi', timeoutMs: 2000 },
		])
		expect(out?.tmuxBuffer).toBe(true)

		let n = 0
		const calls: string[][] = []
		const retry = createClipboardCopier(
			{ isTTY: true, write: () => {} },
			{
				platform: 'linux',
				env,
				which: (name) => (name === 'tmux' ? '/bin/tmux' : null),
				run: async (_c, args) => {
					calls.push([...args])
					return n++ > 0
				},
			},
		)
		expect((await retry.copy('hi'))?.tmuxBuffer).toBe(true)
		expect(calls).toEqual([
			['load-buffer', '-w', '-'],
			['load-buffer', '-'],
		])

		const none = rig({ platform: 'linux', env, present: [] })
		expect((await none.copier.copy('hi'))?.tmuxBuffer).toBe(false)
	})

	it('cuts the request into 76-character pieces for screen', async () => {
		const { copier, written } = rig({ platform: 'linux', env: { STY: '1.pts' } })
		await copier.copy('ç'.repeat(100))
		expect(written[0]?.split('\x1bP\x1b]52;c;').length).toBeGreaterThan(2)
	})

	it('reports a terminal that is not interactive, a text too large, and a failed write', async () => {
		const quiet = rig({ platform: 'linux', env: {} }, { isTTY: false })
		expect(await quiet.copier.copy('t')).toMatchObject({ osc52: 'unavailable' })
		expect(quiet.written).toEqual([])

		const big = 'a'.repeat(MAX_CLIPBOARD_TEXT_BYTES + 1)
		const tooBig = rig({ platform: 'linux', env: {} })
		expect(await tooBig.copier.copy(big)).toMatchObject({ native: null, osc52: 'too-large' })

		// The tool has no such limit; only the terminal request is capped.
		const tool = rig({ platform: 'darwin', env: {}, present: ['pbcopy'] })
		const out = await tool.copier.copy(big)
		expect(out).toMatchObject({ native: 'pbcopy', osc52: 'too-large' })
		expect(tool.calls[0]?.input).toBe(big)
		expect(describeCopy(out as NonNullable<typeof out>).ok).toBe(true)

		const broken = createClipboardCopier(
			{
				isTTY: true,
				write: () => {
					throw new Error('closed')
				},
			},
			{ platform: 'linux', env: {}, which: () => null },
		)
		expect(await broken.copy('t')).toMatchObject({ osc52: 'failed' })
	})
})

describe('never in the way', () => {
	it('runs one copy at a time and lets a newer one replace one that is waiting', async () => {
		const gates: Array<() => void> = []
		const started: string[] = []
		const copier = createClipboardCopier(
			{ isTTY: true, write: () => {} },
			{
				platform: 'darwin',
				env: {},
				which: () => '/bin/pbcopy',
				run: (_c, _a, input) =>
					new Promise((resolve) => {
						started.push(input)
						gates.push(() => resolve(true))
					}),
			},
		)
		const first = copier.copy('one')
		const second = copier.copy('two')
		const third = copier.copy('three')
		await Promise.resolve()
		expect(started).toEqual(['one'])
		expect(await second).toBeNull()
		gates[0]?.()
		expect(await first).toMatchObject({ native: 'pbcopy' })
		await vi.waitFor(() => expect(started).toEqual(['one', 'three']))
		gates[1]?.()
		expect(await third).toMatchObject({ native: 'pbcopy' })
	})

	it('does not start a tool for a copy nobody wants any more', async () => {
		const { copier, calls, written } = rig({ platform: 'darwin', env: {}, present: ['pbcopy'] })
		expect(await copier.copy('gone', () => false)).toBeNull()
		expect(calls).toEqual([])
		expect(written).toEqual([])
	})

	it('drops a waiting copy that stopped being wanted while the one ahead ran', async () => {
		let release: () => void = () => {}
		let wanted = true
		const started: string[] = []
		const copier = createClipboardCopier(
			{ isTTY: true, write: () => {} },
			{
				platform: 'darwin',
				env: {},
				which: () => '/bin/pbcopy',
				run: (_c, _a, input) =>
					new Promise((resolve) => {
						started.push(input)
						release = () => resolve(true)
					}),
			},
		)
		const first = copier.copy('one')
		const second = copier.copy('two', () => wanted)
		wanted = false
		release()
		await first
		expect(await second).toBeNull()
		expect(started).toEqual(['one'])
	})

	it('keeps going after a runner that throws', async () => {
		const copier = createClipboardCopier(
			{ isTTY: true, write: () => {} },
			{
				platform: 'darwin',
				env: {},
				which: () => '/bin/pbcopy',
				run: async () => {
					throw new Error('boom')
				},
			},
		)
		expect(await copier.copy('a')).toBeNull()
		expect(await copier.copy('b')).toBeNull()
	})
})

describe('what the operator is told', () => {
	const base = { chars: 12, bytes: 12, native: null, osc52: 'sent', tmuxBuffer: false } as const
	it('names the tool path, the tmux buffer, the request and each failure', () => {
		expect(describeCopy({ ...base, native: 'xclip' })).toEqual({
			text: 'Copied 12 characters to the clipboard.',
			ok: true,
		})
		expect(describeCopy({ ...base, chars: 1, native: 'xclip' }, 'Shift', 'the answer').text).toBe(
			'Copied 1 character (the answer) to the clipboard.',
		)
		expect(describeCopy({ ...base, tmuxBuffer: true }).text).toBe(
			'Copied 12 characters to the tmux buffer. Paste with prefix + ].',
		)
		expect(describeCopy(base, 'Option').text).toBe(
			'Sent 12 characters to your clipboard. If paste fails, hold Option while selecting.',
		)
		expect(describeCopy({ ...base, osc52: 'too-large', bytes: 100_001 })).toEqual({
			text: 'That selection is too large to copy (101 KB; the limit is 100 KB).',
			ok: false,
		})
		for (const osc52 of ['unavailable', 'failed'] as const)
			expect(describeCopy({ ...base, osc52 })).toEqual({
				text: "Couldn't copy 12 characters. Select with Shift held, then use your terminal's Copy.",
				ok: false,
			})
	})

	it('names the key the terminal wants held', () => {
		expect(bypassKey({ TERM_PROGRAM: 'iTerm.app' })).toBe('Option')
		expect(bypassKey({ TERM_PROGRAM: 'Apple_Terminal' })).toBe('Fn')
		expect(bypassKey({})).toBe('Shift')
	})
})

describe('the real runner', () => {
	const dirs: string[] = []
	afterEach(() => {
		vi.useRealTimers()
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
	})

	it('hands the text over on stdin byte for byte', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-runner-'))
		dirs.push(dir)
		const out = join(dir, 'stdin.bin')
		const text = 'Çok güzel, İstanbul ğüşöç 你好 🙂\n'
		const script = `process.stdin.pipe(require('node:fs').createWriteStream(${JSON.stringify(out)}))`
		expect(await realRunner(process.execPath, ['-e', script], text, 20_000)).toBe(true)
		expect(readFileSync(out).equals(Buffer.from(text, 'utf8'))).toBe(true)
	})

	it('says false for a program that is missing or exits non-zero', async () => {
		expect(await realRunner('/nonexistent/namzu-no-such-tool', [], 'x', 20_000)).toBe(false)
		expect(await realRunner(process.execPath, ['-e', 'process.exit(3)'], 'x', 20_000)).toBe(false)
	})

	it('gives up on a tool that outlives its time', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const pending = realRunner(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 'x', 2000)
		await vi.advanceTimersByTimeAsync(2000)
		expect(await pending).toBe(false)
	})
})
