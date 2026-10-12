import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
	CONTINUE_SETUP_FLAG,
	PAL_COMPUTER_IDLE_MS,
	continueSetupCommand,
	palComputerEnvironment,
	palComputerSetupSettings,
	restartCommand,
	restartPc,
} from './pal-computer-env.js'

const resourcesPath = join('res', 'ources')
const manifest = join(resourcesPath, 'pal-computer', 'manifest.json')

describe('palComputerEnvironment', () => {
	it('chooses the Windows engine and the bundled image on Windows', () => {
		expect(
			palComputerEnvironment({
				platform: 'win32',
				env: {},
				resourcesPath,
				exists: (path) => path === manifest,
			}),
		).toEqual({
			NAMZU_PAL_COMPUTER_ENGINE: 'wslc',
			NAMZU_PAL_COMPUTER_BUNDLE: join(resourcesPath, 'pal-computer'),
		})
	})

	it('sets nothing off Windows', () => {
		for (const platform of ['linux', 'darwin'] as const)
			expect(
				palComputerEnvironment({ platform, env: {}, resourcesPath, exists: () => true }),
			).toEqual({})
	})

	it('respects an engine the person already chose', () => {
		expect(
			palComputerEnvironment({
				platform: 'win32',
				env: { NAMZU_PAL_COMPUTER_ENGINE: 'docker' },
				resourcesPath,
				exists: () => true,
			}),
		).toEqual({})
		expect(
			palComputerEnvironment({
				platform: 'win32',
				env: { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' },
				resourcesPath,
				exists: () => true,
			}),
		).toEqual({ NAMZU_PAL_COMPUTER_BUNDLE: join(resourcesPath, 'pal-computer') })
	})

	it('names the bundle only when the manifest exists, and never over a chosen one', () => {
		expect(
			palComputerEnvironment({ platform: 'win32', env: {}, resourcesPath, exists: () => false }),
		).toEqual({ NAMZU_PAL_COMPUTER_ENGINE: 'wslc' })
		expect(
			palComputerEnvironment({
				platform: 'win32',
				env: { NAMZU_PAL_COMPUTER_BUNDLE: 'mine' },
				resourcesPath,
				exists: () => true,
			}),
		).toEqual({ NAMZU_PAL_COMPUTER_ENGINE: 'wslc' })
	})
})

describe('palComputerSetupSettings', () => {
	it('drives setup only for the Windows engine, with a ten minute idle delay', () => {
		expect(palComputerSetupSettings('win32', { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' })).toEqual({
			enabled: true,
			idleMs: PAL_COMPUTER_IDLE_MS,
		})
		expect(PAL_COMPUTER_IDLE_MS).toBe(600_000)
		expect(palComputerSetupSettings('win32', {}).enabled).toBe(false)
		expect(palComputerSetupSettings('linux', { NAMZU_PAL_COMPUTER_ENGINE: 'wslc' }).enabled).toBe(
			false,
		)
		expect(palComputerSetupSettings('win32', { NAMZU_PAL_COMPUTER_ENGINE: 'docker' }).enabled).toBe(
			false,
		)
	})

	it('lets only the end-to-end variables stand in and shorten the delay', () => {
		expect(
			palComputerSetupSettings('linux', {
				NAMZU_E2E_PAL_COMPUTER_SETUP: '1',
				NAMZU_E2E_PAL_COMPUTER_IDLE_MS: '4000',
			}),
		).toEqual({ enabled: true, idleMs: 4000 })
		// Not a number, too small, or absent: the real delay.
		for (const value of ['soon', '5', '', undefined])
			expect(
				palComputerSetupSettings('win32', {
					NAMZU_PAL_COMPUTER_ENGINE: 'wslc',
					NAMZU_E2E_PAL_COMPUTER_IDLE_MS: value,
				}).idleMs,
			).toBe(PAL_COMPUTER_IDLE_MS)
	})
})

describe('packaged builds', () => {
	it('ignore both end-to-end overrides', () => {
		expect(
			palComputerSetupSettings(
				'linux',
				{ NAMZU_E2E_PAL_COMPUTER_SETUP: '1', NAMZU_E2E_PAL_COMPUTER_IDLE_MS: '4000' },
				true,
			),
		).toEqual({ enabled: false, idleMs: PAL_COMPUTER_IDLE_MS })
		expect(
			palComputerSetupSettings(
				'win32',
				{ NAMZU_PAL_COMPUTER_ENGINE: 'wslc', NAMZU_E2E_PAL_COMPUTER_IDLE_MS: '4000' },
				true,
			),
		).toEqual({ enabled: true, idleMs: PAL_COMPUTER_IDLE_MS })
	})
})

describe('restartPc', () => {
	const child = () => {
		const listeners: Array<(error: Error) => void> = []
		return {
			listeners,
			once: (_event: 'error', listener: (error: Error) => void) => void listeners.push(listener),
			unref: vi.fn(),
		}
	}

	it('starts shutdown.exe /r /t 0 only on Windows when a restart is due', () => {
		const spawned = child()
		const spawn = vi.fn(() => spawned)
		restartPc({ platform: 'win32', due: true, spawn, onError: vi.fn() })
		expect(spawn).toHaveBeenCalledWith('shutdown.exe', ['/r', '/t', '0'], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		})
		expect(spawned.unref).toHaveBeenCalled()
	})

	it('refuses when no restart is due or off Windows, without spawning', () => {
		const spawn = vi.fn(() => child())
		expect(() => restartPc({ platform: 'win32', due: false, spawn, onError: vi.fn() })).toThrow(
			/does not need a restart/,
		)
		expect(() => restartPc({ platform: 'linux', due: true, spawn, onError: vi.fn() })).toThrow()
		expect(spawn).not.toHaveBeenCalled()
	})

	it('records, and does not crash, when the command cannot start', () => {
		const spawned = child()
		const onError = vi.fn()
		restartPc({ platform: 'win32', due: true, spawn: () => spawned, onError })
		const failure = new Error('ENOENT')
		for (const listener of spawned.listeners) listener(failure)
		expect(onError).toHaveBeenCalledWith(failure)
		const thrown = vi.fn()
		expect(() =>
			restartPc({
				platform: 'win32',
				due: true,
				spawn: () => {
					throw new Error('EACCES')
				},
				onError: thrown,
			}),
		).toThrow(/Start menu/)
		expect(thrown).toHaveBeenCalled()
	})
})

describe('restart and resume commands', () => {
	it('restarts Windows with shutdown.exe /r /t 0 and nothing else, only on Windows', () => {
		expect(restartCommand('win32')).toEqual({ program: 'shutdown.exe', args: ['/r', '/t', '0'] })
		expect(restartCommand('linux')).toBeUndefined()
		expect(restartCommand('darwin')).toBeUndefined()
	})

	it('quotes the executable in the sign-in command', () => {
		expect(continueSetupCommand('C:\\Users\\A B\\Namzu.exe')).toBe(
			`"C:\\Users\\A B\\Namzu.exe" ${CONTINUE_SETUP_FLAG}`,
		)
	})
})
