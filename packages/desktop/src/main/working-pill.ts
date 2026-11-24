import { WHOLE_SCREEN, appLabel } from '../shared/computer-protocol.js'
import type { DesktopEvent, PermissionResponse, PermissionView } from '../shared/protocol.js'
import { BROWSER_WINDOW_TOOL, COMPUTER_TOOL, SCREEN_MOMENT_TOOL } from './computer-grants.js'

/** What the pill draws. Everything in it is text the person can read; nothing in it acts by itself. */
export interface PillView {
	/** The conversation whose work this is; Stop stops its turn. */
	sessionId: string
	/** The application Namzu is working in, or "your computer" when it could not be told. */
	app: string
	/** The last step in a few words. */
	step: string
	/** A question waiting for the person; the pill grows to show it. */
	approval?: PillApproval
}

export interface PillApproval {
	requestId: string
	/** The question, for example "Allow Namzu to use Notepad in this conversation?". */
	title: string
	/** What the action is, when the question is about one action. */
	detail?: string
	/** The buttons, in order; `once` is only offered for a question about an application. */
	choices: ('allow' | 'once' | 'deny')[]
	/** Why a person should read this one: it closes, deletes, sends or submits. */
	warning?: string
}

export type PillAction =
	| { type: 'stop'; sessionId: string }
	| { type: 'answer'; requestId: string; choice: 'allow' | 'once' | 'deny' }

/** The window the pill lives in. The Electron one is in `working-pill-window.ts`; tests use a fake. */
export interface PillSurface {
	show(view: PillView): void
	/** Takes the window away. A window kept hidden would stop the application quitting with its last window. */
	destroy(): void
}

export interface PillHost {
	/** Made on first use and kept; `act` is called for what the person presses. */
	create(act: (action: PillAction) => void): PillSurface
	/** Stops the conversation's turn, as its stop button does. */
	stop(sessionId: string): Promise<void> | void
	/** Answers a pending question as the card would. Throws when it is no longer pending. */
	answer(sessionId: string, requestId: string, response: PermissionResponse): void
	/** Whether an application is one of Namzu's own windows. */
	own(app: string): boolean
}

interface Active {
	/** The newest computer step, until another kind of work or the end of the turn. */
	computing: boolean
	app?: string
	step: string
	/** The newest first. */
	order: number
}

const YOUR_COMPUTER = 'your computer'
const STEP_MAX = 44

