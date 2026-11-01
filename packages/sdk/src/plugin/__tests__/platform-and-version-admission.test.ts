import { describe, expect, it } from 'vitest'

import type { PluginManifest } from '../../types/plugin/index.js'
import { versionSatisfies } from '../compat.js'
import { assertEnableable } from '../loader.js'

/**
 * A plugin written for one operating system or one range of Namzu versions
 * used to load anywhere and fail somewhere inside its own code. The manifest
 * can now say what it supports, and an incompatible plugin is refused with a
 * reason a person can act on.
 */

const manifest = (extra: Record<string, unknown> = {}): PluginManifest =>
	({
		name: 'demo',
		version: '1.0.0',
		description: 'd',
		...extra,
	}) as PluginManifest

const host = { platform: 'linux', namzuVersion: '60.2.1' }

describe('platform admission', () => {
	it('refuses a plugin that does not list this platform, naming both', () => {
		expect(() => assertEnableable(manifest({ platforms: ['win32', 'darwin'] }), host)).toThrow(
			/supports only win32, darwin, and this machine runs linux/,
		)
	})

	it('admits a plugin that lists this platform', () => {
		expect(() => assertEnableable(manifest({ platforms: ['linux'] }), host)).not.toThrow()
	})

	it('admits a plugin that declares nothing', () => {
		expect(() => assertEnableable(manifest(), host)).not.toThrow()
	})
})

describe('Namzu version admission', () => {
	it('refuses a version outside the range, naming the range and the running version', () => {
		expect(() => assertEnableable(manifest({ engines: { namzu: '>=61.0.0' } }), host)).toThrow(
			/needs Namzu >=61\.0\.0, and this is Namzu 60\.2\.1/,
		)
	})

	it('admits a version inside the range', () => {
		expect(() => assertEnableable(manifest({ engines: { namzu: '^60.1.0' } }), host)).not.toThrow()
	})

	it('refuses a range it cannot read instead of guessing', () => {
		expect(() => assertEnableable(manifest({ engines: { namzu: 'newish' } }), host)).toThrow(
			/cannot be read/,
		)
	})

	it('does not hold an unknown runtime version against the range', () => {
		expect(() =>
			assertEnableable(manifest({ engines: { namzu: '>=61.0.0' } }), {
				platform: 'linux',
				namzuVersion: '0.0.0',
			}),
		).not.toThrow()
	})
})

describe('the range reader', () => {
	it.each([
		['60.2.1', '>=60', true],
		['60.2.1', '>=60.3.0', false],
		['60.2.1', '>=59 <61', true],
		['61.0.0', '>=59 <61', false],
		['58.0.0', '<59 || >=61', true],
		['60.0.0', '<59 || >=61', false],
		['60.2.1', '^60.1.0', true],
		['61.0.0', '^60.1.0', false],
		['0.2.5', '^0.2.1', true],
		['0.3.0', '^0.2.1', false],
		['60.2.9', '~60.2.1', true],
		['60.3.0', '~60.2.1', false],
		['60.2.1', '60', true],
		['61.2.1', '60', false],
		['60.2.1', '>= 60.0.0', true],
		['60.2.1', '60.2.1', true],
		['60.2.1', '~60', true],
		['61.0.0', '~60', false],
		['1.4.9', '~1.4', true],
		['1.5.0', '~1.4', false],
		['1.4.9', '~1.4.2', true],
		['1.5.0', '~1.4.2', false],
		['0.9.0', '^0', true],
		['1.0.0', '^0', false],
		['0.2.9', '^0.2', true],
		['0.3.0', '^0.2', false],
		['0.0.3', '^0.0.3', true],
		['0.0.4', '^0.0.3', false],
		['2.0.0-rc.1', '>=1.0.0', true],
		['1.0.0-rc.1', '>=1.0.0', false],
		['1.0.0-rc.1', '<1.0.0', true],
		['2.0.0-rc.1', '^1', false],
		['1.0.0-rc.1', '1.0.0', false],
		['1.0.0-rc.1', '1.0.0-rc.1', true],
	])('%s against %s is %s', (version, range, expected) => {
		expect(versionSatisfies(version, range)).toBe(expected)
	})

	it('answers undefined for an unreadable range', () => {
		expect(versionSatisfies('1.0.0', 'soon')).toBeUndefined()
	})
})
