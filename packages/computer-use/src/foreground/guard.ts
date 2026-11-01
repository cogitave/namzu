import type {
	ComputerUseAction,
	ComputerUseResult,
	FocusWindowResult,
	WindowInfo,
} from '@namzu/sdk'
import type { Adapter } from '../adapters/types.js'
import type { ForegroundLadder } from './ladder.js'
import { STOPPED_TEXT } from './ladder.js'
import type { ForegroundOutcome, ForegroundSubject } from './types.js'

/** Display actions that put input on the user's screen. */
const SCREEN_ACTIONS = new Set<ComputerUseAction['type']>([
	'mouse_move',
	'mouse_click',
	'mouse_drag',
	'scroll',
	'type_text',
	'key',
])

const heldText = (ms: number): string => `${(Math.max(ms, 100) / 1000).toFixed(1)} s`

/**
 * What an interrupted or stopped burst tells the model. Neither is proof that
 * the input arrived or did not, so both leave the action unconfirmed.
 */
export function interferenceNote(outcome: {
	readonly interfered: boolean
	readonly stopped: boolean
}): string | undefined {
	if (outcome.stopped) return STOPPED_TEXT
	if (outcome.interfered)
		return 'The user used the keyboard or mouse while the screen was in use, so the input may have landed somewhere else or only in part. Look at the window before repeating it.'
	return undefined
}

/** The sentence that tells the model a background action ran in the foreground. */
export function foregroundNote(
	outcome: Extract<ForegroundOutcome<unknown>, { kind: 'ran' }>,
): string {
	const put =
		outcome.restoredForeground || outcome.restoredCursor
			? ' The window and pointer that were there before were put back.'
			: outcome.restoreNote &&
					outcome.restoreNote !== 'the burst had no window to put back' &&
					!outcome.restoreNote.startsWith('the window that was in front is in front')
				? ` The window that was in front was not put back: ${outcome.restoreNote}.`
				: ''
	return `Background input was not possible here, so this used the screen for ${heldText(outcome.heldMs)}.${put}`
}

/**
 * Display input and `focusWindow` through the foreground ladder, for an
 * adapter that has no ladder of its own (the PowerShell path) and for the
 * display-scope calls of one that has. Window-scoped input is the wrapped
 * adapter's business: it decides when background is impossible.
 */
export function guardForeground(adapter: Adapter, ladder: ForegroundLadder): Adapter {
	const apps = new Map<string, WindowInfo>()
	const guarded: Adapter = {
		get capabilities() {
			return adapter.capabilities
		},
		get backend() {
			return adapter.backend
		},
		get fallbackReason() {
			return adapter.fallbackReason
		},
		getDisplayGeometry: () => adapter.getDisplayGeometry(),
		async execute(action) {
			if (!SCREEN_ACTIONS.has(action.type)) return adapter.execute(action)
			const outcome = await ladder.run(
				{
					subject: { app: 'the desktop' },
					keepCursor: action.type === 'mouse_move',
				},
				async () => adapter.execute(action),
			)
			if (outcome.kind === 'blocked')
				return {
					type: 'ok',
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: outcome.block.detail,
				}
			const note = interferenceNote(outcome)
			if (!note || outcome.value.type !== 'ok') return outcome.value
			return mergeNote(outcome.value, note)
		},
		async dispose() {
			await ladder.dispose()
			await adapter.dispose?.()
		},
	}
	if (adapter.listWindows) {
		const list = adapter.listWindows.bind(adapter)
		guarded.listWindows = async () => {
			const windows = await list()
			apps.clear()
			for (const window of windows) apps.set(window.id, window)
			return windows
		}
	}
	if (adapter.focusWindow) {
		const focus = adapter.focusWindow.bind(adapter)
		guarded.focusWindow = async (id): Promise<FocusWindowResult> => {
			let window = apps.get(id)
			if (!window && guarded.listWindows) {
				await guarded.listWindows().catch(() => undefined)
				window = apps.get(id)
			}
			const subject: ForegroundSubject = window
				? { app: window.app, pid: window.pid, hwnd: window.id }
				: { app: 'the window you named', hwnd: id }
			const outcome = await ladder.run({ subject }, () => focus(id))
			if (outcome.kind === 'blocked')
				return {
					ok: false,
					focusedId: null,
					delivery: 'not_delivered',
					retrySafety: 'safe',
					detail: outcome.block.detail,
				}
			const note = interferenceNote(outcome)
			return note ? { ...outcome.value, detail: note } : outcome.value
		}
	}
	for (const name of [
		'captureWindow',
		'executeWindow',
		'captureRegion',
		'uiSnapshot',
		'uiAct',
	] as const) {
		const method = adapter[name]
		if (method) (guarded as unknown as Record<string, unknown>)[name] = method.bind(adapter)
	}
	return guarded
}

function mergeNote(
	result: Extract<ComputerUseResult, { type: 'ok' }>,
	note: string,
): ComputerUseResult {
	return {
		type: 'ok',
		delivery: result.delivery === 'not_delivered' ? 'not_delivered' : 'delivered_unverified',
		retrySafety: result.delivery === 'not_delivered' ? (result.retrySafety ?? 'safe') : 'unsafe',
		detail: [result.detail, note].filter(Boolean).join(' '),
	}
}
