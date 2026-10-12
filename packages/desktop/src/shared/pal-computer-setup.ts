/**
 * What the Pal computer row needs to know about this PC, in the words of the screen rather than of
 * the engine: nothing here is a code, a path or raw output. Main computes it from the CLI's
 * `computer status --json`; the renderer only draws it.
 */

/** One piece of setup, in the order it runs. */
export type PalComputerSetupStep =
	| 'download'
	| 'turn-on-features'
	| 'install'
	| 'restart'
	| 'load-image'

/** Why Namzu cannot set this PC up by itself. */
export type PalComputerBlock =
	| 'virtualization-off'
	| 'organisation-policy'
	| 'windows-version'
	| 'processor'
	| 'update-needed'
	| 'image-missing'

/** What the person is asked to agree to: the plan main computed, in numbers. */
export interface PalComputerSetupPlanView {
	/** Identifies the plan the numbers belong to; main refuses any other. */
	id: string
	steps: PalComputerSetupStep[]
	downloadBytes: number
	seconds: number
	/** Windows' own permission prompts: at most one per plan. */
	elevationPrompts: 0 | 1
	mayRestart: boolean
}

/** The one thing a run is doing right now. */
export interface PalComputerSetupRunning {
	step: PalComputerSetupStep | 'checking'
	/** Bytes downloaded so far, when the step reports them. */
	done?: number
	total?: number
	/** The run resumed by itself after a restart. */
	continuing?: boolean
}

export type PalComputerSetupOutcome =
	| { kind: 'restart-required' }
	| { kind: 'cancelled' }
	| { kind: 'needs-administrator' }
	| { kind: 'failed'; sentence: string; details?: string }

export interface PalComputerSetupState {
	/** False off Windows (or with another engine): the row then behaves as before. */
	available: boolean
	/**
	 * - `checking`: no answer yet.
	 * - `ready`: nothing to set up.
	 * - `image-only`: only the bundled Pal computer has to be added; pressing Start is the consent.
	 * - `needs-setup`: something is downloaded or needs Windows' permission.
	 * - `restart-pending`: a restart is needed before setup can go on.
	 * - `blocked`: Namzu cannot fix this PC.
	 * - `unknown`: the check itself failed; the row keeps its ordinary behaviour.
	 */
	phase:
		| 'checking'
		| 'ready'
		| 'image-only'
		| 'needs-setup'
		| 'restart-pending'
		| 'blocked'
		| 'unknown'
	plan?: PalComputerSetupPlanView
	blocked?: { reason: PalComputerBlock; details?: string }
	running?: PalComputerSetupRunning
	/** How the last run ended, until the next run or a ready check. */
	outcome?: PalComputerSetupOutcome
	/** The Pal whose Start began the run in flight or the last run. */
	palId?: string
	/**
	 * Counts finished runs that ended ready, so a window that sees a new number knows the run it
	 * waited for is over. `ranSetup` is false when only the bundled image was added.
	 */
	completed?: { seq: number; palId?: string; ranSetup: boolean }
}

export const PAL_COMPUTER_SETUP_UNAVAILABLE: PalComputerSetupState = {
	available: false,
	phase: 'unknown',
}
