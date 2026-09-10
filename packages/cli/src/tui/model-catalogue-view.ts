/** Presentation only: the model and expanded transcript keep the original receipt. */
export function modelCatalogueView(output: string): string | undefined {
	let value: unknown
	try {
		value = JSON.parse(output)
	} catch {
		return undefined
	}
	if (
		!record(value) ||
		!Array.isArray(value.models) ||
		!Number.isSafeInteger(value.omitted) ||
		(value.omitted as number) < 0
	)
		return undefined
	const models = value.models
	if (
		!models.every(
			(model) =>
				record(model) &&
				typeof model.provider === 'string' &&
				((typeof model.id === 'string' && typeof model.name === 'string') ||
					model.status === 'catalogue unavailable'),
		)
	)
		return undefined
	const rows: string[] = ['Available models']
	if (models.length === 0) rows.push('No matching models.')
	for (const model of models.slice(0, 5)) {
		if (model.status === 'catalogue unavailable') {
			rows.push(`${model.provider} · catalogue unavailable`)
			continue
		}
		rows.push(`${model.name} · ${model.provider}`)
		rows.push(`  ${model.id}`)
		const facts: string[] = []
		if (
			typeof model.contextWindow === 'number' &&
			Number.isSafeInteger(model.contextWindow) &&
			model.contextWindow > 0
		)
			facts.push(
				`Context ${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(model.contextWindow)}`,
			)
		const effort = model.reasoningEffortLevels ?? model.effortLevels
		if (Array.isArray(effort) && effort.every((item) => typeof item === 'string'))
			facts.push(effort.length ? `Effort ${effort.join(' · ')}` : 'Effort not supported')
		if (facts.length) rows.push(`  ${facts.join('  |  ')}`)
	}
	const omitted = (value.omitted as number) + Math.max(0, models.length - 5)
	if (omitted) rows.push(`+${omitted} more · narrow the search`)
	return rows.join('\n')
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}
