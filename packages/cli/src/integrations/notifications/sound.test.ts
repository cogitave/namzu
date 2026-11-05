import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	PLAY_SCRIPT,
	SOUND_MIN_TURN_MS,
	type SoundPlayer,
	ensureSoundFile,
	playMoment,
	resetSoundState,
	selectSoundPlayer,
	soundFilePath,
	soundFor,
} from './sound.js'
import { chimeSeconds, chimeWav } from './sound/chime.js'

const settled = { kind: 'turn-settled', outcome: 'completed' } as const
const player: SoundPlayer = { name: 'test', command: '/bin/play', args: (file) => ['-q', file] }
const home = () => mkdtempSync(join(tmpdir(), 'namzu-sound-'))

beforeEach(resetSoundState)

describe('the chimes', () => {
	it.each(['done', 'request'] as const)(
		'%s is a well-formed mono 16-bit WAV of its stated length',
		(kind) => {
			const wav = chimeWav(kind)
			expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
			expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
			expect(wav.readUInt16LE(20)).toBe(1)
			expect(wav.readUInt16LE(22)).toBe(1)
			expect(wav.readUInt16LE(34)).toBe(16)
			expect(wav.readUInt32LE(4)).toBe(wav.length - 8)
			expect(wav.readUInt32LE(40)).toBe(wav.length - 44)
			expect(wav.length - 44).toBe(Math.ceil(chimeSeconds(kind) * 22_050) * 2)
		},
	)

	it('is the same bytes every time, and the two sounds differ', () => {
		expect(chimeWav('done').equals(chimeWav('done'))).toBe(true)
		expect(chimeWav('done').equals(chimeWav('request'))).toBe(false)
	})

	it('stays quiet enough to never clip, yet is audible', () => {
		for (const kind of ['done', 'request'] as const) {
			const wav = chimeWav(kind)
			let peak = 0
			for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)))
			expect(peak).toBeGreaterThan(8_000)
			expect(peak).toBeLessThan(0.5 * 32767)
		}
	})

	it('ends in silence, so a player never cuts off a sound mid-wave', () => {
		const wav = chimeWav('done')
		expect(wav.readInt16LE(wav.length - 2)).toBe(0)
	})
})

describe('soundFor', () => {
	it('sounds a long finished turn, not a short one', () => {
		expect(soundFor(settled, SOUND_MIN_TURN_MS)).toBe('done')
		expect(soundFor(settled, SOUND_MIN_TURN_MS - 1)).toBeUndefined()
		expect(soundFor(settled, undefined)).toBeUndefined()
	})

	it('always sounds a stop, a failure and an approval, however short the turn', () => {
		expect(soundFor({ kind: 'turn-settled', outcome: 'stopped' }, 100)).toBe('request')
		expect(soundFor({ kind: 'turn-settled', outcome: 'failed' }, 100)).toBe('request')
		expect(soundFor({ kind: 'approval-required' }, undefined)).toBe('request')
	})

	it('leaves the idle reminder silent', () => {
		expect(soundFor({ kind: 'idle-prompt' }, 999_999)).toBeUndefined()
	})
})

