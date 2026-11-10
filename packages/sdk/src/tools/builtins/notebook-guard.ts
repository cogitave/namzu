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
	if (typeof parsed.nbformat !== 'number') return 'it needs a numeric "nbformat"'
	if (!isRecord(parsed.metadata)) return 'it needs a "metadata" object'
	// Formats before 4 keep their cells inside "worksheets" and name a code cell's text "input".
	// Those files are valid and still open, so only the envelope is checked for them.
	if (parsed.nbformat < 4) {
		return Array.isArray(parsed.worksheets) ? undefined : 'it needs a "worksheets" list'
	}
	if (!Array.isArray(parsed.cells)) return 'it needs a "cells" list'
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

/** Why a notebook body would not open, or `undefined` when it would. */
function bodyProblem(content: string): string | undefined {
	let parsed: unknown
	try {
		parsed = JSON.parse(content)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return `it is not valid JSON (${reason})`
	}
	return shapeProblem(parsed)
}

/**
 * Returns a plain refusal for a notebook body that would no longer open, or
 * `undefined` when the body is fine or the path is not a notebook.
 *
 * `before` is the file's current body, when the caller has it. A notebook that
 * was already broken cannot be mended one string at a time, because every
 * partial repair still leaves a file that does not open; without saying so the
 * refusal would tell the model to keep a structure the file never had, and it
 * would try the same edit again.
 */
export function notebookRefusal(
	path: string,
	content: string,
	before?: string,
): string | undefined {
	if (!isNotebookPath(path)) return undefined
	const problem = bodyProblem(content)
	if (problem === undefined) return undefined
	if (before !== undefined && bodyProblem(before) !== undefined) {
		return `Not written: ${path} is a notebook that already does not open, and after this change it still would not because ${problem}. Repair it in one change that leaves a whole valid notebook, or replace the file with a write of the corrected notebook. The file is unchanged.`
	}
	return `Not written: ${path} is a notebook, and after this change it would no longer open because ${problem}. Change only text inside a cell and keep the notebook's structure (its cells, nbformat and metadata, with the surrounding quotes, commas and brackets), then try again. The file is unchanged.`
}
