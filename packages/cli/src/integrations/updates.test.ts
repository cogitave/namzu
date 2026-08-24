import { afterEach, describe, expect, it, vi } from 'vitest'

import { checkNamzuUpdate, compareVersions, latestNamzuVersion } from './updates.js'

afterEach(() => vi.unstubAllGlobals())

describe('semantic update ordering', () => {
	it('orders prereleases below their release and compares prerelease identifiers', () => {
		expect(compareVersions('14.3.0', '14.3.0-test.2')).toBeGreaterThan(0)
		expect(compareVersions('14.3.0-test.10', '14.3.0-test.2')).toBeGreaterThan(0)
		expect(compareVersions('14.3.0-test.2', '14.3.0')).toBeLessThan(0)
		expect(compareVersions('v14.3.0+build.1', '14.3.0+build.2')).toBe(0)
	})

	it('refuses strings that are not semantic versions', () => {
		expect(() => compareVersions('latest', '14.3.0')).toThrow('invalid semantic versions')
	})
})

describe('latestNamzuVersion', () => {
	it('reads and validates the exact npm latest record', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ version: '14.3.0-test.2' }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				}),
		)
		expect(await latestNamzuVersion({ fetch: fetch as typeof globalThis.fetch })).toBe(
			'14.3.0-test.2',
		)
		expect(fetch).toHaveBeenCalledWith(
			'https://registry.npmjs.org/@namzu/cli/latest',
			expect.objectContaining({ headers: { accept: 'application/json' } }),
		)
	})

	it('refuses malformed registry versions before they can become npm argv', async () => {
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ version: '14.3.0 --prefix /tmp/other' }), { status: 200 }),
		)
		await expect(latestNamzuVersion({ fetch: fetch as typeof globalThis.fetch })).rejects.toThrow(
			'invalid @namzu/cli version',
		)
	})

	it('gives the TUI a command that now exists when an update is available', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ version: '14.3.0' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			),
		)
		await expect(checkNamzuUpdate('14.2.1')).resolves.toEqual({
			name: 'namzu',
			current: '14.2.1',
			latest: '14.3.0',
			how: 'namzu upgrade',
		})
	})
})
