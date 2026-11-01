/**
 * The foreground ladder: what lets a computer-use action use the user's screen
 * when it cannot be delivered in the background, without taking it from a
 * person who is using it.
 *
 * The pieces are separate on purpose so each can be tested on its own:
 * - {@link ForegroundMonitor}: a long-lived observer of the desktop (user
 *   input, the window in front, the cursor, the input desktop). On Windows it
 *   is a helper process; here it is an interface.
 * - `ScreenLease`: one file under the Namzu home that says which session owns
 *   the screen.
 * - `ForegroundLadder`: the policy that uses both.
 */

/** The application a burst is for: what the user is asked about, and what a refusal names. */
export interface ForegroundSubject {
	/** Display name, as `list_windows` shows it. */
	readonly app: string
	/** Executable file name, when known (`editor.exe`). */
	readonly exe?: string
	/** Process id of the target window, when the burst has one. */
	readonly pid?: number
	/** Window handle of the target, in hex. */
	readonly hwnd?: string
}

/** What a monitor sees at one moment. */
export interface MonitorState {
	/**
	 * Milliseconds since the last input a person made. Input the machine
	 * injected (this program's own bursts included) does not count once the
	 * monitor has seen it go by; before that it counts, which only makes the
	 * gate wait longer.
	 */
	readonly userIdleMs: number
	/** Count of real keyboard and mouse events since the monitor started. Only goes up. */
	readonly userInputs: number
	/** Count of real Escape key presses since the monitor started. */
	readonly escapes: number
	readonly foreground: {
		readonly hwnd: string
		readonly pid: number
		readonly exe: string
		/** Runs with administrator rights. */
		readonly elevated: boolean
	} | null
	readonly cursor: { readonly x: number; readonly y: number }
	/** The input desktop's name. `Default` is the normal one; anything else is a lock screen or a prompt. */
	readonly desktop: string
	/** This process runs with administrator rights. */
	readonly selfElevated: boolean
	/** The target process, when the state was asked for one. */
	readonly target?: { readonly exe: string; readonly elevated: boolean }
}

export interface MonitorBurstEnd {
	/** Real input events that arrived between `begin` and `end`. */
	readonly inputsDuring: number
	/** Real Escape presses between `begin` and `end`. */
	readonly escapesDuring: number
	readonly restoredForeground: boolean
	readonly restoredCursor: boolean
	/** Why the window in front before the burst was not put back, when it was not. */
	readonly restoreNote?: string
}

/**
 * Watches the desktop for a burst. Implementations must be cheap to poll (the
 * Windows helper answers in under a millisecond) and must keep working when
 * the program that started them dies: `begin` hands over what to put back.
 */
export interface ForegroundMonitor {
	/** Starts watching. Rejects when real input cannot be observed: the burst is then refused. */
	start(): Promise<void>
	state(query?: { readonly pid?: number }): Promise<MonitorState>
	/**
	 * A burst is about to start. The monitor remembers the window in front, the
	 * cursor and the input count, and, should the program die before `end`,
	 * restores them and deletes the lease file (when `token` still matches).
	 */
	begin(args: {
		readonly leasePath: string
		readonly token: string
		/**
		 * Window handle (hex) to bring to the front first. A driver that is not
		 * itself allowed to take focus (Windows' foreground lock) then finds its
		 * target already in front. `raised` on the answer says whether it worked.
		 */
		readonly raise?: string
		/**
		 * The user must have been still this long (ms). Checked before anything
		 * is raised; when they were not, nothing is moved and `refused` is true.
		 */
		readonly idleMs?: number
	}): Promise<MonitorState & { readonly raised?: boolean; readonly refused?: boolean }>
	/**
	 * The burst is over. With `restore`, the window that was in front is put
	 * back only if this burst raised a window and that window (or one of its
	 * program) is still in front; a burst that raised nothing restores no
	 * window, so a click that opened another window is not undone. The cursor
	 * is put back only when no person touched input meanwhile.
	 */
	end(args: {
		readonly restore: boolean
		readonly keepCursor?: boolean
	}): Promise<MonitorBurstEnd>
	/** Deletes the lease file when its token still matches. */
	release(args: {
		readonly leasePath: string
		readonly token: string
	}): Promise<void>
	dispose(): Promise<void>
}

/**
 * Why a burst did not run. Nothing was sent to the target in any of these, so
 * a retry is safe once the cause is gone.
 */
export type ForegroundBlockCode =
	| 'user_active'
	| 'lease_busy'
	| 'declined'
	| 'stopped'
	| 'monitor_unavailable'
	| 'locked_desktop'
	| 'secure_desktop'
	| 'uac_prompt'
	| 'elevated_target'

export interface ForegroundBlock {
	readonly code: ForegroundBlockCode
	/** In words the model can act on: what is blocking, and what to do next. */
	readonly detail: string
}

export type ForegroundOutcome<T> =
	| {
			readonly kind: 'ran'
			readonly value: T
			/** A person used keyboard or mouse during the burst: the result is not proof either way. */
			readonly interfered: boolean
			/** Escape was pressed during the burst: the turn is stopped. */
			readonly stopped: boolean
			readonly restoredForeground: boolean
			readonly restoredCursor: boolean
			readonly restoreNote?: string
			/** How long the screen was in use, from lease to release. */
			readonly heldMs: number
	  }
	| { readonly kind: 'blocked'; readonly block: ForegroundBlock }

/** What the user answers when the screen is needed while they are using it. */
export type ForegroundAnswer = 'allow' | 'deny' | 'unavailable'

/**
 * Asks the person, once, whether an application may use the screen for a
 * moment. `unavailable` means nobody can answer (a run with no one watching):
 * the ladder then waits and retries within its bound instead.
 */
export type ForegroundApprover = (
	subject: ForegroundSubject,
	signal?: AbortSignal,
) => Promise<ForegroundAnswer>

/** What a burst function receives. */
export interface BurstContext {
	/** Throws {@link BurstInterrupted} when a person has touched input since the burst began. */
	checkpoint(): Promise<void>
}

/** Thrown by {@link BurstContext.checkpoint}: the next step was not sent. */
export class BurstInterrupted extends Error {
	constructor() {
		super('a person used the keyboard or mouse during the burst')
		this.name = 'BurstInterrupted'
	}
}

/** The processes the ladder will not drive in the foreground. */
export const PROTECTED_PROCESSES: ReadonlyMap<string, 'locked_desktop' | 'uac_prompt'> = new Map<
	string,
	'locked_desktop' | 'uac_prompt'
>([
	['lockapp.exe', 'locked_desktop'],
	['logonui.exe', 'locked_desktop'],
	['winlogon.exe', 'locked_desktop'],
	['consent.exe', 'uac_prompt'],
])
