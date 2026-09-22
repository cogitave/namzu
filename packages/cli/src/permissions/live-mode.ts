import type { ResumeHandler, SessionApprovalPolicy } from '@namzu/sdk'

import { type PermissionMode, permissionModeLabel } from './mode.js'

/**
 * A turn's permission mode, changeable while the turn runs.
 *
 * The mode used to be fixed when a turn began, so the interactive terminal
 * refused to change it until the turn ended ("Permissions were not changed.
 * Finish or stop the current work first."). The reference terminal does the
 * opposite: Shift+Tab takes effect at once, mid-turn, and only its footer
 * changes. This is the half of that which decides tool calls.
 *
 * The rules, and why each is the safe one:
 *
 * - **Every review decision reads the mode when it is asked, once.** A request
 *   takes the mode current at that moment and is decided under it to the end,
 *   including while a person is looking at its dialog. A switch made while a
 *   dialog is on screen therefore governs the NEXT request, never the one
 *   already asked: the operator is answering the question they were shown.
 * - **Plan mode entered mid-turn blocks every later change.** The next request
 *   that would change anything is refused with the plan-mode feedback, in this
 *   turn and in the delegated turns that borrow its handler.
 * - **Leaving plan mode approves nothing retroactively.** A refused call stays
 *   refused; nothing is replayed. Later requests are simply decided under the
 *   new mode.
 * - **A change is recorded before it takes effect.** The turn's approval-policy
 *   box writes `approval_policy_changed` to the session log and queues the
 *   kernel's one-time notice to the model; a request that arrives while that
 *   record is being written waits for it, so the log never shows a decision
 *   that precedes the change permitting it.
 */

export interface LiveModeOptions {
	/** The mode the turn was started with. */
	readonly initial: PermissionMode
	/** The host's current mode, read at every decision. Absent: the mode never changes. */
	readonly read?: () => PermissionMode
	/**
	 * The mode the durable log last recorded for this conversation, when it
	 * differs from `initial` because the operator changed it between turns.
	 * The change is then recorded on this turn as soon as its box exists.
	 */
	readonly recorded?: PermissionMode
	/** Build the review handler for one mode. Called at most once per mode. */
	readonly handlerFor: (mode: PermissionMode) => ResumeHandler
}

export interface LiveModeControl {
	/** The turn's review handler; hand it to the kernel and to delegated turns. */
	readonly handler: ResumeHandler
	/** The policy name the turn starts under (`approvalPolicyName`). */
	readonly initialName: PermissionMode
	/** The mode decisions are made under right now. */
	current(): PermissionMode
	/** Receive the turn's approval-policy box (`onApprovalPolicy`). */
	attach(box: SessionApprovalPolicy): void
	/**
	 * Record a change on the turn's box. Resolves once it is durable; a
	 * failure to record is swallowed so a logging fault cannot wedge review.
	 */
	record(mode: PermissionMode, reason: string): Promise<void>
}

/** The reason written with a change, and read by the model in its one-time notice. */
export function permissionChangeReason(
	mode: PermissionMode,
	when: 'now' | 'between-turns',
): string {
	const who =
		when === 'now'
			? 'the operator changed the permission mode during this turn'
			: 'the operator changed the permission mode since the previous turn'
	if (mode === 'plan') {
		return `${who} to plan mode: read and plan only; any call that would change something is refused until the operator leaves plan mode`
	}
	return `${who} to ${permissionModeLabel(mode)}`
}

export function createLiveModeControl(options: LiveModeOptions): LiveModeControl {
	const handlers = new Map<PermissionMode, ResumeHandler>()
	const handlerOf = (mode: PermissionMode): ResumeHandler => {
		let handler = handlers.get(mode)
		if (!handler) {
			handler = options.handlerFor(mode)
			handlers.set(mode, handler)
		}
		return handler
	}
	const current = (): PermissionMode => options.read?.() ?? options.initial
	let box: SessionApprovalPolicy | undefined
	let recording: Promise<void> = Promise.resolve()

	const handler: ResumeHandler = async (request) => {
		// A change being recorded lands before anything is decided under it —
		// including one that began while this request was already waiting.
		let pending: Promise<void>
		do {
			pending = recording
			await pending
		} while (pending !== recording)
		// Read ONCE. A dialog this request opens is decided under this mode even
		// if the operator switches while it is on screen.
		return handlerOf(current())(request)
	}

	const record = (mode: PermissionMode, reason: string): Promise<void> => {
		recording = recording
			.then(async () => {
				if (box && box.current.name !== mode) await box.set({ name: mode, handler }, reason)
			})
			.catch(() => {})
		return recording
	}

	const initialName = options.recorded ?? options.initial
	return {
		handler,
		initialName,
		current,
		attach(next) {
			box = next
			const now = current()
			if (next.current.name !== now) {
				void record(
					now,
					permissionChangeReason(now, now === options.initial ? 'between-turns' : 'now'),
				)
			}
		},
		record,
	}
}
