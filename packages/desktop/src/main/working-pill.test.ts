import { describe, expect, it } from 'vitest'
import type { DesktopEvent, PermissionResponse, PermissionView } from '../shared/protocol.js'
import {
	type PillAction,
	type PillHost,
	type PillSurface,
	type PillView,
	WorkingPill,
	stepWords,
} from './working-pill.js'

function setup(own: (app: string) => boolean = (app) => app.toLowerCase() === 'namzu') {
	const shown: (PillView | 'hidden')[] = []
	const stopped: string[] = []
	const answers: { sessionId: string; requestId: string; response: PermissionResponse }[] = []
	const control: { stopFails?: Error } = {}
	let act: (action: PillAction) => void = () => {}
	let created = 0
	let destroyed = 0
	const surface: PillSurface = {
		show: (view) => shown.push(view),
		destroy: () => {
			destroyed++
			shown.push('hidden')
		},
	}
	const host: PillHost = {
		create: (callback) => {
			created++
			act = callback
			return surface
		},
		stop: (sessionId) => {
			stopped.push(sessionId)
			if (control.stopFails) return Promise.reject(control.stopFails)
		},
		answer: (sessionId, requestId, response) => {
			answers.push({ sessionId, requestId, response })
		},
		own,
	}
	const pill = new WorkingPill(host)
	return {
		host: control,
		pill,
		shown,
		stopped,
		answers,
		press: (action: PillAction) => act(action),
		created: () => created,
		destroyed: () => destroyed,
	}
}

const call = (
	label: string,
	status: 'pending' | 'completed' = 'pending',
	title = 'computer_use',
): DesktopEvent => ({
	kind: 'update',
	projectId: 'p',
	sessionId: 's1',
	update: {
		kind: 'tool_call',
		toolCallId: `t-${label}`,
		title,
		status,
		view: { kind: 'generic', label },
	},
})
const frame = (app: string): DesktopEvent => ({
	kind: 'computer-frame',
	sessionId: 's1',
	frame: {
		sessionId: 's1',
		toolCallId: 't-1',
		frameId: 's1',
		action: 'Click',
		app,
		mimeType: 'image/png',
		data: 'AAAA',
		width: 4,
		height: 4,
	},
})
const ask = (id: string, extra: Partial<PermissionView> = {}): DesktopEvent => ({
	kind: 'permission',
	request: {
		id,
		sessionId: 's1',
		projectId: 'p',
		calls: [
			{
				id: 'c',
				name: 'computer_use',
				input: { type: 'mouse_click', at: { x: 1, y: 1 } },
				isDestructive: true,
				computer: { app: 'Notepad' },
			},
		],
		...extra,
	},
})
const ended: DesktopEvent = { kind: 'state', sessionId: 's1', running: false, queued: [] }

