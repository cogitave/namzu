/**
 * The JSON lines `namzu computer ... --json` prints, one object per line, each with
 * `"version": 1`. Chunks arrive in arbitrary pieces; a line is only read once it is whole. Anything
 * that is not a known line (noise from a child, a newer field, a broken line) is skipped, never
 * thrown: the caller decides what a missing result means.
 */

export interface ComputerStep {
	kind: string
	elevated: boolean
	downloadBytes?: number
	estimatedSeconds: number
	mayRequireRestart: boolean
}

export interface ComputerPlan {
	id: string
	state: string
	steps: ComputerStep[]
	elevationPrompts: number
	mayRequireRestart: boolean
	blocked?: string
}

export interface ComputerReadiness {
	state: string
	unsupportedReason?: string
}

export type ComputerProgress =
	| { step: string; phase: 'started' }
	| { step: string; phase: 'progress'; done: number; total?: number; unit: 'bytes' | 'percent' }
	| { step: string; phase: 'finished'; result: 'ok' | 'restart-required' }

export type ComputerResult =
	| { outcome: 'ready' }
	| { outcome: 'restart-required' }
	| { outcome: 'cancelled' }
	| { outcome: 'needs-administrator' }
	| { outcome: 'plan-changed'; plan?: ComputerPlan }
	| { outcome: 'blocked'; blocked: string }
	| { outcome: 'failed'; step: string; code: string; detail?: string }

export type ComputerLine =
	| { kind: 'status'; readiness: ComputerReadiness; plan: ComputerPlan }
	| { kind: 'progress'; progress: ComputerProgress }
	| { kind: 'result'; result: ComputerResult }
	| { kind: 'stop-idle'; outcome: 'stopped' | 'busy' | 'not-running' }
	| { kind: 'error'; code: string }

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
const isNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value)

function readStep(value: unknown): ComputerStep | undefined {
	if (!isObject(value) || typeof value.kind !== 'string') return undefined
	return {
		kind: value.kind,
		elevated: value.elevated === true,
		...(isNumber(value.downloadBytes) ? { downloadBytes: value.downloadBytes } : {}),
		estimatedSeconds: isNumber(value.estimatedSeconds) ? value.estimatedSeconds : 0,
		mayRequireRestart: value.mayRequireRestart === true,
	}
}

function readPlan(value: unknown): ComputerPlan | undefined {
	if (!isObject(value) || typeof value.id !== 'string' || !Array.isArray(value.steps))
		return undefined
	const steps = value.steps.map(readStep)
	if (steps.some((step) => step === undefined)) return undefined
	return {
		id: value.id,
		state: typeof value.state === 'string' ? value.state : '',
		steps: steps as ComputerStep[],
		elevationPrompts: isNumber(value.elevationPrompts) ? value.elevationPrompts : 0,
		mayRequireRestart: value.mayRequireRestart === true,
		...(typeof value.blocked === 'string' ? { blocked: value.blocked } : {}),
	}
}

function readProgress(value: unknown): ComputerProgress | undefined {
	if (!isObject(value) || typeof value.step !== 'string') return undefined
	if (value.phase === 'started') return { step: value.step, phase: 'started' }
	if (value.phase === 'finished')
		return {
			step: value.step,
			phase: 'finished',
			result: value.result === 'restart-required' ? 'restart-required' : 'ok',
		}
	if (value.phase === 'progress' && isNumber(value.done))
		return {
			step: value.step,
			phase: 'progress',
			done: value.done,
			...(isNumber(value.total) ? { total: value.total } : {}),
			unit: value.unit === 'percent' ? 'percent' : 'bytes',
		}
	return undefined
}

function readResult(value: unknown): ComputerResult | undefined {
	if (!isObject(value)) return undefined
	switch (value.outcome) {
		case 'ready':
		case 'restart-required':
		case 'cancelled':
		case 'needs-administrator':
			return { outcome: value.outcome }
		case 'plan-changed': {
			const plan = readPlan(value.plan)
			return { outcome: 'plan-changed', ...(plan ? { plan } : {}) }
		}
		case 'blocked':
			return typeof value.blocked === 'string'
				? { outcome: 'blocked', blocked: value.blocked }
				: undefined
		case 'failed':
			return typeof value.step === 'string' && typeof value.code === 'string'
				? {
						outcome: 'failed',
						step: value.step,
						code: value.code,
						...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
					}
				: undefined
		default:
			return undefined
	}
}

/** One whole line to what it says, or undefined for anything this version does not know. */
export function parseComputerLine(text: string): ComputerLine | undefined {
	const trimmed = text.trim()
	if (!trimmed.startsWith('{')) return undefined
	let value: unknown
	try {
		value = JSON.parse(trimmed)
	} catch {
		return undefined
	}
	if (!isObject(value) || value.version !== 1) return undefined
	if (isObject(value.readiness)) {
		const plan = readPlan(value.plan)
		if (!plan || typeof value.readiness.state !== 'string') return undefined
		return {
			kind: 'status',
			readiness: {
				state: value.readiness.state,
				...(typeof value.readiness.unsupportedReason === 'string'
					? { unsupportedReason: value.readiness.unsupportedReason }
					: {}),
			},
			plan,
		}
	}
	if ('progress' in value) {
		const progress = readProgress(value.progress)
		return progress ? { kind: 'progress', progress } : undefined
	}
	if ('result' in value) {
		const result = readResult(value.result)
		return result ? { kind: 'result', result } : undefined
	}
	if (isObject(value.error) && typeof value.error.code === 'string')
		return { kind: 'error', code: value.error.code }
	if (value.outcome === 'stopped' || value.outcome === 'busy' || value.outcome === 'not-running')
		return { kind: 'stop-idle', outcome: value.outcome }
	return undefined
}

/** Feeds chunks of output and yields the lines that became whole. */
export class ComputerLineParser {
	private pending = ''

	push(chunk: string): ComputerLine[] {
		this.pending += chunk
		const lines: ComputerLine[] = []
		let newline = this.pending.indexOf('\n')
		while (newline !== -1) {
			const line = parseComputerLine(this.pending.slice(0, newline))
			if (line) lines.push(line)
			this.pending = this.pending.slice(newline + 1)
			newline = this.pending.indexOf('\n')
		}
		return lines
	}

	/** The last line of a stream that ended without a newline. */
	end(): ComputerLine[] {
		const rest = this.pending
		this.pending = ''
		const line = parseComputerLine(rest)
		return line ? [line] : []
	}
}
