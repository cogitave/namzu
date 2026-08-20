import { describe, expect, it } from 'vitest'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { type TopicManagerDependency, resolveTopicManager } from '../dependency.js'
import { TopicManager } from '../lifecycle.js'

function makeManager(): TopicManager {
	return new TopicManager({
		topicStore: new InMemoryTopicStore(),
		sessionStore: new InMemorySessionStore(),
	})
}

describe('TopicManager dependency migration', () => {
	it('requires at least one spelling at compile time', () => {
		const acceptsDependency = (_dependency: TopicManagerDependency): void => undefined
		// @ts-expect-error A Topic lifecycle gate cannot be omitted.
		acceptsDependency({})
	})

	it('accepts the deprecated spelling for a migration window', () => {
		const manager = makeManager()
		expect(resolveTopicManager({ threadManager: manager })).toBe(manager)
	})

	it('resolves the canonical spelling', () => {
		const manager = makeManager()
		expect(resolveTopicManager({ topicManager: manager })).toBe(manager)
	})

	it('refuses two different archive authorities', () => {
		expect(() =>
			resolveTopicManager({ topicManager: makeManager(), threadManager: makeManager() }),
		).toThrow(/different TopicManager instances/)
	})
})
