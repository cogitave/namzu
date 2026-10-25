import { createInterface } from 'node:readline/promises'

import { wrapChoiceText } from '../tui/terminal-choice-text.js'
import { BYPASS_CONSENT_BODY, BYPASS_CONSENT_TITLE } from './consent.js'

/**
 * Asks once, on the terminal, before the screen opens, whether bypass mode
 * may start. Only an explicit yes counts; an empty line, end of input and
 * anything else decline, so a script that happens to reach it never says yes
 * by accident.
 */
export async function askBypassConsent(
	io: {
		readonly input?: NodeJS.ReadableStream
		readonly output?: NodeJS.WritableStream
	} = {},
): Promise<boolean> {
	const input = io.input ?? process.stdin
	const output = io.output ?? process.stderr
	const lines = createInterface({ input, output })
	try {
		const columns = (output as { columns?: number }).columns
		const body = wrapChoiceText(BYPASS_CONSENT_BODY, Math.max(20, (columns ?? 80) - 1)).join('\n')
		output.write(`\n${BYPASS_CONSENT_TITLE}\n${body}\n\n`)
		// Input that ends before an answer never resolves `question`, so the
		// close is raced against it: no answer is a no.
		const closed = new Promise<string>((resolve) => lines.once('close', () => resolve('')))
		const answer = await Promise.race([lines.question('Start in bypass mode? [y/N] '), closed])
		return /^\s*y(?:es)?\s*$/i.test(answer)
	} catch {
		return false
	} finally {
		lines.close()
	}
}
