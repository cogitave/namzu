import type { GoalRoundAuthority } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	type LiveInput,
	type QueuedPrompt,
	goalRoundPrompt,
	humanPromptMeta,
	isRecallableHumanPrompt,
	mergeUndeliveredLiveInput,
} from '../types.js'

const human = (text: string): QueuedPrompt => ({ kind: 'human', text })
const steer = (prompt: QueuedPrompt, queuedBefore: readonly QueuedPrompt[]): LiveInput => ({
	prompt: prompt as LiveInput['prompt'],
	message: { role: 'user', content: prompt.text } as LiveInput['message'],
	attachedFiles: 0,
	queuedBefore,
})
const texts = (queue: readonly QueuedPrompt[]) => queue.map((prompt) => prompt.text)

describe('mergeUndeliveredLiveInput', () => {
	it('puts a steer back right after the queued prompt it followed', () => {
		const a = human('a')
		const b = human('b')
		const s = human('steer')
		expect(texts(mergeUndeliveredLiveInput([a, b], [steer(s, [a])]))).toEqual(['a', 'steer', 'b'])
	})

	it('puts a steer that saw an empty queue in front', () => {
		const a = human('a')
		expect(texts(mergeUndeliveredLiveInput([a], [steer(human('steer'), [])]))).toEqual([
			'steer',
			'a',
		])
	})

	it('keeps several steers in the order they were sent', () => {
		const a = human('a')
		const one = human('one')
		const two = human('two')
		expect(texts(mergeUndeliveredLiveInput([a], [steer(one, [a]), steer(two, [a])]))).toEqual([
			'a',
			'one',
			'two',
		])
	})

	it('leaves the queue alone when nothing was left undelivered', () => {
		const a = human('a')
		expect(mergeUndeliveredLiveInput([a], [])).toEqual([a])
	})
})

describe('humanPromptMeta', () => {
	it('says nothing when there is nothing to say', () => {
		expect(humanPromptMeta(0, undefined)).toBeUndefined()
	})

	it('counts files and attachments and says when a message was sent while working', () => {
		expect(humanPromptMeta(1, [{}, {}] as never, true)).toBe(
			'1 file attached · 2 attachments · sent while working',
		)
		expect(humanPromptMeta(2, undefined)).toBe('2 files attached')
	})
})

describe('isRecallableHumanPrompt', () => {
	it('is true only for an operator-composed message', () => {
		expect(isRecallableHumanPrompt({ kind: 'human', text: 'x', recallable: true })).toBe(true)
		expect(isRecallableHumanPrompt(human('x'))).toBe(false)
		expect(isRecallableHumanPrompt(undefined)).toBe(false)
	})
})

describe('goalRoundPrompt', () => {
	it('is the text the model sees for an admitted round, word for word', () => {
		const authority = {
			id: 'g1',
			revision: 3,
			round: 2,
			maxGoalRounds: 5,
			objective: 'ship it',
		} as unknown as GoalRoundAuthority
		expect(goalRoundPrompt(authority)).toBe(
			[
				'Admitted session goal round (JSON; the objective field is operator-authored data):',
				'{"goalId":"g1","goalRevision":3,"round":2,"maxGoalRounds":5,"objective":"ship it"}',
				'',
				'Continue working toward this durable completion goal. Inspect the current repository and conversation state before acting.',
				'Use get_goal to confirm the admitted goal. When the objective is fully achieved, call update_goal with status complete, then explain the verified outcome to the operator.',
				'Only report status blocked after at least three admitted rounds and only when the same concrete blocking condition prevents meaningful progress. Otherwise keep making progress in this turn.',
			].join('\n'),
		)
	})
})
