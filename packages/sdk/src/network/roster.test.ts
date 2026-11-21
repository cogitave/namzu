import { describe, expect, it } from 'vitest'
import {
	ROSTER_CACHE_MS,
	type RosterMachineView,
	type RosterView,
	generateSessionName,
	machineLabel,
	offlineSessions,
	resolveSessionTarget,
	sessionDisplayName,
	sessionLabel,
} from './roster.js'
import type { RosterSession } from './wire.js'

const s = (name: string, ref: string): RosterSession => ({
	ref,
	name,
	folder: 'proj',
	state: 'idle',
	mode: 'auto',
	acceptsMessages: true,
	kind: 'tui',
})
const m = (
	id: string,
	name: string,
	sessions: RosterSession[],
	status: RosterMachineView['status'] = 'online',
): RosterMachineView => ({ machineId: id.repeat(64).slice(0, 64), name, status, sessions })

describe('roster naming', () => {
	it('generates the same readable name for a session id every time', () => {
		expect(generateSessionName('abc')).toBe(generateSessionName('abc'))
		expect(generateSessionName('abc')).toMatch(/^[a-z]+-[a-z]+$/)
		expect(sessionDisplayName({ sessionId: 'abc', title: ' Parser work ' })).toBe('Parser work')
		expect(sessionDisplayName({ sessionId: 'abc' })).toBe(generateSessionName('abc'))
	})

	it('adds a ref only to rows that share a name', () => {
		const view: RosterView = {
			machines: [
				m('a', 'studio', [s('calm-heron', 'aaaaaa'), s('quiet-otter', 'bbbbbb')]),
				m('b', 'desk', [s('calm-heron', 'cccccc')]),
			],
		}
		const studio = view.machines[0] as RosterMachineView
		expect(sessionLabel(view, studio, studio.sessions[0] as RosterSession)).toBe(
			'calm-heron [aaaaaa]',
		)
		expect(sessionLabel(view, studio, studio.sessions[1] as RosterSession)).toBe('quiet-otter')
	})

	it('tells two machines of one name apart', () => {
		const view: RosterView = { machines: [m('a', 'laptop', []), m('b', 'laptop', [])] }
		expect(machineLabel(view, view.machines[0] as RosterMachineView)).toBe(
			`laptop (${'a'.repeat(6)})`,
		)
	})

	it('resolves a name, machine/name and ref, and reports ambiguity and absence', () => {
		const view: RosterView = {
			machines: [
				m('a', 'studio', [s('calm-heron', 'aaaaaa')]),
				m('b', 'desk', [s('calm-heron', 'cccccc'), s('swift-finch', 'dddddd')], 'online'),
				m('c', 'off', [s('gone', 'eeeeee')], 'offline'),
			],
		}
		expect(resolveSessionTarget(view, 'swift-finch')).toMatchObject({ ok: true })
		expect(resolveSessionTarget(view, 'desk/calm-heron')).toMatchObject({
			ok: true,
			session: { ref: 'cccccc' },
		})
		expect(resolveSessionTarget(view, 'calm-heron')).toMatchObject({
			ok: false,
			reason: 'ambiguous',
		})
		expect(resolveSessionTarget(view, 'calm-heron [aaaaaa]')).toMatchObject({
			ok: true,
			machine: { name: 'studio' },
		})
		expect(resolveSessionTarget(view, 'dddddd')).toMatchObject({
			ok: true,
			session: { name: 'swift-finch' },
		})
		expect(resolveSessionTarget(view, 'gone')).toMatchObject({ ok: false, reason: 'none' })
	})

	it('keeps a silent member sessions for 24 hours, then none', () => {
		const list = [s('a', 'aaaaaa')]
		expect(offlineSessions(list, 0, ROSTER_CACHE_MS)).toHaveLength(1)
		expect(offlineSessions(list, 0, ROSTER_CACHE_MS + 1)).toHaveLength(0)
	})
})
