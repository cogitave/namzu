/** The spend report as plain text, for the terminal and for `namzu cost`. */

import { terminalDisplayText } from '../../tui/terminal-display.js'
import type { ModelSpend, SpendKindName, SpendReport, SpendTotals } from './report.js'

const KIND_LABEL: Record<SpendKindName, string> = {
	replies: 'Your replies',
	subagents: 'Sub-agents',
	compaction: 'Compaction',
	internal: 'Other internal calls',
}

function tokens(value: number): string {
	if (value < 1_000) return String(value)
	if (value < 1_000_000) return `${Number((value / 1_000).toFixed(1))}k`
	if (value < 1_000_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
	return `${Number((value / 1_000_000_000).toFixed(2))}B`
}

function dollars(value: number): string {
	return value < 0.01 && value > 0 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

/**
 * A conversation as a person can tell it apart: its folder's name and the END of its id.
 * The start of an id is its creation time, the same for conversations made in the same
 * minute; the end is the part that differs. The whole id is in the JSON.
 */
function conversationLabel(
	report: SpendReport,
	conversation: SpendReport['topConversations'][number],
) {
	const project = report.projects.find((row) => row.slug === conversation.slug)
	const folder = (project?.path ?? conversation.slug).split(/[\\/]/).filter(Boolean).at(-1)
	return `${folder ?? conversation.slug} ${conversation.id.slice(-8)}`
}

/** Unknown prices stay unknown: never a zero, and a floor when part is known. */
export function costCell(totals: SpendTotals, local = false): string {
	if (totals.unpricedTokens > 0) {
		return totals.estimatedCostUsd > 0
			? `at least ${dollars(totals.estimatedCostUsd)}`
			: 'price not known'
	}
	if (local) return 'not billed (local)'
	if (totals.tokens === 0) return '-'
	return dollars(totals.estimatedCostUsd)
}

function inputCell(totals: SpendTotals): string {
	const unsplit = totals.unsplitInputTokens
	return unsplit > 0
		? `${tokens(totals.freshInputTokens + unsplit)}*`
		: tokens(totals.freshInputTokens)
}

const COLUMNS = ['Tokens', 'Input', 'Cache read', 'Cache write', 'Output', 'Est. cost'] as const

function cells(totals: SpendTotals, local = false): string[] {
	return [
		tokens(totals.tokens),
		inputCell(totals),
		tokens(totals.cacheReadTokens),
		tokens(totals.cacheWriteTokens),
		tokens(totals.outputTokens),
		costCell(totals, local),
	]
}

function table(heading: string, rows: readonly { label: string; cells: string[] }[]): string[] {
	if (rows.length === 0) return []
	const labelWidth = Math.max(heading.length, ...rows.map((row) => row.label.length))
	const widths = COLUMNS.map((name, i) =>
		Math.max(name.length, ...rows.map((row) => (row.cells[i] as string).length)),
	)
	const line = (label: string, values: readonly string[]) =>
		`  ${label.padEnd(labelWidth)}  ${values
			.map((v, i) => (i === values.length - 1 ? v : v.padStart(widths[i] as number)))
			.join('  ')}`
	return ['', line(heading, COLUMNS), ...rows.map((row) => line(row.label, row.cells))]
}

function modelLabel(model: ModelSpend): string {
	const name = model.provider === null ? model.model : `${model.model} (${model.provider})`
	return terminalDisplayText(name)
}

export function renderSpend(report: SpendReport): string {
	const { window, totals } = report
	const lines: string[] = [
		`Spend over the last ${window.days} day${window.days === 1 ? '' : 's'} (${window.from} to ${window.to}, ${terminalDisplayText(window.timeZone)})`,
		'Money is an estimate from list prices, not a bill. A model with no known price shows its tokens and "price not known".',
	]
	if (report.days.length === 0) {
		lines.push('', 'No usage was recorded in this window.')
		return lines.join('\n')
	}
	lines.push(
		...table(
			'Day',
			report.days.map((day) => ({ label: day.date, cells: cells(day) })),
		),
		...table(
			'Model',
			report.models.map((model) => ({
				label: modelLabel(model),
				cells: cells(model, model.billing === 'local' && model.priceKnown),
			})),
		),
		...table(
			'Project',
			report.projects.map((project) => ({
				label: terminalDisplayText(project.path ?? project.slug),
				cells: cells(project),
			})),
		),
		...table(
			'Kind of work',
			report.kinds.map((kind) => ({ label: KIND_LABEL[kind.kind], cells: cells(kind) })),
		),
	)
	if (report.topConversations.length > 0) {
		lines.push(
			...table(
				'Largest conversations',
				report.topConversations.map((conversation) => ({
					label: `${conversationLabel(report, conversation)}${conversation.subagent === null ? '' : ' (sub-agent)'}`,
					cells: cells(conversation),
				})),
			),
		)
	}
	lines.push('')
	lines.push(
		`Total: ${tokens(totals.tokens)} tokens in ${totals.conversations} conversation${totals.conversations === 1 ? '' : 's'}, ${costCell(totals)}`,
	)
	if (totals.partial) {
		lines.push(
			`This total is partial: ${totals.unpricedTokens.toLocaleString('en-US')} tokens have no known price and are left out of the money. Missing a price: ${totals.unpricedModels.map(terminalDisplayText).join(', ')}.`,
		)
	}
	if (totals.unsplitInputTokens > 0) {
		lines.push('* includes input the record does not separate from cache reads.')
	}
	for (const note of report.notes) lines.push(`- ${note}`)
	return lines.join('\n')
}
