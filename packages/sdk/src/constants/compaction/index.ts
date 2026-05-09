// Tool-name buckets used by the compaction extractor to classify
// captured tool results. Lowercase to match the canonical builtin
// tool names (Anthropic Claude emits `tool_use.name` lowercase, see
// ses_008-tool-name-case-fix). `edit` is grouped with `write`
// because both mutate file content.
export const READ_TOOLS = new Set(['read'])

export const EDIT_TOOLS = new Set(['write', 'edit'])

export const SHELL_TOOLS = new Set(['bash'])

export const SEARCH_TOOLS = new Set(['glob', 'grep'])

export const SECTION_HEADERS = {
	task: '## Task',
	userRequirements: '## User Requirements',
	plan: '## Plan',
	environment: '## Environment',
	files: '## Files Touched',
	decisions: '## Key Decisions',
	assistantNotes: '## Assistant Notes',
	toolResults: '## Tool Results',
	failures: '## Errors & Failures',
	discoveries: '## Discoveries',
} as const
