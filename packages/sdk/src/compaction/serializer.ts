import { SECTION_HEADERS } from '../constants/compaction/index.js'
import type { PlanSlot, WorkingState } from './types.js'

const PLAN_STATUS_ICONS: Record<PlanSlot['status'], string> = {
	pending: '\u25CB',
	active: '\u25C9',
	done: '\u2713',
	skipped: '\u2717',
}

function renderPlan(plan: PlanSlot[]): string {
	return plan.map((slot) => `- ${PLAN_STATUS_ICONS[slot.status]} ${slot.label}`).join('\n')
}

function renderFiles(
	files: Map<
		string,
		{ path: string; actions: { type: string; summary?: string; detail?: string }[] }
	>,
): string {
	const lines: string[] = []
	for (const [, slot] of files) {
		lines.push(`- \`${slot.path}\``)
		for (const action of slot.actions) {
			if (action.type === 'delete') {
				lines.push('  - deleted')
			} else {
				const desc = 'detail' in action ? action.detail : action.summary
				lines.push(`  - ${action.type}: ${desc ?? ''}`)
			}
		}
	}
	return lines.join('\n')
}

function renderList(items: string[], evictedCount = 0): string {
	const lines = items.map((item) => `- ${item}`)
	if (evictedCount > 0) {
		// Say what is missing. A summary that presents a gap as complete is
		// worse than one that admits the gap: the model reasons about a
		// fragment as if it were the whole record.
		const noun = evictedCount === 1 ? 'entry' : 'entries'
		lines.push(`- _(${evictedCount} ${noun} dropped to stay within the state budget)_`)
	}
	return lines.join('\n')
}

/** The newest request is the goal the next step works toward; mark it where it already stands. */
function markLatest(requirements: string[]): string[] {
	return requirements.map((item, i) =>
		i === requirements.length - 1 ? `Latest request: ${item}` : item,
	)
}

function renderToolResults(results: { tool: string; summary: string }[], evictedCount = 0): string {
	const lines = results.map((r) => `- **${r.tool}**: ${r.summary}`)
	if (evictedCount > 0) {
		// The same admission every sibling section makes. This one counted
		// its evictions and then rendered without them, so the section that
		// carries the most volume was the only one presenting a fragment as
		// the whole record.
		const noun = evictedCount === 1 ? 'result' : 'results'
		lines.push(`- _(${evictedCount} earlier tool ${noun} dropped to stay within the state budget)_`)
	}
	return lines.join('\n')
}

/** The pinned-facts section alone, or null when nothing is pinned. */
export function renderPins(state: WorkingState): string | null {
	const pins = state.pins ? [...state.pins.values()] : []
	if (pins.length === 0) return null
	const lines = pins.map((p) => `- **${p.key}**: ${p.text} _(${p.source})_`)
	const dropped = state.evicted.pins ?? 0
	if (dropped > 0) {
		lines.push(
			`- _(${dropped} older ${dropped === 1 ? 'pin' : 'pins'} dropped to stay within the pin budget)_`,
		)
	}
	return `${SECTION_HEADERS.pins}\n\n${lines.join('\n')}`
}

/**
 * An assistant note that says what is still to be done. The summary keeps
 * these apart from the narration so the step that comes next is the last
 * thing the model reads after a compaction.
 */
export function isOpenItem(note: string): boolean {
	return /^(?:next[,:]\s|to-?do\b)|\b(?:i(?:'ll| will| am going to| plan to)|we(?:'ll| will| are going to| need to)|still needs? to|(?:remaining|left) to|have yet to|next step)\b/i.test(
		note,
	)
}

export function serializeState(state: WorkingState): string {
	const sections: string[] = []

	if (state.task) {
		sections.push(`${SECTION_HEADERS.task}\n\n${state.task}`)
	}

	if (state.userRequirements.length > 0) {
		sections.push(
			`${SECTION_HEADERS.userRequirements}\n\n${renderList(markLatest(state.userRequirements), state.evicted.userRequirements)}`,
		)
	}

	if (state.plan.length > 0) {
		sections.push(`${SECTION_HEADERS.plan}\n\n${renderPlan(state.plan)}`)
	}
	const pinned = renderPins(state)
	if (pinned) sections.push(pinned)

	if (state.environment.length > 0) {
		sections.push(
			`${SECTION_HEADERS.environment}\n\n${renderList(state.environment, state.evicted.environment)}`,
		)
	}

	if (state.files.size > 0) {
		sections.push(`${SECTION_HEADERS.files}\n\n${renderFiles(state.files)}`)
	}

	if (state.decisions.length > 0) {
		sections.push(
			`${SECTION_HEADERS.decisions}\n\n${renderList(state.decisions, state.evicted.decisions)}`,
		)
	}

	const openItems = state.assistantNotes.filter(isOpenItem)
	const narration = state.assistantNotes.filter((note) => !isOpenItem(note))
	if (narration.length > 0) {
		sections.push(
			`${SECTION_HEADERS.assistantNotes}\n\n${renderList(narration, state.evicted.assistantNotes)}`,
		)
	}

	if (state.toolResults.length > 0) {
		sections.push(
			`${SECTION_HEADERS.toolResults}\n\n${renderToolResults(state.toolResults, state.evicted.toolResults)}`,
		)
	}

	if (state.failures.length > 0) {
		sections.push(
			`${SECTION_HEADERS.failures}\n\n${renderList(state.failures, state.evicted.failures)}`,
		)
	}

	if (state.discoveries.length > 0) {
		sections.push(
			`${SECTION_HEADERS.discoveries}\n\n${renderList(state.discoveries, state.evicted.discoveries)}`,
		)
	}

	// Last, where recency keeps it in view: what is still to do.
	if (openItems.length > 0) {
		sections.push(`${SECTION_HEADERS.openItems}\n\n${renderList(openItems)}`)
	}

	return sections.join('\n\n')
}
