/**
 * The plain words `namzu computer` prints. Nothing here is a code, a path or
 * raw engine output; sizes and times are humanised.
 */
import type {
	WslcReadiness,
	WslcSetupBlock,
	WslcSetupFailureCode,
	WslcSetupPlan,
	WslcSetupProgress,
	WslcSetupResult,
	WslcSetupStepKind,
} from '@namzu/sandbox/local-virtual-computer/setup'

export const RESTART_SENTENCE = 'Restart your PC to finish setting up Pal computers.'

export const NO_MACHINE_SENTENCE =
	'There is no Linux machine for Pal computers to stop on this system.'

export const NOT_WINDOWS_SENTENCE =
	'Pal computers on this system use Docker or Podman. Setup is automatic only on Windows.'

/** "350 MB", "1.2 GB": rounded to what a person reads, binary units. */
export function humanBytes(bytes: number): string {
	const mb = bytes / (1024 * 1024)
	if (mb < 1) return 'less than 1 MB'
	if (mb < 1000) {
		// Past 100 MB a unit digit is noise; round to the nearest 10.
		return `${mb >= 100 ? Math.round(mb / 10) * 10 : Math.round(mb)} MB`
	}
	const gb = mb / 1024
	return `${(Math.round(gb * 10) / 10).toString()} GB`
}

/** "about 1 minute", "about 5 minutes"; never seconds. */
export function humanDuration(seconds: number): string {
	const minutes = Math.max(1, Math.round(seconds / 60))
	return `about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`
}

export function downloadBytesOf(plan: WslcSetupPlan): number {
	return plan.steps.reduce((sum, step) => sum + (step.downloadBytes ?? 0), 0)
}

function sizeClause(plan: WslcSetupPlan): string {
	const bytes = downloadBytesOf(plan)
	return bytes > 0 ? ` (about ${humanBytes(bytes)})` : ''
}

function permissionClause(plan: WslcSetupPlan): string {
	if (plan.elevationPrompts <= 0) return 'Windows will not ask for permission.'
	if (plan.elevationPrompts === 1) return 'Windows will ask your permission once.'
	return `Windows will ask your permission ${plan.elevationPrompts} times.`
}

function blockedSentence(block: WslcSetupBlock): string {
	switch (block) {
		case 'unsupported':
			return 'This version of Windows cannot run a Pal computer.'
		case 'blocked-by-policy':
			return 'Your organisation does not allow the Linux support Pal computers need on this PC. Ask your IT team to allow it.'
		case 'virtualization-off':
			return "This PC has virtualization switched off. Turn on Intel VT-x or AMD-V in the PC's startup settings, then run namzu computer status again."
		case 'sdk-mismatch':
			return "Namzu needs an update to work with this version of Windows' Linux support."
		case 'image-unavailable':
			return 'The Pal computer that should come with Namzu is missing from this copy. Reinstall Namzu to get it.'
	}
}

/** Why a plan has nothing Namzu can do. */
export function blockSentence(block: WslcSetupBlock): string {
	return blockedSentence(block)
}

/** One sentence for what `namzu computer status` found. */
export function readinessSentence(readiness: WslcReadiness, plan: WslcSetupPlan): string {
	switch (readiness.state) {
		case 'ready':
			return 'This PC is ready for Pal computers.'
		case 'unsupported':
			if (readiness.unsupportedReason === 'platform') return NOT_WINDOWS_SENTENCE
			if (readiness.unsupportedReason === 'architecture')
				return "This PC's processor type is not supported for Pal computers yet."
			return 'This version of Windows cannot run a Pal computer.'
		case 'blocked-by-policy':
			return blockedSentence('blocked-by-policy')
		case 'virtualization-off':
			return blockedSentence('virtualization-off')
		case 'sdk-mismatch':
			return blockedSentence('sdk-mismatch')
		case 'restart-pending':
			return 'Restart your PC to finish setting up Pal computers, then run namzu computer status again.'
		case 'platform-off':
			return `Windows needs to turn on a feature for Linux support${sizeClause(plan)}. Run namzu computer setup.`
		case 'wsl-missing':
			return `Windows needs to add Linux support once${sizeClause(plan)}. Run namzu computer setup.`
		case 'wsl-outdated':
			return `Windows needs to update its Linux support${sizeClause(plan)}. Run namzu computer setup.`
		case 'image-missing':
			return plan.blocked === 'image-unavailable'
				? blockedSentence('image-unavailable')
				: `The Pal computer is not on this PC yet${sizeClause(plan)}. Run namzu computer setup.`
	}
}

const STEP_LABEL: Record<WslcSetupStepKind, string> = {
	'download-wsl': 'Downloading Linux support',
	'enable-windows-features': 'Turning on Windows features for Linux support',
	'install-wsl': 'Installing Linux support',
	restart: 'Waiting for a restart',
	'load-image': 'Adding the Pal computer',
}

