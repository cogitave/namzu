import type {
	PalComputerBlock,
	PalComputerSetupOutcome,
	PalComputerSetupState,
	PalComputerSetupStep,
} from '../shared/pal-computer-setup.js'
import { PAL_COMPUTER_SETUP_UNAVAILABLE } from '../shared/pal-computer-setup.js'
import { type ConsentRecord, canAutoContinue, consentFor } from './pal-computer-consent.js'
import type { ComputerLine, ComputerPlan, ComputerResult } from './pal-computer-lines.js'

/** Runs `namzu computer <args>` and hands over each JSON line as it arrives. */
export interface ComputerCli {
	run(
		args: string[],
		onLine: (line: ComputerLine) => void,
		options?: { timeoutMs?: number },
	): Promise<{ exitCode: number | null }>
}

export interface PalComputerSetupDeps {
	enabled: boolean
	cli: ComputerCli
	consent: {
		read(): ConsentRecord | undefined
		write(record: ConsentRecord): void
		clear(): void
	}
	/** The command Windows runs once at the next sign-in to go on with setup. */
	resumeCommand: string
	now: () => number
	/** Every state change, for the windows that show it. */
	publish: (state: PalComputerSetupState) => void
	/** A check this recent is reused; the Pal panel and a finished run ask for a fresh one. */
	cacheMs?: number
}

const STEPS: Record<string, PalComputerSetupStep> = {
	'download-wsl': 'download',
	'enable-windows-features': 'turn-on-features',
	'install-wsl': 'install',
	restart: 'restart',
	'load-image': 'load-image',
}

const BLOCKS: Record<string, PalComputerBlock> = {
	unsupported: 'windows-version',
	'blocked-by-policy': 'organisation-policy',
	'virtualization-off': 'virtualization-off',
	'sdk-mismatch': 'update-needed',
	'image-unavailable': 'image-missing',
}

/** Plain words for each way a step can fail; the code itself is never shown. */
const FAILURES: Record<string, string> = {
	'download-failed': 'Linux support could not be downloaded. Check the internet connection.',
	'download-corrupt': 'The Linux support that was downloaded did not check out.',
	'elevation-failed': 'Windows did not let setup continue.',
	'feature-enable-failed': 'Windows could not turn on a feature that Linux support needs.',
	'wsl-install-failed': 'Windows could not install Linux support.',
	'image-corrupt': 'The Pal computer that came with Namzu is damaged. Reinstall Namzu.',
	'image-load-failed': 'The Pal computer could not be added.',
	'image-mismatch':
		'The Pal computer does not match this version of Namzu. Update or reinstall Namzu.',
	'engine-failed': 'Linux support did not start.',
}
const STOPPED_SENTENCE = 'Setup stopped before it finished.'

export function setupStepOf(kind: string): PalComputerSetupStep | undefined {
	return STEPS[kind]
}

/** What a status answer means for the row. */
export function classifyStatus(
	readiness: { state: string; unsupportedReason?: string },
	plan: ComputerPlan,
): Pick<PalComputerSetupState, 'available' | 'phase' | 'plan' | 'blocked'> {
	if (readiness.state === 'unsupported' && readiness.unsupportedReason === 'platform')
		return { available: false, phase: 'unknown' }
	if (readiness.state === 'ready') return { available: true, phase: 'ready' }
	if (readiness.state === 'unsupported' && readiness.unsupportedReason === 'architecture')
		return { available: true, phase: 'blocked', blocked: { reason: 'processor' } }
	if (plan.blocked) {
		const reason = BLOCKS[plan.blocked]
		return reason
			? { available: true, phase: 'blocked', blocked: { reason } }
			: { available: true, phase: 'unknown' }
	}
	const steps = plan.steps.map((step) => STEPS[step.kind])
	if (steps.length === 0 || steps.some((step) => step === undefined))
		return { available: true, phase: 'unknown' }
	const view = {
		id: plan.id,
		steps: steps as PalComputerSetupStep[],
		downloadBytes: plan.steps.reduce((sum, step) => sum + (step.downloadBytes ?? 0), 0),
		seconds: plan.steps.reduce((sum, step) => sum + step.estimatedSeconds, 0),
		elevationPrompts: (plan.steps.some((step) => step.elevated) ? 1 : 0) as 0 | 1,
		mayRestart: plan.steps.some((step) => step.mayRequireRestart),
	}
	if (readiness.state === 'restart-pending' || steps[0] === 'restart')
		return { available: true, phase: 'restart-pending', plan: view }
	return {
		available: true,
		phase: steps.every((step) => step === 'load-image') ? 'image-only' : 'needs-setup',
		plan: view,
	}
}

