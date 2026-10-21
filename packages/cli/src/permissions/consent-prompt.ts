import { createInterface } from 'node:readline/promises'

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
		output.write(`\n${BYPASS_CONSENT_TITLE}\n${BYPASS_CONSENT_BODY}\n\n`)
		const answer = await lines.question('Start in bypass mode? [y/N] ')
		return /^\s*y(?:es)?\s*$/i.test(answer)
	} catch {
		return false
	} finally {
		lines.close()
	}
}
