// Tool-name buckets used by the compaction extractor to classify
// captured tool results. Names mirror the canonical Claude Code tool
// table verbatim — see `code.claude.com/docs/en/tools-reference`.
// `Edit` is grouped with `Write` because both mutate file content.
export const READ_TOOLS = new Set(['Read'])

export const EDIT_TOOLS = new Set(['Write', 'Edit'])

export const SHELL_TOOLS = new Set(['Bash'])

export const SEARCH_TOOLS = new Set(['Glob', 'Grep'])

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
