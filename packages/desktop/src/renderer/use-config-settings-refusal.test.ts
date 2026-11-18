import { describe, expect, it } from 'vitest'
import { saveRefusalText } from './use-config-settings.js'

describe('what a refused save says', () => {
	it('shows the engine sentence as written, even when it starts in lower case', () => {
		const failure = new Error(
			`Error invoking remote method 'config-settings:set': Error: not a site: "not a site" is not a site; write scheme://host, optionally *.host and :port or :*, with no path`,
		)
		expect(saveRefusalText(failure)).toBe(
			'not a site: "not a site" is not a site; write scheme://host, optionally *.host and :port or :*, with no path',
		)
	})
	it('shows a check refusal with its place in the list', () => {
		expect(
			saveRefusalText(
				new Error(
					'permissionChecks[0]: expected "expect" to be "allow", "ask" or "deny"; got "maybe"',
				),
			),
		).toMatch(/^permissionChecks\[0\]: expected "expect"/)
	})
	it('leaves out the config file the loader names first', () => {
		expect(
			saveRefusalText(
				new Error(
					'config file "/home/a/.namzu/config.yaml": routing.default.provider must be a non-empty string',
				),
			),
		).toBe('routing.default.provider must be a non-empty string')
	})
	it('still turns a system failure into one plain sentence', () => {
		expect(saveRefusalText(new Error("EACCES: permission denied, open '/x/config.yaml'"))).toBe(
			'Namzu isn’t allowed to open that. Check its permissions, then try again.',
		)
	})
})
