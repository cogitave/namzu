import { describe, expect, it } from 'vitest'
import * as sdk from '../public-runtime.js'

describe('deprecated resident-prefixed learning names', () => {
	it('stay exported and are the very same values as the new names', () => {
		expect(sdk.runResidentLearningCycle).toBe(sdk.runLearningCycle)
		expect(sdk.SqliteResidentLearningStore).toBe(sdk.SqliteLearningStore)
		expect(sdk.runStoredResidentLearningCycle).toBe(sdk.runStoredLearningCycle)
		expect(sdk.runStoredResidentLearningFromObservations).toBe(
			sdk.runStoredLearningFromObservations,
		)
		expect(sdk.hashResidentSkill).toBe(sdk.hashLearningSkill)
		expect(sdk.projectResidentLearning).toBe(sdk.projectLearning)
	})

	it('hash a skill the same way under either name', () => {
		const skill = { name: 'tidy', description: 'Keep notes tidy', body: 'Be brief.' }
		expect(sdk.hashResidentSkill(skill as never)).toBe(sdk.hashLearningSkill(skill as never))
	})
})
