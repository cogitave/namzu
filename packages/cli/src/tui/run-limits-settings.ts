import { type RunGuardKey, type RunGuards, resolveRunGuards } from '../config/run-limits.js'

export const RUN_LIMIT_FIELDS = [
	{
		name: 'tokens',
		key: 'tokenBudget',
		label: 'Token budget',
		hint: 'Whole tokens across the run and its children; 0 or unlimited removes the cap.',
	},
	{
		name: 'iterations',
		key: 'maxIterations',
		label: 'Model turns',
		hint: 'Whole model calls per run; 0 or unlimited removes the cap.',
	},
	{
		name: 'time',
		key: 'timeoutMs',
		label: 'Run duration',
		hint: 'Duration such as 30m, 2h or 1500ms; a bare number is milliseconds. 0 or unlimited removes the cap.',
	},
] as const

export type RunLimitsAction =
	| { kind: 'run-limits-picker' }
	| { kind: 'run-limit-editor'; key: RunGuardKey }
	| { kind: 'run-limits-set'; limits: Partial<RunGuards> }
	| { kind: 'message'; role: 'system'; content: string; statusRows?: undefined }

export function runLimitsAction(args: readonly string[]): RunLimitsAction {
	if (args.length === 0) return { kind: 'run-limits-picker' }
	if (args.length === 1 && args[0] === 'unlimited')
		return { kind: 'run-limits-set', limits: resolveRunGuards() }
	const field = RUN_LIMIT_FIELDS.find((field) => field.name === args[0])
	if (field && args.length === 1) return { kind: 'run-limit-editor', key: field.key }
	if (field && args.length === 2) {
		try {
			const raw = (args[1] ?? '').toLowerCase()
			const duration = field.key === 'timeoutMs' ? /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(raw) : null
			const value =
				raw === 'unlimited'
					? 0
					: duration
						? Number(duration[1]) *
							({ ms: 1, s: 1000, m: 60000, h: 3600000 }[duration[2] ?? 'ms'] ?? 1)
						: /^\d+$/.test(raw)
							? Number(raw)
							: Number.NaN
			resolveRunGuards({ [field.key]: value })
			return { kind: 'run-limits-set', limits: { [field.key]: value } }
		} catch (error) {
			return {
				kind: 'message',
				role: 'system',
				content: `${error instanceof Error ? error.message : String(error)} ${field.hint}`,
			}
		}
	}
	return {
		kind: 'message',
		role: 'system',
		content:
			'Usage: /config limits [tokens|iterations|time] [value]; /config limits unlimited removes all three caps.',
	}
}

export function formatRunLimit(key: RunGuardKey, value: number): string {
	if (value === 0) return 'Unlimited'
	if (key === 'timeoutMs') {
		for (const [unit, divisor] of [
			['h', 3600000],
			['m', 60000],
			['s', 1000],
		] as const)
			if (value % divisor === 0) return `${value / divisor}${unit}`
		return `${value}ms`
	}
	return value.toLocaleString('en-US')
}

export function runLimitCommands(limits: RunGuards) {
	return [
		...RUN_LIMIT_FIELDS.map((field) => ({
			name: `config limits ${field.name}`,
			label: field.label,
			description: formatRunLimit(field.key, limits[field.key]),
		})),
		{
			name: 'config limits unlimited',
			label: 'Remove all run caps',
			description: 'Unlimited tokens, model turns and duration. Usage is still measured.',
		},
	]
}