export function stepLabel(step: WslcSetupStepKind): string {
	return STEP_LABEL[step]
}

const STEP_CLAUSE: Record<WslcSetupStepKind, string> = {
	'download-wsl': 'download Linux support',
	'enable-windows-features': 'turn on the Windows features it needs',
	'install-wsl': 'install Linux support',
	restart: 'ask for a restart',
	'load-image': 'add the Pal computer',
}

function joinClauses(parts: readonly string[]): string {
	if (parts.length <= 1) return parts.join('')
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** What setup will do, what it costs, and what Windows will ask. */
export function planSentence(plan: WslcSetupPlan): string {
	if (plan.blocked) return blockedSentence(plan.blocked)
	// Whatever follows the restart waits for it; the restart is the one ask.
	if (plan.state === 'restart-pending') return RESTART_SENTENCE
	const doing = plan.steps.filter((s) => s.kind !== 'restart').map((s) => STEP_CLAUSE[s.kind])
	if (doing.length === 0) return 'Nothing needs to be set up.'
	const seconds = plan.steps.reduce((sum, s) => sum + s.estimatedSeconds, 0)
	const bytes = downloadBytesOf(plan)
	const parts = [
		`To set up Pal computers, Namzu will ${joinClauses(doing)}.`,
		bytes > 0 ? `It downloads about ${humanBytes(bytes)}.` : '',
		`This takes ${humanDuration(seconds)}.`,
		permissionClause(plan),
		plan.mayRequireRestart ? 'Your PC may need to restart afterwards.' : '',
	]
	return parts.filter(Boolean).join(' ')
}

/** One progress line per step, printed when the step starts. */
export function progressLine(progress: WslcSetupProgress): string | undefined {
	if (progress.phase === 'started') return `${STEP_LABEL[progress.step]}...`
	if (progress.phase === 'finished' && progress.result === 'restart-required')
		return 'Windows needs a restart to finish this step.'
	return undefined
}

const FAILURE_SENTENCE: Record<WslcSetupFailureCode, string> = {
	'download-failed': 'Could not download Linux support. Check the internet connection.',
	'download-corrupt': 'The downloaded Linux support did not check out. Try again.',
	'elevation-failed': 'Windows did not let setup continue.',
	'feature-enable-failed': 'Windows could not turn on a feature that Linux support needs.',
	'wsl-install-failed': 'Windows could not install Linux support.',
	'image-corrupt': 'The Pal computer that came with Namzu is damaged. Reinstall Namzu.',
	'image-load-failed': 'Could not add the Pal computer.',
	'image-mismatch':
		'The Pal computer does not match this version of Namzu. Update or reinstall Namzu.',
	'engine-failed': 'Linux support did not start.',
}

/** A sentence per failure code, for the Details line: never the code itself. */
const FAILURE_DETAIL: Record<WslcSetupFailureCode, string> = {
	'download-failed': 'The download of Linux support did not finish.',
	'download-corrupt': 'The downloaded file is not the one Namzu expects.',
	'elevation-failed': 'Windows did not start the step that needs your permission.',
	'feature-enable-failed': 'Windows reported a problem while turning on a feature.',
	'wsl-install-failed': 'Windows reported a problem while installing Linux support.',
	'image-corrupt': 'The Pal computer file is missing or damaged.',
	'image-load-failed': 'Windows could not load the Pal computer file.',
	'image-mismatch': 'The Pal computer that loaded is not the one this version of Namzu expects.',
	'engine-failed': 'Linux support was set up but did not answer afterwards.',
}

export interface ResultText {
	readonly sentence: string
	/** For a Details line; absent when there is nothing more to say. */
	readonly details?: string
}

export function resultSentence(result: WslcSetupResult): ResultText {
	switch (result.outcome) {
		case 'ready':
			return { sentence: 'The Pal computer is ready.' }
		case 'restart-required':
			return {
				sentence: 'Restart your PC to finish setup, then run namzu computer setup again.',
			}
		case 'cancelled':
			return { sentence: 'Setup stopped because the Windows permission prompt was declined.' }
		case 'needs-administrator':
			return { sentence: 'Setup needs an administrator. Ask one to approve, or try again.' }
		case 'plan-changed':
			return {
				sentence: 'This PC changed since the plan was shown. Run namzu computer setup again.',
			}
		case 'blocked':
			return { sentence: blockedSentence(result.blocked) }
		case 'failed':
			return {
				sentence: FAILURE_SENTENCE[result.code],
				details: `${FAILURE_DETAIL[result.code]}${
					result.exitCode === undefined ? '' : ` Windows error ${result.exitCode}.`
				}`,
			}
	}
}
