/**
 * A yes/no question on the terminal, for confirmations that must come from
 * a person at a keyboard. Default no.
 */

import { createInterface } from 'node:readline'

export function askYesNo(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true })
		let answered = false
		rl.question(`${question} [y/N] `, (answer) => {
			answered = true
			rl.close()
			resolve(/^y(es)?$/i.test(answer.trim()))
		})
		rl.once('close', () => {
			if (!answered) resolve(false)
		})
	})
}
