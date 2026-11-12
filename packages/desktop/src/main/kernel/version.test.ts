import { describe, expect, it } from 'vitest'
import { compareKernelVersions, isKernelVersion, isNewerKernelVersion } from './version.js'

describe('command line versions', () => {
	it('orders numbers as numbers', () => {
		expect(compareKernelVersions('51.10.0', '51.9.9')).toBe(1)
		expect(compareKernelVersions('2.0.0', '10.0.0')).toBe(-1)
		expect(compareKernelVersions('51.1.0', '51.1.0')).toBe(0)
	})

	it('puts a prerelease below its release and orders tags by the SemVer rules', () => {
		// The app's older comparison orders tags as strings: rc.10 would sort before rc.2.
		const ladder = [
			'1.0.0-alpha',
			'1.0.0-alpha.1',
			'1.0.0-alpha.beta',
			'1.0.0-beta',
			'1.0.0-beta.2',
			'1.0.0-beta.11',
			'1.0.0-rc.1',
			'1.0.0',
		]
		for (let index = 0; index + 1 < ladder.length; index++) {
			expect(compareKernelVersions(ladder[index] as string, ladder[index + 1] as string)).toBe(-1)
			expect(compareKernelVersions(ladder[index + 1] as string, ladder[index] as string)).toBe(1)
		}
		expect(compareKernelVersions('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1)
		expect(compareKernelVersions('1.0.0-1', '1.0.0-a')).toBe(-1)
	})

	it('refuses what is not a plain version, build metadata included', () => {
		for (const bad of [
			'',
			'1',
			'1.2',
			'01.2.3',
			'1.2.3.4',
			'v1.2.3',
			'1.2.3+build',
			'1.2.3-',
			'1.2.3-01',
			'../1.2.3',
			'1.2.3/x',
			'x'.repeat(70),
		])
			expect(isKernelVersion(bad), bad).toBe(false)
		expect(() => compareKernelVersions('x', '1.0.0')).toThrow()
	})

	it('knows newer from not newer', () => {
		expect(isNewerKernelVersion('51.3.0', '51.1.0')).toBe(true)
		expect(isNewerKernelVersion('51.1.0', '51.1.0')).toBe(false)
		expect(isNewerKernelVersion('51.1.0-rc.1', '51.1.0')).toBe(false)
	})
})
