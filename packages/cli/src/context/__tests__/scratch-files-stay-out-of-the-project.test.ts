import { describe, expect, it } from 'vitest'

import { NAMZU_WORKING_DOCTRINE } from '../doctrine.js'
import { composeFilePlacementGuidance } from '../file-placement.js'

/**
 * A session that left logs, scripts and staging folders in a person's home
 * folder is a defect the prompt can prevent: the working rules say where a
 * reproduction script lives, and the placement rule says where everything else
 * goes.
 */
describe('the working rules about files that are not the work', () => {
	it('keep a reproduction script in the scratch folder unless it becomes a test', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain(
			'a script stays in the scratch folder unless it becomes a test',
		)
		expect(NAMZU_WORKING_DOCTRINE).not.toContain('and keep it')
	})

	it('still ask for the place of any throwaway file to be reported', () => {
		expect(NAMZU_WORKING_DOCTRINE).toContain('where any throwaway file you made is')
	})
})