export class PalComputerSetupService {
	private state: PalComputerSetupState
	private plan: ComputerPlan | undefined
	private checkedAt: number | undefined
	private refreshing: Promise<void> | undefined
	private running = false
	private seq = 0

	constructor(private readonly deps: PalComputerSetupDeps) {
		this.state = deps.enabled
			? { available: true, phase: 'checking' }
			: PAL_COMPUTER_SETUP_UNAVAILABLE
	}

	/** The current view; `fresh` forces a new check unless a run is in flight. */
	async view(fresh = false): Promise<PalComputerSetupState> {
		if (!this.deps.enabled || this.running) return this.state
		const recent =
			this.checkedAt !== undefined && this.deps.now() - this.checkedAt < (this.deps.cacheMs ?? 5000)
		if (fresh || !recent) await this.refresh()
		return this.state
	}

	current(): PalComputerSetupState {
		return this.state
	}

	private set(next: PalComputerSetupState): void {
		this.state = next
		this.deps.publish(next)
	}

	private refresh(): Promise<void> {
		this.refreshing ??= this.check().finally(() => {
			this.refreshing = undefined
		})
		return this.refreshing
	}

	private async check(): Promise<void> {
		let status: Extract<ComputerLine, { kind: 'status' }> | undefined
		try {
			await this.deps.cli.run(['computer', 'status', '--json'], (line) => {
				if (line.kind === 'status') status = line
			})
		} catch {
			// The check could not run at all; the row keeps its ordinary behaviour.
		}
		this.checkedAt = this.deps.now()
		if (this.running) return
		if (!status) {
			this.plan = undefined
			this.set({ available: true, phase: 'unknown', ...this.carried() })
			return
		}
		this.plan = status.plan
		const classified = classifyStatus(status.readiness, status.plan)
		if (classified.phase === 'ready') this.deps.consent.clear()
		this.set({
			...classified,
			...(classified.phase === 'ready' ? {} : this.carried()),
			...(this.state.completed ? { completed: this.state.completed } : {}),
		})
	}

	/** What outlasts a new check: how the last run ended, and for which Pal. */
	private carried(): Pick<PalComputerSetupState, 'outcome' | 'palId' | 'completed'> {
		return {
			...(this.state.outcome ? { outcome: this.state.outcome } : {}),
			...(this.state.palId ? { palId: this.state.palId } : {}),
			...(this.state.completed ? { completed: this.state.completed } : {}),
		}
	}

	/**
	 * Run the plan the person agreed to. The id must be the one main computed in its latest check:
	 * an id from anywhere else is never passed on, and the plan is checked again.
	 */
	async run(planId: unknown, palId?: string): Promise<PalComputerSetupState> {
		if (!this.deps.enabled) throw new Error('Pal computers are set up differently on this PC.')
		if (this.running) throw new Error('Setup is already running.')
		const plan = this.plan
		if (typeof planId !== 'string' || !plan || plan.id !== planId) {
			await this.refresh()
			throw new Error('This PC changed since the plan was shown. Check it again.')
		}
		if (plan.blocked || plan.steps.length === 0 || plan.steps[0]?.kind === 'restart')
			throw new Error('Setup cannot run on this PC right now.')
		return this.start(plan, palId, false)
	}

	/**
	 * After a restart: go on without asking again, but only with what the person already agreed to.
	 * Anything else falls back to the row's ordinary states.
	 */
	async continueAfterRestart(): Promise<void> {
		if (!this.deps.enabled || this.running) return
		await this.refresh()
		const record = this.deps.consent.read()
		const plan = this.plan
		if (
			plan &&
			(this.state.phase === 'image-only' || this.state.phase === 'needs-setup') &&
			canAutoContinue(record, plan, this.deps.now())
		)
			await this.start(plan, record?.palId, true)
	}

	private async start(
		plan: ComputerPlan,
		palId: string | undefined,
		continuing: boolean,
	): Promise<PalComputerSetupState> {
		this.running = true
		const ranSetup = plan.steps.some((step) => step.kind !== 'load-image')
		if (!continuing) this.deps.consent.write(consentFor(plan, new Date(this.deps.now()), palId))
		const { outcome: _past, completed, ...rest } = this.state
		this.set({
			...rest,
			...(completed ? { completed } : {}),
			...(palId ? { palId } : {}),
			running: { step: 'checking', ...(continuing ? { continuing: true } : {}) },
		})
		let result: ComputerResult | undefined
		try {
			await this.deps.cli.run(
				[
					'computer',
					'setup',
					'--json',
					'--plan',
					plan.id,
					'--resume-command',
					this.deps.resumeCommand,
				],
				(line) => {
					if (line.kind === 'result') result = line.result
					else if (line.kind === 'progress') this.progress(line.progress, continuing)
				},
			)
		} catch {
			result = undefined
		}
		this.running = false
		const { running: _done, ...settled } = this.state
		this.state = settled
		await this.finish(result, ranSetup, palId)
		return this.state
	}

