/**
 * A skill, a scheduled job's prompt and a run's summary are read later by the
 * person who asked for them, so they follow that person's language. A
 * Turkish-speaking operator's `/skills save` produced an English skill, the
 * schedule tool an English job prompt, and the run an English summary.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { learnSkillPrompt, newSkillPrompt } from './save.js'
import { systemSkillsDir } from './store.js'

const skill = (name: string) => readFileSync(join(systemSkillsDir(), name, 'SKILL.md'), 'utf8')

describe("the user's language", () => {
	it('is asked for by /skills save and /skills new, which namzu writes in English', () => {
		expect(learnSkillPrompt()).toContain(
			'Write the description and instructions in the language of my own earlier messages in this conversation, not in English by default',
		)
		expect(newSkillPrompt('')).toContain(
			'Write the skill in the language of my own messages, not in English by default',
		)
	})

	it('is in the skill-creator and schedule-task instructions', () => {
		expect(skill('skill-creator')).toMatch(
			/\*\*language\*\*: write the description and the body in the language the user\s+writes to you in/,
		)
		expect(skill('schedule-task')).toMatch(
			/Write it in the language the user writes to you in, not in English by\s+default/,
		)
	})
})
