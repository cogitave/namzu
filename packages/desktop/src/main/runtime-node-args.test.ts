import { describe, expect, it } from 'vitest'
import { desktopRuntimeNodeArgs } from './runtime-node-args.js'

const supported = new Set(['--use-system-ca'])
const cliEntry = 'C:\\Users\\Arda\\Namzu workspace\\packages\\cli\\dist\\bin.js'

describe('desktop-owned Node runtime certificate trust', () => {
	it('places the supported Windows trust flag before the unchanged entry and CLI arguments', () => {
		expect(
			desktopRuntimeNodeArgs(cliEntry, {
				platform: 'win32',
				allowedNodeEnvironmentFlags: supported,
			}),
		).toEqual(['--use-system-ca', cliEntry, 'acp', '--desktop'])
	})
	it('retains strict runtime defaults when the flag is unsupported', () => {
		expect(
			desktopRuntimeNodeArgs(cliEntry, {
				platform: 'win32',
				allowedNodeEnvironmentFlags: new Set(),
			}),
		).toEqual([cliEntry, 'acp', '--desktop'])
	})
	it.each(['linux', 'darwin'] as const)('leaves %s Node trust unchanged', (platform) => {
		expect(
			desktopRuntimeNodeArgs(cliEntry, { platform, allowedNodeEnvironmentFlags: supported }),
		).toEqual([cliEntry, 'acp', '--desktop'])
	})
	it.each([
		'--no-use-system-ca',
		'--use-system-ca',
		'--use-bundled-ca',
		'--use-openssl-ca',
		'--no-use-bundled-ca',
		'--no-use-openssl-ca',
		'--no_use_system_ca',
		'--max-old-space-size=4096 "--no-use-system-ca"',
		'--require "C:\\custom runtime\\init.js" --no-use-system-ca',
	])('preserves an explicit inherited trust selection: %s', (nodeOptions) => {
		expect(
			desktopRuntimeNodeArgs(cliEntry, {
				platform: 'win32',
				allowedNodeEnvironmentFlags: supported,
				nodeOptions,
			}),
		).toEqual([cliEntry, 'acp', '--desktop'])
	})
	it('does not mistake a quoted module path for a CA option', () => {
		expect(
			desktopRuntimeNodeArgs(cliEntry, {
				platform: 'win32',
				allowedNodeEnvironmentFlags: supported,
				nodeOptions: '--require "C:\\custom --no-use-system-ca directory\\init.js"',
			}),
		).toEqual(['--use-system-ca', cliEntry, 'acp', '--desktop'])
	})
	it('preserves argv boundaries for entry paths containing shell characters', () => {
		const entry = 'C:\\Namzu & other; $(literal)\\cli entry.js'
		expect(
			desktopRuntimeNodeArgs(entry, {
				platform: 'win32',
				allowedNodeEnvironmentFlags: supported,
			}),
		).toEqual(['--use-system-ca', entry, 'acp', '--desktop'])
	})
})