describe('selectSoundPlayer', () => {
	const none = () => false
	it('uses afplay on macOS', () => {
		expect(selectSoundPlayer({ platform: 'darwin', env: {}, exists: none })?.name).toBe('afplay')
	})

	it('uses the first Linux player on PATH, and never searches a Windows drive', () => {
		const exists = (path: string) => path === '/usr/bin/pw-play' || path === '/mnt/c/bin/paplay'
		const found = selectSoundPlayer({
			platform: 'linux',
			env: { PATH: '/mnt/c/bin:/usr/bin' },
			exists,
			desktop: { kind: 'none', detail: 'no bus' },
		})
		expect(found?.command).toBe('/usr/bin/pw-play')
		expect(found?.args('/x.wav')).toEqual(['/x.wav'])
	})

	it('finds nothing on a machine with no player', () => {
		expect(
			selectSoundPlayer({
				platform: 'linux',
				env: { PATH: '/usr/bin' },
				exists: none,
				desktop: { kind: 'none', detail: 'no bus' },
			}),
		).toBeUndefined()
	})

	it('plays through PowerShell on Windows, with the file in the environment and never in the script', () => {
		const found = selectSoundPlayer({
			platform: 'win32',
			env: {},
			desktop: { kind: 'windows-toast', detail: 'powershell.exe', command: 'powershell.exe' },
		})
		expect(found?.name).toBe('powershell')
		expect(found?.env?.({}, 'C:\\a b\\x.wav').NAMZU_SOUND_FILE).toBe('C:\\a b\\x.wav')
		expect(PLAY_SCRIPT).not.toContain('x.wav')
		expect(found?.args('C:\\a b\\x.wav').join(' ')).not.toContain('a b')
	})

	it('asks WSL to translate the path on the way to PowerShell, keeping what WSLENV held', () => {
		const found = selectSoundPlayer({
			platform: 'linux',
			env: {},
			desktop: {
				kind: 'wsl-toast',
				detail: 'ps',
				command: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
				cwd: '/mnt/c',
			},
		})
		expect(found?.command).toContain('powershell.exe')
		expect(found?.cwd).toBe('/mnt/c')
		const env = found?.env?.({ WSLENV: 'FOO/p' }, '/home/a/x.wav')
		expect(env?.NAMZU_SOUND_FILE).toBe('/home/a/x.wav')
		expect(env?.WSLENV).toBe('FOO/p:NAMZU_SOUND_FILE/p')
	})
})

describe('ensureSoundFile', () => {
	it('writes the sound once, atomically, under the application home', () => {
		const dir = home()
		const file = ensureSoundFile('done', dir)
		expect(file).toBe(soundFilePath('done', dir))
		expect(readFileSync(file).equals(chimeWav('done'))).toBe(true)
		const before = statSync(file).mtimeMs
		ensureSoundFile('done', dir)
		expect(statSync(file).mtimeMs).toBe(before)
	})
})

describe('playMoment', () => {
	const run = (options = {}, moment = settled, ms: number | undefined = 60_000) => {
		const spawn = vi.fn()
		const kind = playMoment(moment, ms, {
			env: {},
			player,
			spawn,
			home: home(),
			...options,
		})
		return { kind, spawn }
	}

	it('starts the player once, with the rendered file', () => {
		const { kind, spawn } = run()
		expect(kind).toBe('done')
		expect(spawn).toHaveBeenCalledTimes(1)
		const [command, args] = spawn.mock.calls[0] as [string, string[]]
		expect(command).toBe('/bin/play')
		expect(args[0]).toBe('-q')
		expect(args[1]).toMatch(/namzu-done-v1\.wav$/)
	})

	it.each([
		['the setting is off', { enabled: false }],
		['stdout is not a terminal', { isTTY: false }],
		['the kill switch is set', { env: { NAMZU_NO_SOUND: '1' } }],
		['no player exists', { player: undefined }],
	])('starts nothing when %s', (_why, options) => {
		const { kind, spawn } = run(options)
		expect(kind).toBeUndefined()
		expect(spawn).not.toHaveBeenCalled()
	})

	it('starts nothing for a short finished turn', () => {
		expect(run({}, settled, 2_000).spawn).not.toHaveBeenCalled()
	})

	it('treats two moments inside the spacing as one', () => {
		const spawn = vi.fn()
		let now = 10_000
		const options = { env: {}, player, spawn, home: home(), now: () => now }
		playMoment({ kind: 'approval-required' }, undefined, options)
		now += 500
		playMoment({ kind: 'approval-required' }, undefined, options)
		expect(spawn).toHaveBeenCalledTimes(1)
		now += 2_000
		playMoment({ kind: 'approval-required' }, undefined, options)
		expect(spawn).toHaveBeenCalledTimes(2)
	})

	it('never throws, whatever the spawner does', () => {
		const spawn = vi.fn(() => {
			throw new Error('boom')
		})
		expect(() =>
			playMoment(settled, 60_000, { env: {}, player, spawn, home: home() }),
		).not.toThrow()
	})
})
