import { describe, expect, it } from 'vitest'
import {
	positiveTokenCount,
	readModelLaunchEnvironment,
	withModelLaunchEnvironment,
} from './model-environment.js'

describe('process-local model profile', () => {
	it('reads roles and effort without inventing model-specific defaults', () => {
		expect(readModelLaunchEnvironment({})).toEqual({})
		expect(
			readModelLaunchEnvironment({
				NAMZU_PROVIDER: ' openai ',
				NAMZU_MODEL: 'new-model',
				NAMZU_SUBAGENT_MODEL: 'openai/child',
				NAMZU_EFFORT_LEVEL: 'max',
			}),
		).toEqual({
			provider: 'openai',
			model: 'new-model',
			subagentModel: 'openai/child',
			effort: 'max',
		})
	})
	it('lets explicit flags win while keeping the environment for omitted choices', () => {
		expect(
			withModelLaunchEnvironment(
				{ provider: null, model: 'flag-model', effort: 'low' },
				{ NAMZU_PROVIDER: 'openai', NAMZU_MODEL: 'env-model', NAMZU_EFFORT_LEVEL: 'max' },
			),
		).toEqual({ provider: 'openai', model: 'flag-model', effort: 'low' })
	})
	it.each(['NAMZU_PROVIDER', 'NAMZU_MODEL', 'NAMZU_SUBAGENT_MODEL', 'NAMZU_EFFORT_LEVEL'])(
		'refuses an empty %s rather than silently changing the profile',
		(name) => {
			expect(() => readModelLaunchEnvironment({ [name]: ' ' })).toThrow(name)
		},
	)
	it('refuses an unknown effort', () => {
		expect(() => readModelLaunchEnvironment({ NAMZU_EFFORT_LEVEL: 'extreme' })).toThrow(
			'NAMZU_EFFORT_LEVEL',
		)
	})
	it.each(['0', '-1', '1.5', 'Infinity', '', '9007199254740992'])(
		'refuses an invalid token size %j',
		(value) => {
			expect(() => positiveTokenCount(value, '--max-output-tokens')).toThrow('--max-output-tokens')
		},
	)
})
