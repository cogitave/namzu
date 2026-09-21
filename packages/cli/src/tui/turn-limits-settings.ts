import { type TurnGuardKey, type TurnGuards, resolveTurnGuards } from '../config/run-limits.js'

export const TURN_LIMIT_FIELDS = [
	{
		name: 'tokens',
		key: 'tokenBudget',
		label: 'Token budget',
		hint: 'Whole tokens across the turn and its children; 0 or unlimited removes the cap.',
	},
	{
		name: 'iterations',
		key: 'maxIterations',
		label: 'Model turns',
		hint: 'Whole model calls per turn; 0 or unlimited removes the cap.',
	},
	{
		name: 'time',
		key: 'timeoutMs',
		label: 'Turn duration',
		hint: 'Duration such as 30m, 2h or 1500ms; a bare number is milliseconds. 0 or unlimited removes the cap.',
	},
] as const

export type TurnLimitsAction =
	| { kind: 'turn-limits-picker' }
	| { kind: 'turn-limit-editor'; key: TurnGuardKey }
	| { kind: 'turn-limits-set'; limits: Partial<TurnGuards> }
	| { kind: 'message'; role: 'system'; content: string; statusRows?: undefined }

export function turnLimitsAction(args: readonly string[]): TurnLimitsAction {
	if (args.length === 0) return { kind: 'turn-limits-picker' }
	if (args.length === 1 && args[0] === 'unlimited')
		return { kind: 'turn-limits-set', limits: resolveTurnGuards() }
	const field = TURN_LIMIT_FIELDS.find((field) => field.name === args[0])
	if (field && args.length === 1) return { kind: 'turn-limit-editor', key: field.key }
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
			resolveTurnGuards({ [field.key]: value })
			return { kind: 'turn-limits-set', limits: { [field.key]: value } }
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

export function formatTurnLimit(key: TurnGuardKey, value: number): string {
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

export function turnLimitCommands(limits: TurnGuards) {
	return [
		...TURN_LIMIT_FIELDS.map((field) => ({
			name: `config limits ${field.name}`,
			label: field.label,
			description: formatTurnLimit(field.key, limits[field.key]),
		})),
		{
			name: 'config limits unlimited',
			label: 'Remove all turn caps',
			description: 'Unlimited tokens, model turns and duration. Usage is still measured.',
		},
	]
}