describe('the working pill', () => {
	it('is shown while a computer action runs in another application, with the app and the last step', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click left at (812, 403)'))
		pill.observe(frame('Notepad'))
		expect(shown.at(-1)).toMatchObject({
			sessionId: 's1',
			app: 'Notepad',
			step: 'Click left at (812, 403)',
		})
		expect(shown.at(-1)).not.toHaveProperty('approval')
	})

	it('keeps the last step while a row carries only the tool name', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click left at (1, 2)'))
		pill.observe(call('computer_use'))
		expect(shown.at(-1)).toMatchObject({ step: 'Click left at (1, 2)' })
	})

	it('says "your computer" until the application is known', () => {
		const { pill, shown } = setup()
		pill.observe(call('Capture screenshot'))
		expect(shown.at(-1)).toMatchObject({ app: 'your computer' })
	})

	it('stops the turn from Stop, and only for the conversation it shows', () => {
		const { pill, press, stopped } = setup()
		pill.observe(call('Click'))
		press({ type: 'stop', sessionId: 'other' })
		expect(stopped).toEqual([])
		press({ type: 'stop', sessionId: 's1' })
		expect(stopped).toEqual(['s1'])
	})

	it('says so when the turn cannot be stopped, rather than looking stopped', async () => {
		const { pill, shown, press, host } = setup()
		host.stopFails = new Error('The engine did not answer.')
		pill.observe(call('Click'))
		press({ type: 'stop', sessionId: 's1' })
		await Promise.resolve()
		await Promise.resolve()
		expect(shown.at(-1)).toMatchObject({ step: 'Couldn’t stop this reply' })
		expect(JSON.stringify(shown.at(-1))).not.toContain('engine did not answer')
	})

	it('grows to hold an approval that can be answered from the pill', () => {
		const { pill, shown, press, answers } = setup()
		pill.observe(call('Click'))
		pill.observe(frame('Notepad'))
		pill.observe(ask('r1', { appRequest: { apps: ['Notepad'] } }))
		const view = shown.at(-1) as PillView
		expect(view.approval).toMatchObject({
			requestId: 'r1',
			title: 'Allow Namzu to use Notepad in this conversation?',
			choices: ['allow', 'once', 'deny'],
		})
		press({ type: 'answer', requestId: 'r1', choice: 'allow' })
		expect(answers).toEqual([
			{ sessionId: 's1', requestId: 'r1', response: { outcome: 'approve_all' } },
		])
		// Answered: the question is gone and the pill is back to working.
		expect(shown.at(-1)).not.toHaveProperty('approval')
	})

	it('asks about a browser in its own words, with no "once"', () => {
		const { pill, shown, press, answers } = setup()
		pill.observe(call('Click'))
		pill.observe(frame('Brave'))
		pill.observe(ask('r1', { appRequest: { apps: ['Brave'], browser: true } }))
		expect((shown.at(-1) as PillView).approval).toMatchObject({
			title: 'Let Namzu click and type in Brave in this conversation?',
			choices: ['allow', 'deny'],
		})
		press({ type: 'answer', requestId: 'r1', choice: 'allow' })
		expect(answers).toEqual([
			{ sessionId: 's1', requestId: 'r1', response: { outcome: 'approve_all' } },
		])
	})

	it('stays up between the answer and the action the question was about', () => {
		const { pill, shown, press, created } = setup()
		pill.observe(ask('r1'))
		press({ type: 'answer', requestId: 'r1', choice: 'allow' })
		// No action row has arrived yet: the window is not taken away and made again.
		expect(shown.at(-1)).not.toBe('hidden')
		expect(shown.at(-1)).not.toHaveProperty('approval')
		pill.observe(call('Click'))
		expect(created()).toBe(1)
	})

	it('maps Allow once and Deny to a plain yes and to a no', () => {
		const { pill, press, answers } = setup()
		pill.observe(ask('r1', { appRequest: { apps: ['Notepad'] } }))
		press({ type: 'answer', requestId: 'r1', choice: 'once' })
		pill.observe(ask('r2', { appRequest: { apps: ['Notepad'] } }))
		press({ type: 'answer', requestId: 'r2', choice: 'deny' })
		expect(answers.map((entry) => entry.response.outcome)).toEqual(['approve', 'reject'])
	})

	it('shows an action question with its warning and answers it as one yes', () => {
		const { pill, shown, press, answers } = setup()
		pill.observe(
			ask('r1', {
				calls: [
					{
						id: 'c',
						name: 'computer_use',
						input: { type: 'key', keys: 'ALT+F4' },
						isDestructive: true,
						computer: { app: 'Notepad', consequence: 'presses ALT+F4' },
					},
				],
			}),
		)
		const approval = (shown.at(-1) as PillView).approval
		expect(approval).toMatchObject({
			detail: 'Press ALT+F4',
			warning: 'This presses ALT+F4.',
			choices: ['allow', 'deny'],
		})
		press({ type: 'answer', requestId: 'r1', choice: 'allow' })
		expect(answers[0]?.response).toEqual({ outcome: 'approve' })
	})

	it('leaves a question about anything but the computer to the main window', () => {
		const { pill, shown } = setup()
		pill.observe({
			kind: 'permission',
			request: {
				id: 'r1',
				sessionId: 's1',
				projectId: 'p',
				calls: [{ id: 'b', name: 'bash', input: { command: 'ls' }, isDestructive: true }],
			},
		})
		expect(shown).toEqual([])
	})

	it('hides when the agent asks about a command instead', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click'))
		pill.observe({
			kind: 'permission',
			request: {
				id: 'r9',
				sessionId: 's1',
				projectId: 'p',
				calls: [{ id: 'b', name: 'bash', input: { command: 'ls' }, isDestructive: true }],
			},
		})
		expect(shown.at(-1)).toBe('hidden')
	})

	it('hides when the turn ends', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click'))
		pill.observe(ended)
		expect(shown.at(-1)).toBe('hidden')
		expect(pill.isShown()).toBe(false)
	})

	it('hides when the turn ends while a question is pending', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click'))
		pill.observe(ask('r1'))
		pill.observe({
			kind: 'update',
			projectId: 'p',
			sessionId: 's1',
			update: { kind: 'turn_ended', stopReason: 'cancelled' },
		})
		expect(shown.at(-1)).toBe('hidden')
	})

	it('hides when the agent goes on to other work', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click'))
		pill.observe(call('Run ls', 'pending', 'bash'))
		expect(shown.at(-1)).toBe('hidden')
		pill.observe(call('Click again'))
		expect(shown.at(-1)).toMatchObject({ step: 'Click again' })
	})

	it('is not shown for work in Namzu itself', () => {
		const { pill, shown } = setup()
		pill.observe(call('Click'))
		pill.observe(frame('Namzu'))
		expect(shown.at(-1)).toBe('hidden')
	})

	it('makes its window once for a stretch of computer work, and not at all without any', () => {
		const { pill, created } = setup()
		pill.observe(call('Run ls', 'pending', 'bash'))
		expect(created()).toBe(0)
		pill.observe(call('Click'))
		pill.observe(call('Type'))
		expect(created()).toBe(1)
	})

	it('takes its window away when the work ends, so the application can quit with its last window', () => {
		const { pill, created, destroyed } = setup()
		pill.observe(call('Click'))
		pill.observe(ended)
		expect(destroyed()).toBe(1)
		// The next turn that drives the computer makes a new one.
		pill.observe(call('Click'))
		expect(created()).toBe(2)
	})

	it('shortens a step to a few words', () => {
		expect(stepWords('Click\nsecond line')).toBe('Click')
		expect(stepWords('Type the words of a very long sentence into the document field')).toMatch(
			/…$/,
		)
		expect(
			stepWords('Type the words of a very long sentence into the document field').length,
		).toBeLessThanOrEqual(45)
	})

	it('lets go of its window when closed', () => {
		const { pill, destroyed } = setup()
		pill.observe(call('Click'))
		pill.close()
		expect(destroyed()).toBe(1)
		pill.close()
		expect(destroyed()).toBe(1)
	})
})
