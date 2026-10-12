import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
	CONTINUE_SETUP_FLAG,
	PAL_COMPUTER_IDLE_MS,
	continueSetupCommand,
	palComputerEnvironment,
	palComputerSetupSettings,
	restartCommand,
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
