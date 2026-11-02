import { describe, expect, it } from 'vitest'

import { type RoundGateFacts, type RoundSource, SOURCE_GATES, admissionBlocked } from '../gates.js'

/**
 * The four conditions as they were written in the screen's four effects before
 * they became one table. Kept here word for word as the oracle: the table must
 * agree with every one of them for every combination of facts.
 */
function legacyBlocked(source: RoundSource, f: RoundGateFacts): boolean {
	const queued = f.queueLength > 0
	switch (source) {
		case 'goal':
			return (
				f.goalAdmissionInFlight ||
				!f.idle ||
				!f.ready ||
				!f.hasProvider ||
				queued ||
				f.turnRunning ||
				f.unsettledTurn ||
				f.pendingModelSwitch ||
				f.conversationMutation ||
				f.exporting ||
				f.compacting ||
				f.textPrompt ||
				f.choicePicker ||
				f.copyPicker ||
				f.goalCommandInFlight
			)
		case 'queue':
			return (
				!f.idle ||
				!f.ready ||
				!queued ||
				f.queuePaused ||
				f.turnRunning ||
				f.unsettledTurn ||
				f.pendingModelSwitch ||
				f.conversationMutation ||
				f.exporting ||
				f.compacting ||
				f.textPrompt ||
				f.choicePicker ||
				f.copyPicker ||
				f.goalCommandInFlight
			)
		case 'peer':
			return (
				!f.ready ||
				!f.idle ||
				f.turnRunning ||
				f.unsettledTurn ||
				f.queuePaused ||
				f.pendingModelSwitch ||
				f.conversationMutation ||
				f.textPrompt ||
				f.choicePicker ||
				f.copyPicker ||
				f.exporting ||
				f.compacting ||
				f.goalCommandInFlight
			)
		case 'notice':
			return (
				!f.ready ||
				!f.idle ||
				f.turnRunning ||
				f.unsettledTurn ||
				f.queuePaused ||
				f.pendingModelSwitch ||
				f.conversationMutation ||
				f.textPrompt ||
				f.choicePicker ||
				f.copyPicker ||
				f.exporting ||
				f.compacting ||
				f.goalCommandInFlight ||
				f.noticeQueued
			)
	}
}

const BOOLEANS = [
	'idle',
	'ready',
	'hasProvider',
	'turnRunning',
	'unsettledTurn',
	'pendingModelSwitch',
	'conversationMutation',
	'exporting',
	'compacting',
	'textPrompt',
	'choicePicker',
	'copyPicker',
	'goalCommandInFlight',
	'goalAdmissionInFlight',
	'queuePaused',
	'noticeQueued',
] as const

function facts(bits: number, queueLength: number): RoundGateFacts {
	const flags = Object.fromEntries(
		BOOLEANS.map((name, index) => [name, ((bits >> index) & 1) === 1]),
	)
	return { ...(flags as Omit<RoundGateFacts, 'queueLength'>), queueLength }
}

const CLEAR: RoundGateFacts = {
	idle: true,
	ready: true,
	hasProvider: true,
	turnRunning: false,
	unsettledTurn: false,
	pendingModelSwitch: false,
	conversationMutation: false,
	exporting: false,
	compacting: false,
	textPrompt: false,
	choicePicker: false,
	copyPicker: false,
	goalCommandInFlight: false,
	goalAdmissionInFlight: false,
	queueLength: 0,
	queuePaused: false,
	noticeQueued: false,
}

describe('the gate table', () => {
	it('agrees with the four original conditions for every combination of facts', () => {
		for (const source of ['queue', 'goal', 'peer', 'notice'] as const) {
			for (let queueLength = 0; queueLength <= 1; queueLength += 1) {
				for (let bits = 0; bits < 1 << BOOLEANS.length; bits += 1) {
					const f = facts(bits, queueLength)
					expect(admissionBlocked(source, f) !== null, `${source} ${JSON.stringify(f)}`).toBe(
						legacyBlocked(source, f),
					)
				}
			}
		}
	})

	it('lets each source start from a quiet, idle screen once its own need is met', () => {
		expect(admissionBlocked('queue', { ...CLEAR, queueLength: 1 })).toBeNull()
		expect(admissionBlocked('goal', CLEAR)).toBeNull()
		expect(admissionBlocked('peer', CLEAR)).toBeNull()
		expect(admissionBlocked('notice', CLEAR)).toBeNull()
	})

	it('keeps the four differences between the sources exactly as they were', () => {
		// A held queue holds everything except an admitted goal round.
		const held = { ...CLEAR, queuePaused: true, queueLength: 0 }
		expect(admissionBlocked('goal', held)).toBeNull()
		expect(admissionBlocked('peer', held)).not.toBeNull()
		expect(admissionBlocked('notice', held)).not.toBeNull()
		expect(admissionBlocked('queue', { ...held, queueLength: 1 })).not.toBeNull()
		// Only the goal driver needs an empty queue; peer mail and wake notices do not.
		expect(admissionBlocked('goal', { ...CLEAR, queueLength: 1 })).not.toBeNull()
		expect(admissionBlocked('peer', { ...CLEAR, queueLength: 1 })).toBeNull()
		expect(admissionBlocked('notice', { ...CLEAR, queueLength: 1 })).toBeNull()
		// Only the goal driver needs a provider before it reserves a turn.
		expect(admissionBlocked('goal', { ...CLEAR, hasProvider: false })).not.toBeNull()
		expect(admissionBlocked('queue', { ...CLEAR, hasProvider: false, queueLength: 1 })).toBeNull()
		expect(admissionBlocked('peer', { ...CLEAR, hasProvider: false })).toBeNull()
		expect(admissionBlocked('notice', { ...CLEAR, hasProvider: false })).toBeNull()
		// Only a wake notice waits for a wake notice already queued.
		expect(admissionBlocked('notice', { ...CLEAR, noticeQueued: true })).not.toBeNull()
		expect(admissionBlocked('peer', { ...CLEAR, noticeQueued: true })).toBeNull()
	})

	it('records the same four differences as data', () => {
		expect(SOURCE_GATES).toEqual({
			queue: {
				ignoresPause: false,
				needsEmptyQueue: false,
				needsQueuedItem: true,
				needsProvider: false,
				onePendingNotice: false,
				oneInFlight: false,
			},
			goal: {
				ignoresPause: true,
				needsEmptyQueue: true,
				needsQueuedItem: false,
				needsProvider: true,
				onePendingNotice: false,
				oneInFlight: true,
			},
			peer: {
				ignoresPause: false,
				needsEmptyQueue: false,
				needsQueuedItem: false,
				needsProvider: false,
				onePendingNotice: false,
				oneInFlight: false,
			},
			notice: {
				ignoresPause: false,
				needsEmptyQueue: false,
				needsQueuedItem: false,
				needsProvider: false,
				onePendingNotice: true,
				oneInFlight: false,
			},
		})
	})
})
