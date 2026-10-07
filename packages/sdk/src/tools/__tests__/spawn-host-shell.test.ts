import { describe, expect, it, vi } from 'vitest'

import { type CommandShell, describeSpawnFailure, spawnHostShell } from '../command-shell.js'
import { createHostOutputDecoder, decodeHostOutput } from '../host-output.js'

const CMD: CommandShell = { path: undefined, dialect: 'cmd', source: 'platform' }
const BASH: CommandShell = { path: '/usr/bin/bash', dialect: 'bash', source: 'bash' }

function fakeSpawn() {
	return vi.fn(() => ({}) as never)
}

describe('spawnHostShell', () => {
	it('runs the line through cmd on Windows, hidden and not detached, with the command in the environment', () => {
		const spawnImpl = fakeSpawn()
		spawnHostShell('echo hi > bg-demo.txt', {
			cwd: 'C:\\work',
			env: { A: '1', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
			stdio: ['ignore', 'pipe', 'pipe'],
			shell: CMD,
			platform: 'win32',
			spawnImpl: spawnImpl as never,
		})
		expect(spawnImpl).toHaveBeenCalledTimes(1)
		expect(spawnImpl).toHaveBeenCalledWith(
			'C:\\Windows\\System32\\cmd.exe',
			[
				'/d',
				'/v:on',
				'/s',
				'/c',
				'"chcp 65001>nul & "!NAMZU_HOST_COMSPEC!" /d /s /c "!NAMZU_HOST_COMMAND!""',
			],
			{
				cwd: 'C:\\work',
				env: {
					A: '1',
					ComSpec: 'C:\\Windows\\System32\\cmd.exe',
					NAMZU_HOST_COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
					NAMZU_HOST_COMMAND: 'echo hi > bg-demo.txt',
				},
				detached: false,
				windowsHide: true,
				windowsVerbatimArguments: true,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		)
	})

	it('hands the command to cmd through the environment, untouched', () => {
		const spawnImpl = fakeSpawn()
		const command = 'echo "a & b" 100%% çğıöşü | findstr /c:"x"'
		spawnHostShell(command, {
			cwd: 'C:\\work',
			env: { ComSpec: 'D:\\Win\\cmd.exe' },
			shell: CMD,
			platform: 'win32',
			spawnImpl: spawnImpl as never,
		})
		const [file, args, options] = spawnImpl.mock.calls[0] as unknown as [
			string,
			string[],
			{ env: Record<string, string> },
		]
		expect(file).toBe('D:\\Win\\cmd.exe')
		expect(args.join(' ')).not.toContain('çğıöşü')
		expect(options.env.NAMZU_HOST_COMMAND).toBe(command)
	})

	it('never reaches for /bin/sh when the shell has no path', () => {
		const spawnImpl = fakeSpawn()
		spawnHostShell('dir', {
			cwd: '.',
			env: {},
			shell: CMD,
			platform: 'win32',
			spawnImpl: spawnImpl as never,
		})
		const [file] = spawnImpl.mock.calls[0] as unknown as [string]
		expect(file).toMatch(/cmd\.exe$/i)
	})

	it('runs <shell> -c in its own process group off Windows, without bash startup variables', () => {
		const spawnImpl = fakeSpawn()
		spawnHostShell('ls', {
			cwd: '/w',
			env: { BASH_ENV: '/x', KEEP: '1' },
			shell: BASH,
			platform: 'linux',
			spawnImpl: spawnImpl as never,
		})
		expect(spawnImpl).toHaveBeenCalledWith('/usr/bin/bash', ['-c', 'ls'], {
			cwd: '/w',
			env: { KEEP: '1' },
			detached: true,
			windowsHide: true,
		})
	})

	it('honours an explicit detached', () => {
		const spawnImpl = fakeSpawn()
		spawnHostShell('ls', {
			cwd: '/w',
			env: {},
			shell: BASH,
			detached: false,
			spawnImpl: spawnImpl as never,
		})
		expect(
			(spawnImpl.mock.calls[0] as unknown as [string, string[], { detached: boolean }])[2].detached,
		).toBe(false)
	})
})

describe('host output decoding', () => {
	// What cmd.exe wrote for `echo çğış` under code page 850: ğ has no
	// 850 glyph and degraded to g, ı is 0xD5.
	const CP850 = Buffer.from([0x87, 0x67, 0xd5, 0x73])

	it('reads the OEM code page on Windows', () => {
		expect(decodeHostOutput(CP850, { platform: 'win32', codePage: 850 })).toBe('çgıs')
	})

	it('reads a Turkish console (857) and a Windows ANSI page (1254)', () => {
		expect(
			decodeHostOutput(Buffer.from([0x87, 0xa7, 0x8d]), { platform: 'win32', codePage: 857 }),
		).toBe('çğı')
		expect(
			decodeHostOutput(Buffer.from([0xe7, 0xf0, 0xfd]), { platform: 'win32', codePage: 1254 }),
		).toBe('çğı')
	})

	it('keeps UTF-8 from children that write it, on Windows too', () => {
		expect(
			decodeHostOutput(Buffer.from('çğış', 'utf8'), { platform: 'win32', codePage: 850 }),
		).toBe('çğış')
	})

	it('does not split a UTF-8 character across chunks', () => {
		const bytes = Buffer.from('ğ', 'utf8')
		const decoder = createHostOutputDecoder({ platform: 'win32', codePage: 850 })
		expect(
			decoder.write(bytes.subarray(0, 1)) + decoder.write(bytes.subarray(1)) + decoder.end(),
		).toBe('ğ')
	})

	it("keeps a cut character's bytes when the stream turns out to be a code page", () => {
		// 0xC3 looks like the start of a UTF-8 character until 0x41 follows it.
		const decoder = createHostOutputDecoder({ platform: 'win32', codePage: 850 })
		expect(
			decoder.write(Buffer.from([0x61, 0xc3])) + decoder.write(Buffer.from([0x41])) + decoder.end(),
		).toBe('a\u251cA')
	})

	it('is plain UTF-8 off Windows and for an unknown code page', () => {
		expect(decodeHostOutput(Buffer.from('é'), { platform: 'linux' })).toBe('é')
		expect(decodeHostOutput(Buffer.from('é'), { platform: 'win32', codePage: undefined })).toBe('é')
	})
})

describe('describeSpawnFailure', () => {
	const enoent = Object.assign(new Error('spawn C:\\Windows\\system32\\cmd.exe ENOENT'), {
		code: 'ENOENT',
	})

	it('names a missing working directory instead of the shell', () => {
		expect(describeSpawnFailure(enoent, '/definitely/not/a/real/dir-xyz')).toBe(
			'Could not start the command: the working directory does not exist: /definitely/not/a/real/dir-xyz',
		)
	})

	it('keeps the original wording when the directory exists or is not given', () => {
		expect(describeSpawnFailure(enoent, '.')).toContain('cmd.exe ENOENT')
		expect(describeSpawnFailure(enoent)).toContain('cmd.exe ENOENT')
	})
})
