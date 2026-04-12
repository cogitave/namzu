import { describe, expect, it } from 'vitest'
import { RUNTIME_DEFAULTS } from '../../config/runtime.js'
import { createConversationManager } from '../factory.js'
import {
	NullManager,
	SlidingWindowManager,
	StructuredCompactionManager,
} from '../managers/index.js'

describe('createConversationManager', () => {
	const config = RUNTIME_DEFAULTS.compaction

	it('should create NullManager for disabled strategy', () => {
		const manager = createConversationManager('disabled', config)
		expect(manager).toBeInstanceOf(NullManager)
		expect(manager.name).toBe('null')
	})

	it('should create SlidingWindowManager for sliding-window strategy', () => {
		const manager = createConversationManager('sliding-window', config)
		expect(manager).toBeInstanceOf(SlidingWindowManager)
		expect(manager.name).toBe('sliding-window')
	})

	it('should create StructuredCompactionManager for structured strategy', () => {
		const manager = createConversationManager('structured', config)
		expect(manager).toBeInstanceOf(StructuredCompactionManager)
		expect(manager.name).toBe('structured')
	})

	it('should throw on unknown strategy', () => {
		// @ts-expect-error - Testing invalid input
		expect(() => createConversationManager('unknown', config)).toThrow()
	})

	it('should pass keepRecentMessages to SlidingWindowManager', () => {
		const customConfig = {
			...config,
			keepRecentMessages: 8,
		}
		const manager = createConversationManager('sliding-window', customConfig)
		expect(manager).toBeInstanceOf(SlidingWindowManager)
	})

	it('should pass config to StructuredCompactionManager', () => {
		const customConfig = {
			...config,
			convoTextBudget: 5000,
		}
		const manager = createConversationManager('structured', customConfig)
		expect(manager).toBeInstanceOf(StructuredCompactionManager)
	})
})
