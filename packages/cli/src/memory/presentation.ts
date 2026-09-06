import { type MemoryContent, memoryFilePath, projectMemoryFilePath, userFilePath } from './store.js'

export const MEMORY_PREVIEW_MAX_CHARS = 2_000
export const MEMORY_PREVIEW_MAX_LINES = 20

function preview(text: string, path: string): string {
	let end = Math.min(text.length, MEMORY_PREVIEW_MAX_CHARS)
	let position = 0
	for (let line = 0; line < MEMORY_PREVIEW_MAX_LINES; line += 1) {
		const newline = text.indexOf('\n', position)
		if (newline < 0 || newline >= end) break
		if (line === MEMORY_PREVIEW_MAX_LINES - 1) end = newline
		position = newline + 1
	}
	if (end === text.length) return text
	// Do not split a supplementary character at the preview boundary.
	const last = text.charCodeAt(end - 1)
	if (last >= 0xd800 && last <= 0xdbff) end -= 1
	return `${text.slice(0, end)}\n\n[${text.length - end} more characters omitted. Full text: ${path}]`
}

/** Human-facing memory inspection; model prompt instructions belong in composeMemoryPrompt. */
export function renderMemoryReport(
	content: MemoryContent,
	options: { readonly cwd: string; readonly home?: string },
): string {
	const sections: string[] = []
	const add = (label: string, text: string | null, path: string): void => {
		if (text) sections.push(`${label}\n${path}\n\n${preview(text, path)}`)
	}
	add('Project memory', content.project, projectMemoryFilePath(options.cwd))
	add('User memory (all projects)', content.memory, memoryFilePath(options.home))
	add('About you', content.user, userFilePath(options.home))
	return sections.length > 0
		? sections.join('\n\n')
		: 'No saved memory. Use /memory add <text> for this project, or /memory --user add <text> for all projects.'
}
