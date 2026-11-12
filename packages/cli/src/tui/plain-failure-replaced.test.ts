import { beforeEach, describe, expect, it, vi } from 'vitest'

const replaced = vi.hoisted(() => vi.fn(() => false))
vi.mock('../integrations/auto-update/replaced-install.js', () => ({
	installWasReplaced: replaced,
	replacedInstallLine: () => 'Namzu 2.0.0 was installed while this window was open.',
}))

import { explainFailure } from './plain-failure.js'

beforeEach(() => replaced.mockReset().mockReturnValue(false))

describe('a failure caused by an install replaced under the window', () => {
	it('is the one plain line, in place of "a file Namzu needs is missing"', () => {
		const error = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' })
		replaced.mockReturnValue(true)
		expect(explainFailure(error, 'Could not run the health check.', false)).toBe(
			'Namzu 2.0.0 was installed while this window was open.',
		)
	})

	it('leaves every other failure as it was', () => {
		const error = Object.assign(new Error('x'), { code: 'ENOENT' })
		expect(explainFailure(error, 'Could not open it.', false)).toBe(
			'Could not open it. A file Namzu needs is missing.',
		)
	})
})