/** A call's own label shortened to a few words: the first line, cut at a word. */
export function stepWords(label: string): string {
	const line = label.split('\n')[0]?.replace(/\s+/g, ' ').trim() ?? ''
	if (line.length <= STEP_MAX) return line
	const cut = line.slice(0, STEP_MAX)
	const space = cut.lastIndexOf(' ')
	return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What an action a person is asked about is, in words that do not need the card. */
function actionWords(call: PermissionView['calls'][number]): string {
	if (call.name === SCREEN_MOMENT_TOOL) {
		const app = record(call.input) && typeof call.input.app === 'string' ? call.input.app : ''
		return app ? `Use the keyboard and mouse for ${app}` : 'Use the keyboard and mouse for a moment'
	}
	if (call.name === BROWSER_WINDOW_TOOL) {
		const app = record(call.input) && typeof call.input.app === 'string' ? call.input.app : ''
		return app ? `Click and type in ${app}` : 'Click and type in a browser'
	}
	const input = record(call.input) ? call.input : {}
	const type = typeof input.type === 'string' ? input.type : ''
	if (type === 'batch') return 'Several steps on the screen'
	if (type === 'type_text') return 'Type text'
	if (type === 'key') return typeof input.keys === 'string' ? `Press ${input.keys}` : 'Press keys'
	if (type === 'mouse_click') return 'Click'
	if (type === 'ui_act' || type === 'ui_do') return 'Use a control'
	if (type === 'screenshot' || type === 'zoom' || type === 'list_windows' || type === 'ui_snapshot')
		return 'Look at the screen'
	return 'Act on the screen'
}

/**
 * The small always-on-top control that stays visible while Namzu works in another application. It
 * shows what is being used and the last step, offers Stop, and grows to hold a question so the
 * person never has to find the main window. It follows the conversations' events and decides only
 * whether it is shown and what it says; drawing and placing it belong to the surface.
 */
export class WorkingPill {
	private surface: PillSurface | undefined
	private readonly active = new Map<string, Active>()
	private readonly pending = new Map<string, PermissionView>()
	private counter = 0
	private shown: string | undefined

	constructor(private readonly host: PillHost) {}

	/** Feed every event the operator emits. */
	observe(event: DesktopEvent): void {
		switch (event.kind) {
			case 'update': {
				const update = event.update
				if (update.kind === 'tool_call') {
					if (update.title === COMPUTER_TOOL) {
						const entry = this.entry(event.sessionId)
						entry.computing = true
						entry.order = ++this.counter
						// A row that has not been worded yet carries only the tool's name; keep the last step then.
						if (
							update.view.kind === 'generic' &&
							update.view.label &&
							update.view.label !== update.title
						)
							entry.step = stepWords(update.view.label)
					} else if (update.status === 'pending') {
						// The agent went on to something else, in Namzu itself or in files and commands.
						const entry = this.active.get(event.sessionId)
						if (entry) entry.computing = false
					}
				} else if (update.kind === 'turn_ended') this.end(event.sessionId)
				break
			}
			case 'state':
				if (!event.running) this.end(event.sessionId)
				break
			case 'computer-frame': {
				const entry = this.entry(event.sessionId)
				if (event.frame.app) entry.app = event.frame.app
				break
			}
			case 'permission': {
				if (this.askedHere(event.request)) {
					this.pending.set(event.request.id, event.request)
					// A question about the computer is computer work already, so the pill stays up
					// between the answer and the action it was about.
					const entry = this.entry(event.request.sessionId)
					entry.computing = true
					entry.order = ++this.counter
				} else {
					// A command or a file change is asked about in the main window: the agent has gone on to
					// other work, so there is no application being used while it waits.
					const entry = this.active.get(event.request.sessionId)
					if (entry) entry.computing = false
				}
				break
			}
			case 'permission-cleared':
				if (event.requestId) this.pending.delete(event.requestId)
				else
					for (const [id, request] of this.pending)
						if (request.sessionId === event.sessionId) this.pending.delete(id)
				break
			default:
				return
		}
		this.render()
	}

	/** A question the pill can answer: every call is about the computer. */
	private askedHere(request: PermissionView): boolean {
		return (
			request.calls.length > 0 &&
			request.calls.every(
				(call) =>
					call.name === COMPUTER_TOOL ||
					call.name === SCREEN_MOMENT_TOOL ||
					call.name === BROWSER_WINDOW_TOOL,
			)
		)
	}

	private entry(sessionId: string): Active {
		let entry = this.active.get(sessionId)
		if (!entry) {
			entry = { computing: false, step: 'Working', order: 0 }
			this.active.set(sessionId, entry)
		}
		return entry
	}

	private end(sessionId: string): void {
		this.active.delete(sessionId)
		for (const [id, request] of this.pending)
			if (request.sessionId === sessionId) this.pending.delete(id)
	}

	private appFor(sessionId: string, request?: PermissionView): string {
		const named =
			request?.appRequest?.apps[0] ??
			request?.calls.map((call) => call.computer?.app).find(Boolean) ??
			this.active.get(sessionId)?.app
		return named && named !== WHOLE_SCREEN ? appLabel(named) : YOUR_COMPUTER
	}

	private approvalOf(request: PermissionView): PillApproval {
		if (request.appRequest) {
			const apps = request.appRequest.apps.map((app) => (app === WHOLE_SCREEN ? 'the screen' : app))
			// A browser is asked once, in its own words; a yes there covers the conversation, so there is no "once".
			if (request.appRequest.browser)
				return {
					requestId: request.id,
					title: `Let Namzu click and type in ${apps.join(' and ')} in this conversation?`,
					choices: ['allow', 'deny'],
				}
			return {
				requestId: request.id,
				title: `Allow Namzu to use ${apps.join(' and ')} in this conversation?`,
				choices: ['allow', 'once', 'deny'],
			}
		}
		const first = request.calls[0]
		const warning = request.calls.map((call) => call.computer?.consequence).find(Boolean)
		const screen = request.calls.some(
			(call) => call.alwaysAsk === true && call.name === COMPUTER_TOOL,
		)
		return {
			requestId: request.id,
			title: screen ? 'Let Namzu look at your screen?' : 'Allow this step?',
			...(first ? { detail: actionWords(first) } : {}),
			...(warning ? { warning: `This ${warning}.` } : {}),
			choices: ['allow', 'deny'],
		}
	}

	/** What is showing now, for the surface and for a test. */
	view(): PillView | undefined {
		const waiting = [...this.pending.values()].at(-1)
		if (waiting) {
			const app = this.appFor(waiting.sessionId, waiting)
			if (app !== YOUR_COMPUTER && this.host.own(app)) return undefined
			return {
				sessionId: waiting.sessionId,
				app,
				step: this.active.get(waiting.sessionId)?.step ?? 'Waiting for you',
				approval: this.approvalOf(waiting),
			}
		}
		let newest: [string, Active] | undefined
		for (const [id, entry] of this.active)
			if (entry.computing && (!newest || entry.order > newest[1].order)) newest = [id, entry]
		if (!newest) return undefined
		const app = this.appFor(newest[0])
		// Working in Namzu itself is not "using another application".
		if (app !== YOUR_COMPUTER && this.host.own(app)) return undefined
		return { sessionId: newest[0], app, step: newest[1].step }
	}

	private render(): void {
		const view = this.view()
		if (!view) {
			if (this.shown !== undefined) {
				this.shown = undefined
				this.surface?.destroy()
				this.surface = undefined
			}
			return
		}
		this.surface ??= this.host.create((action) => this.act(action))
		const key = JSON.stringify(view)
		if (key === this.shown) return
		this.shown = key
		this.surface.show(view)
	}

	private act(action: PillAction): void {
		if (action.type === 'stop') {
			const view = this.view()
			// Only the conversation the pill shows can be stopped from it.
			if (view && view.sessionId === action.sessionId) this.stop(action.sessionId)
			return
		}
		const request = this.pending.get(action.requestId)
		if (!request) return
		const response: PermissionResponse =
			action.choice === 'deny'
				? { outcome: 'reject' }
				: action.choice === 'allow' && request.appRequest
					? { outcome: 'approve_all' }
					: { outcome: 'approve' }
		try {
			this.host.answer(request.sessionId, request.id, response)
		} catch {
			/* Already answered in the window. */
		}
		this.pending.delete(request.id)
		this.render()
	}

	/** Stops the conversation's turn; when the engine cannot, the pill says so instead of looking stopped. */
	private stop(sessionId: string): void {
		const failed = () => {
			const entry = this.active.get(sessionId)
			if (!entry) return
			// The engine's own sentence is technical; the pill says it plainly.
			entry.step = stepWords('Couldn’t stop this reply')
			this.render()
		}
		try {
			void Promise.resolve(this.host.stop(sessionId)).catch(failed)
		} catch {
			failed()
		}
	}

	/** True when the pill is up, for the raise and for a test. */
	isShown(): boolean {
		return this.shown !== undefined
	}

	close(): void {
		this.surface?.destroy()
		this.surface = undefined
		this.shown = undefined
		this.active.clear()
		this.pending.clear()
	}
}