	private progress(
		progress: Extract<ComputerLine, { kind: 'progress' }>['progress'],
		continuing: boolean,
	): void {
		const step = STEPS[progress.step]
		if (!step || progress.phase === 'finished') return
		const running =
			progress.phase === 'progress' && progress.unit === 'bytes'
				? {
						step,
						done: progress.done,
						...(progress.total !== undefined ? { total: progress.total } : {}),
					}
				: { step }
		this.set({ ...this.state, running: { ...running, ...(continuing ? { continuing } : {}) } })
	}

	private async finish(
		result: ComputerResult | undefined,
		ranSetup: boolean,
		palId: string | undefined,
	): Promise<void> {
		const outcome = (): PalComputerSetupOutcome | undefined => {
			switch (result?.outcome) {
				case 'restart-required':
					return { kind: 'restart-required' }
				case 'cancelled':
					return { kind: 'cancelled' }
				case 'needs-administrator':
					return { kind: 'needs-administrator' }
				case 'failed':
					return {
						kind: 'failed',
						sentence: FAILURES[result.code] ?? STOPPED_SENTENCE,
						...(result.detail ? { details: result.detail } : {}),
					}
				case undefined:
					return { kind: 'failed', sentence: STOPPED_SENTENCE }
				default:
					return undefined
			}
		}
		if (result?.outcome === 'ready') {
			this.complete(ranSetup, palId)
			return
		}
		if (result?.outcome === 'plan-changed' || result?.outcome === 'blocked') {
			// The PC is not what the plan was made for. It may simply be ready by now (for example
			// the Pal computer was already added), so look again before saying anything.
			const { outcome: _past, ...rest } = this.state
			this.state = rest
			await this.refresh()
			if (this.state.phase === 'ready') {
				this.complete(ranSetup, palId)
				return
			}
			// A blocked PC has its own sentence; anything else must not fall back to silence.
			if (this.state.phase !== 'blocked') {
				this.deps.consent.clear()
				this.set({ ...this.state, outcome: { kind: 'failed', sentence: STOPPED_SENTENCE } })
			}
			return
		}
		const ended = outcome()
		if (result?.outcome === 'restart-required') {
			// The restart is the next thing the person does; there is no plan to offer meanwhile.
			const { plan: _plan, ...rest } = this.state
			this.set({ ...rest, phase: 'restart-pending', outcome: { kind: 'restart-required' } })
			return
		}
		// A run that ended without finishing leaves no consent behind; only a restart goes on by itself.
		this.deps.consent.clear()
		const { outcome: _past, ...rest } = this.state
		this.state = { ...rest, ...(ended ? { outcome: ended } : {}) }
		await this.refresh()
	}

	private complete(ranSetup: boolean, palId: string | undefined): void {
		this.deps.consent.clear()
		this.seq += 1
		const { outcome: _past, ...rest } = this.state
		this.checkedAt = this.deps.now()
		this.set({
			...rest,
			available: true,
			phase: 'ready',
			completed: { seq: this.seq, ...(palId ? { palId } : {}), ranSetup },
		})
	}

	async stopIdle(timeoutMs?: number): Promise<'stopped' | 'busy' | 'not-running' | 'failed'> {
		if (!this.deps.enabled) return 'not-running'
		let outcome: 'stopped' | 'busy' | 'not-running' | 'failed' = 'failed'
		try {
			await this.deps.cli.run(
				['computer', 'stop-idle', '--json'],
				(line) => {
					if (line.kind === 'stop-idle') outcome = line.outcome
				},
				timeoutMs === undefined ? undefined : { timeoutMs },
			)
		} catch {
			outcome = 'failed'
		}
		return outcome
	}

	/** A setup is running: the Linux machine is in use even though no Pal computer is. */
	isRunning(): boolean {
		return this.running
	}

	/** Whether "Restart now" may do anything: only while a restart is what setup waits for. */
	restartIsDue(): boolean {
		return this.state.phase === 'restart-pending'
	}
}
