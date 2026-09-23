/**
 * The host side of the `schedule` and `session_loop` tools.
 *
 * The SDK holds the tool's contract with the model — its schema, its refusals
 * and its confirmation rule — and nothing about where jobs are stored or how
 * a confirmation is drawn. The host supplies both, and it computes every
 * field a person is asked to confirm: the model's own words are never what
 * the confirmation shows as fact.
 */

/** A rule effect, in the vocabulary of the CLI's `[permissions]` table. */
export type ScheduleRuleEffect = 'allow' | 'ask' | 'deny'

/** What the model proposes. Validated by the tool's schema, then by the host. */
export interface ScheduleJobDraft {
	readonly name: string
	readonly prompt: string
	/** Schedule words: `every 30m`, `0 9 * * 1-5`, `at 09:00`, `in 2h`. */
	readonly when: string
	/** Folder the job runs in. Absent: the session's working directory. */
	readonly folder?: string
	/** IANA zone for a cron expression or a local time. Absent: the host's. */
	readonly tz?: string
	readonly permissions: {
		readonly preset?: 'read-only' | 'edit-in-folder'
		/**
		 * What happens to a call no rule covers. The model may choose `park`
		 * (wait for the operator) or `deny`; running uncovered calls without
		 * asking is an operator decision the tool cannot propose.
		 */
		readonly unmatched: 'park' | 'deny'
		readonly execution?: 'host' | 'sandbox'
		readonly rules?: Readonly<
			Record<string, ScheduleRuleEffect | Readonly<Record<string, ScheduleRuleEffect>>>
		>
		/**
		 * Browser access for the run. Absent: the `browser` and `browser_act`
		 * tools are denied. Present: only the listed sites are reachable, at
		 * the listed level, and every other site is denied — there is no
		 * catch-all key. The tool refuses this block unless the host sets
		 * {@link ScheduleToolHost.browserGrants}.
		 */
		readonly browser?: ScheduleBrowserGrant
	}
	readonly budget?: {
		readonly maxIterations?: number
		readonly tokenBudget?: number
		readonly timeoutMs?: number
	}
}

/**
 * How far a scheduled run may go on one site. `read`: open and read pages,
 * never change them. `ask`: open and change pages, each change parked for the
 * operator. `act`: open and change pages without asking.
 */
export type ScheduleBrowserSiteLevel = 'read' | 'ask' | 'act'

/** A scheduled job's browser grant. */
export interface ScheduleBrowserGrant {
	/** The browser profile the run uses; the operator's, signed in beforehand. */
	readonly profile: string
	/**
	 * Canonical site key (`https://github.com`, `https://*.example.com`,
	 * `http://localhost:*`) to level. The tool canonicalises the keys the
	 * model wrote (see `canonicalizeBrowserSitePattern`) before the host sees
	 * them. Unlisted sites are denied.
	 */
	readonly sites: Readonly<Record<string, ScheduleBrowserSiteLevel>>
	/** Show the browser window during the run. Default: no window. */
	readonly headed?: boolean
}

/** What the person confirming is shown. Every field is the host's own computation. */
export interface ScheduleJobPreview {
	readonly name: string
	/** The canonical folder the job would run in. */
	readonly folder: string
	/** True when `folder` is outside the session's working directory and added directories. */
	readonly outsideSessionRoots: boolean
	readonly prompt: string
	/** The schedule in words, with its zone. */
	readonly schedule: string
	/** The next fire times, ISO-8601 UTC. */
	readonly nextFireTimes: readonly string[]
	/** The permission set expanded to one line per rule, config denies included. */
	readonly rules: readonly string[]
	readonly unmatched: 'park' | 'deny' | 'allow'
	readonly execution: 'host' | 'sandbox'
	/** A rule lets the run reach the network. */
	readonly networkAccess: boolean
	readonly budget: {
		readonly maxIterations: number
		readonly tokenBudget: number
		readonly timeoutMs: number
	}
	/** Runs per day at most, times the token budget. Absent for a one-shot. */
	readonly dailyTokenCeiling?: number
	/** Provider and model the job is pinned to. */
	readonly model: string
	/** Where the run's credential comes from, in words. */
	readonly credentialSource?: string
	/** Anything the host wants said in the warning colour. */
	readonly warnings: readonly string[]
}

/** A job as the `list` action reports it. */
export interface ScheduleJobSummary {
	readonly name: string
	readonly folder: string
	readonly state: string
	readonly schedule: string
	readonly nextFireAt?: string
	readonly lastStatus?: string
	/** Present only for jobs in the session's own folder. */
	readonly prompt?: string
}

/** What the person answered to a proposed job. */
export type ScheduleConfirmAnswer = 'create' | 'create-paused' | 'cancel'

export interface ScheduleConfirmRequest {
	readonly preview: ScheduleJobPreview
	/** The prompt tripwire's findings over `preview.prompt`. */
	readonly promptFindings: readonly string[]
	/** Always `model` from this tool: the banner says it was not the operator. */
	readonly proposedBy: 'model'
}

export interface ScheduleToolHost {
	/**
	 * The host can store and enforce {@link ScheduleJobDraft.permissions}
	 * `.browser`. Absent or false: the tool refuses a draft carrying one,
	 * rather than let the host drop it and confirm a job the model believes
	 * can use the browser.
	 */
	readonly browserGrants?: boolean
	/** Validate the draft and compute what the person will be shown. Throws with a message on a refusal. */
	preview(draft: ScheduleJobDraft): Promise<ScheduleJobPreview>
	/**
	 * Ask the person. Anything but `create` or `create-paused` — `cancel`, a
	 * thrown error, a closed screen — means no job.
	 */
	confirm(request: ScheduleConfirmRequest): Promise<ScheduleConfirmAnswer>
	/** Create the job the person confirmed. */
	create(
		draft: ScheduleJobDraft,
		preview: ScheduleJobPreview,
		options: { readonly paused: boolean },
	): Promise<{ readonly name: string }>
	/** Jobs, the session folder's in full, other folders' without their prompts. */
	list(options: { readonly allFolders: boolean }): Promise<readonly ScheduleJobSummary[]>
	/** A job by name or id prefix, or undefined. */
	find(job: string): Promise<ScheduleJobSummary | undefined>
	/** Ask the person to confirm resuming or deleting a job. */
	confirmAction(job: ScheduleJobSummary, action: 'resume' | 'delete'): Promise<boolean>
	pause(job: string): Promise<void>
	resume(job: string): Promise<void>
	delete(job: string): Promise<void>
}

/** A prompt the session re-sends to itself on an interval. */
export interface SessionLoop {
	readonly id: string
	/** The interval in words. */
	readonly schedule: string
	readonly prompt: string
	readonly createdAt: string
	readonly expiresAt?: string
	readonly lastFiredAt?: string
	readonly createdBy: 'operator' | 'model'
}

export interface SessionLoopHost {
	/** Throws with a message when the interval is not usable or the loop limit is reached. */
	create(request: {
		readonly interval: string
		readonly prompt: string
		readonly createdBy: 'model'
	}): Promise<SessionLoop>
	list(): readonly SessionLoop[]
	/** Stop one loop by id, or every loop with `all`. Returns how many stopped. */
	delete(id: string): Promise<number>
}
