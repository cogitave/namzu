import { type PrReview, type RunCommand, lookupPr, runCommand } from '../tui/pr-status.js'

/** The pull request of the project's branch, as Desktop's footer shows it. */
export interface ProjectPrView {
	number: number
	url: string
	review: PrReview
}

/**
 * Reads the pull request through `gh`, exactly as the terminal's footer does (`lookupPr`). Anything the
 * footer would turn into a hint (`gh` missing or signed out) is silence here: Desktop shows a pull
 * request or nothing.
 */
export async function projectPr(
	cwd: string,
	run: RunCommand = runCommand,
): Promise<ProjectPrView | null> {
	const found = await lookupPr(run, cwd)
	if (found.state.kind !== 'pr') return null
	return { number: found.state.number, url: found.state.url, review: found.state.review }
}
