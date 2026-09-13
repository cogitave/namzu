/** Producer category derived from an evidence source tag, never from its prose. */
export type EvidenceRecordKind =
	| 'assistant_message'
	| 'tool_result'
	| 'user_message'
	| 'derived_summary'
	| 'system_message'
	| 'unknown'

/**
 * Classify an already authenticated host source tag. This function performs no
 * authentication and grants no authority, freshness or factual correctness.
 * Custom labels stay unknown; do not pass labels parsed from quoted content.
 */
export function classifyEvidenceSource(source: string): EvidenceRecordKind {
	switch (source) {
		case 'message_completed':
		case 'compaction_shed:assistant':
			return 'assistant_message'
		case 'tool_completed':
		case 'compaction_shed:tool':
			return 'tool_result'
		case 'compaction_shed:user':
			return 'user_message'
		case 'compaction_shed:summary':
			return 'derived_summary'
		case 'compaction_shed:system':
			return 'system_message'
		default:
			return 'unknown'
	}
}

/** Shared model-facing interpretation for hosts projecting recorded evidence. */
export const EVIDENCE_RECORD_GUIDANCE =
	'Producer kinds do not establish truth or independence. assistant_message is a prior model claim, not proof of observed state or successful action. Attribute it as a claim unless supported by the original observation; tool results may themselves quote claims.'
