import type {
	PalComputerBlock,
	PalComputerSetupOutcome,
	PalComputerSetupPlanView,
	PalComputerSetupRunning,
	PalComputerSetupState,
} from '../shared/pal-computer-setup.js'
import type { PalStartCard, PalStartEntry, palWaitingLine } from './pal-start-model.js'

/** "351 MB", "1.2 GB": what a person reads, never a byte count. */
export function humanSize(bytes: number): string {
	const mb = bytes / (1024 * 1024)
	if (mb < 1) return 'less than 1 MB'
	if (mb < 1000) return `${Math.round(mb)} MB`
	return `${(Math.round((mb / 1024) * 10) / 10).toString()} GB`
}

/** "about 1 minute", "about 3 minutes"; never seconds. */
export function humanTime(seconds: number): string {
	const minutes = Math.max(1, Math.round(seconds / 60))
	return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

function join(parts: readonly string[]): string {
	return parts.length <= 1
		? parts.join('')
		: `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** The one sentence under the row before anything is installed: what, how much, how long, what Windows asks. */
export function consentSentence(plan: PalComputerSetupPlanView, palName: string): string {
	const doing: string[] = []
	if (plan.steps.includes('turn-on-features')) doing.push('turn on the Windows features it needs')
	if (plan.steps.includes('download') || plan.steps.includes('install'))
		doing.push('add Linux support to Windows')
	if (plan.steps.includes('load-image')) doing.push(`prepare ${palName}’s computer`)
	const cost = [
		plan.downloadBytes > 0 ? `${humanSize(plan.downloadBytes)} to download` : '',
		humanTime(plan.seconds),
	].filter(Boolean)
	const after = [
		plan.elevationPrompts > 0 ? 'Windows will ask your permission once' : '',
		plan.mayRestart ? 'your PC may need to restart (Namzu then continues by itself)' : '',
	].filter(Boolean)
	const head = `Namzu will ${join(doing)} (${cost.join(', ')})`
	if (after.length === 0) return `${head}; Windows will not ask for permission.`
	return `${head}; ${after.join(', and ')}.`
}

/** The label of the step in flight, one at a time. */
export function progressLabel(
	running: PalComputerSetupRunning,
	palName: string,
	plan: PalComputerSetupPlanView | undefined,
): string {
	switch (running.step) {
		case 'checking':
			if (running.continuing) return 'Continuing setup…'
			return plan?.steps.every((step) => step === 'load-image')
				? `Preparing ${palName}’s computer…`
				: 'Checking this PC…'
		case 'download':
			return running.total !== undefined && running.done !== undefined
				? `Downloading Linux support · ${humanSize(running.done)} of ${humanSize(running.total)}`
				: 'Downloading Linux support…'
		case 'turn-on-features':
			return 'Turning on Windows features…'
		case 'install':
			return 'Installing Linux support…'
		case 'restart':
			return 'Waiting for a restart…'
		case 'load-image':
			return `Preparing ${palName}’s computer…`
	}
}

const BLOCK_SENTENCE: Record<PalComputerBlock, (palName: string) => string> = {
	'virtualization-off': (name) =>
		`${name}’s computer needs virtualization, and it is switched off on this PC. Turn it on in the PC’s startup settings, then come back.`,
	'organisation-policy': (name) =>
		`Your organisation does not allow what ${name}’s computer needs on this PC. Ask your IT team to allow it.`,
	'windows-version': (name) => `This version of Windows cannot run ${name}’s computer.`,
	processor: (name) => `This PC’s processor type cannot run ${name}’s computer yet.`,
	'update-needed': () => 'Namzu needs an update to work with this version of Windows.',
	'image-missing': (name) =>
		`${name}’s computer should come with Namzu, but it is missing from this copy. Reinstall Namzu to get it.`,
}

/** The text of "How to set up" on Windows: what Namzu does and how to recover, collapsed by default. */
export function windowsHelp(
	palName: string,
	blocked: PalComputerBlock | undefined,
): { paragraphs: string[] } {
	const paragraphs = [
		`${palName}’s computer is a small Linux machine that Namzu runs on this PC. Namzu adds Linux support to Windows once, then prepares the computer from the copy that came with Namzu.`,
		'Windows asks for your permission once while Linux support is added. Some PCs need a restart afterwards; Namzu continues by itself when you sign in again.',
		'The machine shuts itself down after a while when no Pal is using it.',
	]
	if (blocked === 'virtualization-off')
		paragraphs.push(
			'To turn virtualization on, restart the PC into its startup settings (often by pressing F2, F10 or Delete while it starts). Look for Intel Virtualization Technology, VT-x, AMD-V or SVM Mode, turn it on, and save.',
		)
	if (blocked === 'organisation-policy')
		paragraphs.push(
			'A rule set by your organisation turns Linux support off on this PC. Only your IT team can change it.',
		)
	return { paragraphs }
}

export type PalComputerRowAction = 'start' | 'ask' | 'restart' | 'retry' | 'retry-start'

/** What the Pal computer row shows when this PC needs setup. Absent: the row keeps its ordinary states. */
export interface PalComputerRowView {
	/** The status text at rest; progress replaces it, one label at a time. */
	status: string
	/** The action the status turns into on hover and focus. */
	action?: { kind: PalComputerRowAction; label: string }
	/** Setup is in flight: a spinner, no action. */
	busy: boolean
	/** The consent sentence with its two actions, shown under the row. */
	consent?: { sentence: string }
	note?: string
	details?: string
	/** The Windows "How to set up" fold. */
	help?: { paragraphs: string[] }
}

export interface PalComputerRowInput {
	palName: string
	setup: PalComputerSetupState | undefined
	/** The person opened the consent sentence and has not answered. */
	consenting: boolean
	/** The Pal is paused: nothing starts. */
	paused?: boolean
	/** A Start that Desktop drove ended with the computer not running. */
	startFailure?: { details?: string }
}

export function palComputerRowView(input: PalComputerRowInput): PalComputerRowView | undefined {
	const { palName: name, setup, consenting } = input
	if (!setup?.available) return undefined
	const help = windowsHelp(name, setup.blocked?.reason)
	const failed = setup.outcome?.kind === 'failed' ? setup.outcome : undefined
	if (setup.running)
		return {
			status: progressLabel(setup.running, name, setup.plan),
			busy: true,
			help,
		}
	if (setup.phase === 'restart-pending' || setup.outcome?.kind === 'restart-required')
		return {
			status: 'Restart to finish setup',
			action: { kind: 'restart', label: 'Restart now' },
			busy: false,
			note: 'Namzu continues by itself after you sign in again.',
			help,
		}
	if (setup.phase === 'blocked' && setup.blocked)
		return {
			status: 'Offline',
			busy: false,
			note: BLOCK_SENTENCE[setup.blocked.reason](name),
			...(setup.blocked.details ? { details: setup.blocked.details } : {}),
			help,
		}
	if (setup.phase === 'ready' && input.startFailure)
		return {
			status: 'Offline',
			action: input.paused ? undefined : { kind: 'retry-start', label: 'Try again' },
			busy: false,
			note: `${name}’s computer could not start. Try again.`,
			...(input.startFailure.details ? { details: input.startFailure.details } : {}),
			help,
		}
	if (setup.phase === 'image-only')
		return {
			status: 'Offline',
			action: input.paused ? undefined : { kind: 'start', label: `Start ${name}` },
			busy: false,
			...(failed
				? { note: failed.sentence, ...(failed.details ? { details: failed.details } : {}) }
				: {}),
			help,
		}
	if (setup.phase === 'needs-setup' && setup.plan) {
		const retry = { kind: 'ask' as const, label: 'Try again' }
		const ask = { kind: 'ask' as const, label: `Set up and start ${name}` }
		if (consenting)
			return {
				status: 'Needs setup',
				busy: false,
				consent: { sentence: consentSentence(setup.plan, name) },
				help,
			}
		switch (setup.outcome?.kind) {
			case 'cancelled':
				return {
					status: 'Needs your permission',
					action: retry,
					busy: false,
					note: 'Setup needs your permission.',
					help,
				}
			case 'needs-administrator':
				return {
					status: 'Needs an administrator',
					action: retry,
					busy: false,
					note: 'Setup needs an administrator. Ask one to approve, or try again.',
					help,
				}
			case 'failed':
				return {
					status: 'Setup did not finish',
					action: retry,
					busy: false,
					note: setup.outcome.sentence,
					...(setup.outcome.details ? { details: setup.outcome.details } : {}),
					help,
				}
			default:
				return {
					status: 'Needs setup',
					action: input.paused ? undefined : ask,
					busy: false,
					help,
				}
		}
	}
	return undefined
}

type WaitingLine = ReturnType<typeof palWaitingLine>

/** The entry as the Windows setup sees it: Docker's help never applies there. */
export function withoutDockerHelp(
	entry: PalStartEntry | undefined,
	setup: PalComputerSetupState | undefined,
): PalStartEntry | undefined {
	if (!entry || !setup?.available || !entry.setupMissing) return entry
	const { setupMissing: _docker, ...rest } = entry
	return rest
}

/** The card under a "sent to a Pal" row, following the same states as the Pal computer row. */
export function setupStartCard(
	name: string,
	setup: PalComputerSetupState | undefined,
	base: PalStartCard,
): PalStartCard {
	if (!setup?.available || base.kind !== 'ask') return base
	if (setup.running)
		return { kind: 'starting', text: progressLabel(setup.running, name, setup.plan) }
	switch (setup.phase) {
		case 'needs-setup':
			// The row says "Set up and start"; a second Start here would name the same step twice.
			return {
				kind: 'pointer',
				text: `${name}’s computer needs a one-time setup before it can start. Use “Set up and start ${name}” on its computer row.`,
			}
		case 'restart-pending':
			return { kind: 'ask', text: `Restart your PC to finish setting up ${name}’s computer.` }
		case 'blocked':
			return setup.blocked
				? {
						kind: 'blocked',
						text: BLOCK_SENTENCE[setup.blocked.reason](name),
						help: windowsHelp(name, setup.blocked.reason).paragraphs.join('\n\n'),
						windows: true,
					}
				: base
		default:
			return base
	}
}

/** The waiting-messages line, following the same states. */
export function setupWaitingLine(
	name: string,
	setup: PalComputerSetupState | undefined,
	base: WaitingLine,
): WaitingLine {
	if (!setup?.available || !base || base.action !== 'start') return base
	if (setup.running) return { text: progressLabel(setup.running, name, setup.plan), action: null }
	if (setup.phase === 'restart-pending')
		return { text: `Restart your PC to finish setting up ${name}’s computer.`, action: null }
	// The Pal computer row carries the sentence and the fold; the messages just wait.
	if (setup.phase === 'blocked') return { text: base.text, action: null }
	return base
}

/**
 * The toast for a setup that failed or needs an administrator. The Pal computer row already
 * carries the same sentence, with Details and Try again, so a toast is only for the person who
 * cannot see that row.
 */
export function setupOutcomeToast(
	outcome: PalComputerSetupOutcome | undefined,
	rowVisible: boolean,
): { message: string; tone: 'error' | 'warning' } | undefined {
	if (rowVisible || !outcome) return undefined
	if (outcome.kind === 'failed') return { message: outcome.sentence, tone: 'error' }
	if (outcome.kind === 'needs-administrator')
		return {
			message: 'Setup needs an administrator. Ask one to approve, or try again.',
			tone: 'warning',
		}
	return undefined
}

/** The one toast for restart-required: a sentence only, the row keeps the "Restart now" action. */
export function restartRequiredToast(palName: string | undefined): string {
	return palName
		? `Restart your PC to finish setting up ${palName}’s computer.`
		: 'Restart your PC to finish setting up the Pal computer.'
}
