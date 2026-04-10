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

function renderList(items: string[]): string {
	return items.map((item) => `- ${item}`).join('\n')
}

function renderToolResults(results: { tool: string; summary: string }[]): string {
	return results.map((r) => `- **${r.tool}**: ${r.summary}`).join('\n')
}

export function serializeState(state: WorkingState): string {
	const sections: string[] = []

	if (state.task) {
		sections.push(`${SECTION_HEADERS.task}\n\n${state.task}`)
	}

	if (state.userRequirements.length > 0) {
		sections.push(`${SECTION_HEADERS.userRequirements}\n\n${renderList(state.userRequirements)}`)
	}

	if (state.plan.length > 0) {
		sections.push(`${SECTION_HEADERS.plan}\n\n${renderPlan(state.plan)}`)
	}

	if (state.environment.length > 0) {
		sections.push(`${SECTION_HEADERS.environment}\n\n${renderList(state.environment)}`)
	}

	if (state.files.size > 0) {
		sections.push(`${SECTION_HEADERS.files}\n\n${renderFiles(state.files)}`)
	}

	if (state.decisions.length > 0) {
		sections.push(`${SECTION_HEADERS.decisions}\n\n${renderList(state.decisions)}`)
	}

	if (state.assistantNotes.length > 0) {
		sections.push(`${SECTION_HEADERS.assistantNotes}\n\n${renderList(state.assistantNotes)}`)
	}

	if (state.toolResults.length > 0) {
		sections.push(`${SECTION_HEADERS.toolResults}\n\n${renderToolResults(state.toolResults)}`)
	}

	if (state.failures.length > 0) {
		sections.push(`${SECTION_HEADERS.failures}\n\n${renderList(state.failures)}`)
	}

	if (state.discoveries.length > 0) {
		sections.push(`${SECTION_HEADERS.discoveries}\n\n${renderList(state.discoveries)}`)
	}

	return sections.join('\n\n')
}
