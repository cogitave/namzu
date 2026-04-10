export const READ_TOOLS = new Set(['read_file'])

export const EDIT_TOOLS = new Set(['write_file'])

export const SHELL_TOOLS = new Set(['bash'])

export const SEARCH_TOOLS = new Set(['glob', 'search_tools'])

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
