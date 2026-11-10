/**
 * A notebook is JSON with a fixed shape. `edit` and `write` treat every file
 * as text, so a model can leave an `.ipynb` that no notebook program opens.
 * This check runs on the body about to be written, never on the file on disk,
 * so a refusal leaves the file untouched.
 */

const CELL_TYPES = new Set(['code', 'markdown', 'raw'])

export function isNotebookPath(path: string): boolean {
	return path.toLowerCase().endsWith('.ipynb')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function shapeProblem(parsed: unknown): string | undefined {
	if (!isRecord(parsed)) return 'the top level must be a JSON object'
	if (!Array.isArray(parsed.cells)) return 'it needs a "cells" list'
	if (typeof parsed.nbformat !== 'number') return 'it needs a numeric "nbformat"'
	if (!isRecord(parsed.metadata)) return 'it needs a "metadata" object'
	for (const [index, cell] of parsed.cells.entries()) {
		if (!isRecord(cell)) return `cell ${index} must be an object`
		if (typeof cell.cell_type !== 'string' || !CELL_TYPES.has(cell.cell_type)) {
			return `cell ${index} needs a "cell_type" of code, markdown or raw`
		}
		const source = cell.source
		const sourceOk =
			typeof source === 'string' ||
			(Array.isArray(source) && source.every((line) => typeof line === 'string'))
		if (!sourceOk) return `cell ${index} needs a "source" that is a string or a list of strings`
	}
	return undefined
}

/**
 * Returns a plain refusal for a notebook body that would no longer open, or
 * `undefined` when the body is fine or the path is not a notebook.
 */
export function notebookRefusal(path: string, content: string): string | undefined {
	if (!isNotebookPath(path)) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return `Not written: ${path} is a notebook, and after this change it would no longer open because it is not valid JSON (${reason}). Change only text inside a cell's "source" and keep the surrounding quotes, commas and brackets, then try again. The file is unchanged.`
	}
	const problem = shapeProblem(parsed)
	if (problem === undefined) return undefined
	return `Not written: ${path} is a notebook, and after this change it would no longer open because ${problem}. Keep the notebook structure (cells, nbformat, metadata) and change only cell contents, then try again. The file is unchanged.`
}
